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
  dayCount: number;
  isAllTimeLow: boolean;
  pricePoints: PricePoint[];
}

interface HistoryFile {
  version: 2;
  lastCollectAt: number | null;
  products: Record<string, TrackedProduct>;
}

const KEEP_DAYS = 60;

export function kstDate(ts = Date.now()): string {
  return new Date(ts + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function stats(daily: Record<string, number>) {
  const prices = Object.values(daily);
  if (!prices.length) {
    return { lowest: null as number | null, highest: null as number | null, dayCount: 0 };
  }
  return {
    lowest: Math.min(...prices),
    highest: Math.max(...prices),
    dayCount: prices.length,
  };
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
    for (const product of products) {
      const id = String(product.productId ?? "");
      if (!id || product.productPrice == null) continue;
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
  }

  view(products: CollectedProduct[]): ProductView[] {
    return products.map((product) => this.enrich(product));
  }

  getById(id: string) {
    const tracked = this.file.products[id];
    if (!tracked) return null;
    const { lowest, highest, dayCount } = stats(tracked.daily);
    const points = dailyPoints(tracked.daily);
    return {
      ...tracked,
      productPrice: tracked.lastPrice,
      originalPrice: null,
      keyword: null,
      pricePoints: points,
      lowestPrice: lowest,
      highestPrice: highest,
      dayCount,
      isAllTimeLow:
        dayCount >= 2 &&
        tracked.lastPrice != null &&
        lowest != null &&
        highest != null &&
        highest > lowest &&
        tracked.lastPrice <= lowest,
    };
  }

  listTracked(limit = 60): ProductView[] {
    const rows = Object.values(this.file.products)
      .map((tracked) =>
        this.enrich({
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
        }),
      )
      .sort((a, b) => {
        const dropA = dropRatio(a);
        const dropB = dropRatio(b);
        if (dropB !== dropA) return dropB - dropA;
        return (b.dayCount || 0) - (a.dayCount || 0);
      });
    return rows.slice(0, limit);
  }

  private enrich(product: CollectedProduct): ProductView {
    const id = String(product.productId ?? "");
    const tracked = id ? this.file.products[id] : undefined;
    const daily = tracked?.daily ?? {};
    const points = dailyPoints(daily);
    const { lowest, highest, dayCount } = stats(daily);
    const previous =
      points.length >= 2 ? points[points.length - 2].price : product.originalPrice;
    const current = product.productPrice ?? tracked?.lastPrice ?? null;
    return {
      ...product,
      previousPrice: previous ?? null,
      lowestPrice: lowest,
      highestPrice: highest,
      dayCount,
      isAllTimeLow:
        dayCount >= 2 &&
        current != null &&
        lowest != null &&
        highest != null &&
        highest > lowest &&
        current <= lowest,
      pricePoints: points,
    };
  }

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
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.file), "utf8");
  }
}

function dropRatio(product: ProductView) {
  if (product.highestPrice == null || product.productPrice == null || product.highestPrice <= 0) {
    return 0;
  }
  return (product.highestPrice - product.productPrice) / product.highestPrice;
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
