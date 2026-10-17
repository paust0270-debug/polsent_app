import * as fs from "fs";
import * as path from "path";
import type { CollectedProduct } from "../client.js";

export interface PricePoint {
  date: string;
  price: number;
}

export interface TrackedProduct {
  productId: string;
  productName: string;
  productImage: string | null;
  productUrl: string | null;
  categoryName: string | null;
  isRocket: boolean | null;
  isFreeShipping: boolean | null;
  lastPrice: number;
  lastSeenAt: number;
  source: string;
  daily: Record<string, number>;
}

export interface ProductView extends CollectedProduct {
  previousPrice: number | null;
  lowestPrice: number | null;
  highestPrice: number | null;
  averagePrice: number | null;
  low14Price: number | null;
  dayCount: number;
  isAllTimeLow: boolean;
  is14DayLow: boolean;
  isTiming: boolean;
  dropPercent: number | null;
  lastSeenAt: number | null;
  lastPrice: number | null;
  pricePoints: PricePoint[];
}

export interface HistoryFile {
  version: 2;
  lastCollectAt: number | null;
  products: Record<string, TrackedProduct>;
}

const KEEP_DAYS = 60;

export function kstDate(ts = Date.now()): string {
  return new Date(ts + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

interface PriceStats {
  lowest: number | null;
  highest: number | null;
  average: number | null;
  low14: number | null;
  dayCount: number;
  isAllTimeLow: boolean;
  is14DayLow: boolean;
  isTiming: boolean;
  dropPercent: number | null;
}

function analyze(daily: Record<string, number>, current: number | null): PriceStats {
  const prices = Object.values(daily);
  if (!prices.length || current == null) {
    return {
      lowest: prices.length ? Math.min(...prices) : null,
      highest: prices.length ? Math.max(...prices) : null,
      average: null,
      low14: null,
      dayCount: prices.length,
      isAllTimeLow: false,
      is14DayLow: false,
      isTiming: false,
      dropPercent: null,
    };
  }
  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);
  const average = Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length);
  const recent = Object.keys(daily)
    .sort()
    .slice(-14)
    .map((day) => daily[day]);
  const low14 = recent.length ? Math.min(...recent) : null;
  const high14 = recent.length ? Math.max(...recent) : null;
  const dayCount = prices.length;
  const isAllTimeLow = dayCount >= 2 && highest > lowest && current <= lowest;
  const is14DayLow =
    recent.length >= 2 && high14 != null && low14 != null && high14 > low14 && current <= low14;
  const dropPercent = average > 0 ? Math.round(((average - current) / average) * 100) : null;
  const isTiming = dayCount >= 3 && (is14DayLow || (dropPercent != null && dropPercent >= 10));
  return { lowest, highest, average, low14, dayCount, isAllTimeLow, is14DayLow, isTiming, dropPercent };
}

function dailyPoints(daily: Record<string, number>): PricePoint[] {
  return Object.entries(daily)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, price]) => ({ date, price }));
}

function pruneDaily(daily: Record<string, number>): Record<string, number> {
  const keys = Object.keys(daily).sort();
  if (keys.length <= KEEP_DAYS) return daily;
  const keep = keys.slice(-KEEP_DAYS);
  const next: Record<string, number> = {};
  for (const key of keep) next[key] = daily[key];
  return next;
}

export class PriceHistoryStore {
  private file: HistoryFile = { version: 2, lastCollectAt: null, products: {} };

  constructor(private readonly filePath: string) {
    this.load();
  }

  get lastCollectAt() {
    return this.file.lastCollectAt;
  }

  get productCount() {
    return Object.keys(this.file.products).length;
  }

  markCollected(at = Date.now()) {
    this.file.lastCollectAt = at;
    this.save();
  }

  record(products: CollectedProduct[]) {
    const day = kstDate();
    const now = Date.now();
    const ids: string[] = [];
    for (const product of products) {
      const id = String(product.productId ?? "");
      if (!id || product.productPrice == null) continue;
      ids.push(id);
      const existing = this.file.products[id];
      const daily = { ...(existing?.daily ?? {}) };
      daily[day] =
        daily[day] == null ? product.productPrice : Math.min(daily[day], product.productPrice);
      this.file.products[id] = {
        productId: id,
        productName: product.productName || existing?.productName || "",
        productImage: product.productImage ?? existing?.productImage ?? null,
        productUrl: product.productUrl ?? existing?.productUrl ?? null,
        categoryName: product.categoryName ?? existing?.categoryName ?? null,
        isRocket: product.isRocket ?? existing?.isRocket ?? null,
        isFreeShipping: product.isFreeShipping ?? existing?.isFreeShipping ?? null,
        lastPrice: product.productPrice,
        lastSeenAt: now,
        source: product.source || existing?.source || "",
        daily: pruneDaily(daily),
      };
    }
    this.save();
    return ids;
  }

  view(products: CollectedProduct[]): ProductView[] {
    return products.map((product) => this.enrich(product));
  }

  getById(id: string) {
    const tracked = this.file.products[id];
    if (!tracked) return null;
    return this.enrich(this.toCollected(tracked));
  }

  listTracked(limit = 80): ProductView[] {
    return this.ranked().slice(0, limit);
  }

  listTiming(limit = 40): ProductView[] {
    return this.ranked()
      .filter((product) => product.isTiming)
      .slice(0, limit);
  }

  listLowest(limit = 40): ProductView[] {
    return this.ranked()
      .filter((product) => product.isAllTimeLow || product.is14DayLow)
      .slice(0, limit);
  }

  listAll(): ProductView[] {
    return Object.values(this.file.products).map((tracked) => this.enrich(this.toCollected(tracked)));
  }

  suggest(query: string, limit = 8): string[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const names: string[] = [];
    for (const product of Object.values(this.file.products)) {
      if (!product.productName.toLowerCase().includes(needle)) continue;
      if (names.includes(product.productName)) continue;
      names.push(product.productName);
      if (names.length >= limit) break;
    }
    return names;
  }

  private ranked(): ProductView[] {
    return Object.values(this.file.products)
      .map((tracked) => this.enrich(this.toCollected(tracked)))
      .sort((a, b) => {
        const dropA = a.dropPercent ?? -999;
        const dropB = b.dropPercent ?? -999;
        if (dropB !== dropA) return dropB - dropA;
        return (b.dayCount || 0) - (a.dayCount || 0);
      });
  }

  private toCollected(tracked: TrackedProduct): CollectedProduct {
    return {
      productId: tracked.productId,
      productName: tracked.productName,
      productPrice: tracked.lastPrice,
      originalPrice: null,
      productImage: tracked.productImage,
      productUrl: tracked.productUrl,
      isRocket: tracked.isRocket,
      isFreeShipping: tracked.isFreeShipping,
      categoryName: tracked.categoryName,
      keyword: null,
      source: tracked.source,
    };
  }

  private enrich(product: CollectedProduct): ProductView {
    const id = String(product.productId ?? "");
    const tracked = id ? this.file.products[id] : undefined;
    const daily = tracked?.daily ?? {};
    const points = dailyPoints(daily);
    const current = product.productPrice ?? tracked?.lastPrice ?? null;
    const stats = analyze(daily, current);
    const previous = points.length >= 2 ? points[points.length - 2].price : product.originalPrice;
    const listDrop =
      product.originalPrice && current != null && product.originalPrice > current
        ? Math.round(((product.originalPrice - current) / product.originalPrice) * 100)
        : null;
    const dropPercent =
      stats.dropPercent != null && listDrop != null
        ? Math.max(stats.dropPercent, listDrop)
        : (stats.dropPercent ?? listDrop);
    return {
      ...product,
      productPrice: current,
      previousPrice: previous ?? null,
      lowestPrice: stats.lowest,
      highestPrice: stats.highest,
      averagePrice: stats.average,
      low14Price: stats.low14,
      dayCount: stats.dayCount,
      isAllTimeLow: stats.isAllTimeLow,
      is14DayLow: stats.is14DayLow,
      isTiming: stats.isTiming || (listDrop != null && listDrop >= 15),
      dropPercent,
      lastSeenAt: tracked?.lastSeenAt ?? null,
      lastPrice: tracked?.lastPrice ?? current,
      pricePoints: points,
    };
  }

  exportState() {
    return this.file;
  }

  importState(raw: unknown) {
    this.file = migrate(raw);
  }

  useDatabase(save: () => void) {
    this.databaseSave = save;
  }

  private databaseSave: (() => void) | null = null;

  private load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.file = migrate(raw);
    } catch {
      this.file = { version: 2, lastCollectAt: null, products: {} };
    }
  }

  private save() {
    if (this.databaseSave) {
      this.databaseSave();
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.file), "utf8");
  }
}

function migrate(raw: unknown): HistoryFile {
  if (!raw || typeof raw !== "object") {
    return { version: 2, lastCollectAt: null, products: {} };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version === 2 && obj.products && typeof obj.products === "object") {
    return {
      version: 2,
      lastCollectAt: typeof obj.lastCollectAt === "number" ? obj.lastCollectAt : null,
      products: obj.products as Record<string, TrackedProduct>,
    };
  }

  const products: Record<string, TrackedProduct> = {};
  for (const [id, value] of Object.entries(obj)) {
    if (!Array.isArray(value)) continue;
    const daily: Record<string, number> = {};
    let lastPrice = 0;
    let lastSeenAt = 0;
    for (const point of value as { t?: number; p?: number }[]) {
      if (typeof point?.t !== "number" || typeof point?.p !== "number") continue;
      const day = kstDate(point.t);
      daily[day] = daily[day] == null ? point.p : Math.min(daily[day], point.p);
      lastPrice = point.p;
      lastSeenAt = point.t;
    }
    if (!Object.keys(daily).length) continue;
    products[id] = {
      productId: id,
      productName: "",
      productImage: null,
      productUrl: null,
      categoryName: null,
      isRocket: null,
      isFreeShipping: null,
      lastPrice,
      lastSeenAt,
      source: "",
      daily: pruneDaily(daily),
    };
  }
  return { version: 2, lastCollectAt: null, products };
}
