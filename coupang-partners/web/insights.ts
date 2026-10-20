import type { PricePoint, ProductView } from "./price-history.js";

const STOP = new Set([
  "로켓",
  "배송",
  "무료",
  "쿠팡",
  "공식",
  "정품",
  "특가",
  "할인",
  "세트",
  "포함",
  "증정",
  "선택",
  "구성",
]);

const VOLUME_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l)(?![a-z])/gi;
const COUNT_RE = /(\d+(?:\.\d+)?)\s*(개입|매|팩|롤|병|캔|포|입|개)/g;

type PackKind = "mass" | "volume" | "count";

interface Pack {
  unit: string;
  qty: number;
  kind: PackKind;
  baseQty: number;
}

export function nameTokens(name: string): string[] {
  const cleaned = name.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  const parts = cleaned.split(/[^\p{L}\p{N}]+/u);
  const tokens: string[] = [];
  for (const part of parts) {
    const token = part.toLowerCase();
    if (token.length < 2 || STOP.has(token) || /^\d+$/.test(token)) continue;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

export function unitPriceLabel(name: string, price: number | null): string | null {
  const pack = parsePack(name);
  if (!pack || price == null || price <= 0) return null;
  return perUnit(pack.unit, pack.qty, price);
}

export function unitBasis(name: string, price: number | null): { kind: PackKind; per: number } | null {
  const pack = parsePack(name);
  if (!pack || price == null || price <= 0 || pack.baseQty <= 0) return null;
  if (pack.kind === "count") return { kind: "count", per: Math.round(price / pack.baseQty) };
  return { kind: pack.kind, per: Math.round((price / pack.baseQty) * 100) };
}

export function staleHours(lastSeenAt: number | null, now = Date.now()): number | null {
  if (!lastSeenAt) return null;
  const hours = Math.floor((now - lastSeenAt) / 3_600_000);
  return hours >= 8 ? hours : null;
}

export function weekdayHint(points: PricePoint[]): string | null {
  if (points.length < 14) return null;
  const names = ["일", "월", "화", "수", "목", "금", "토"];
  const buckets: number[][] = [[], [], [], [], [], [], []];
  for (const point of points) {
    const day = new Date(`${point.date}T12:00:00+09:00`).getUTCDay();
    buckets[day]?.push(point.price);
  }
  const averages = buckets.map((prices) =>
    prices.length >= 2 ? prices.reduce((sum, price) => sum + price, 0) / prices.length : null,
  );
  const valid = averages.filter((price): price is number => price != null);
  if (valid.length < 4) return null;
  const lowest = Math.min(...valid);
  const highest = Math.max(...valid);
  if (highest - lowest < lowest * 0.03) return null;
  const lowDays = averages
    .map((price, index) => (price != null && price <= lowest * 1.02 ? names[index] : null))
    .filter((name): name is string => Boolean(name));
  if (!lowDays.length || lowDays.length > 3) return null;
  return `${lowDays.join("·")}요일에 자주 내려가는 편`;
}

export function cheaperAlternatives(current: ProductView, products: ProductView[], limit = 3): ProductView[] {
  if (!current.productName || current.productPrice == null) return [];
  const mine = nameTokens(current.productName);
  if (!mine.length) return [];
  const mineUnit = unitBasis(current.productName, current.productPrice);
  const scored: { product: ProductView; score: number; rank: number }[] = [];
  for (const product of products) {
    if (product.productId === current.productId || product.productPrice == null) continue;
    const other = nameTokens(product.productName || "");
    const shared = mine.filter((token) => other.includes(token));
    const strong = shared.some((token) => token.length >= 4);
    if (shared.length < 2 && !strong) continue;
    const otherUnit = unitBasis(product.productName || "", product.productPrice);
    const sameUnit = mineUnit && otherUnit && mineUnit.kind === otherUnit.kind;
    if (sameUnit) {
      if (otherUnit.per >= mineUnit.per) continue;
      scored.push({ product, score: shared.length, rank: otherUnit.per });
      continue;
    }
    if (product.productPrice >= current.productPrice) continue;
    scored.push({ product, score: shared.length, rank: product.productPrice });
  }
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return scored.slice(0, limit).map((row) => row.product);
}

function parsePack(name: string): Pack | null {
  if (!name) return null;
  const volumes = [...name.matchAll(new RegExp(VOLUME_RE.source, "gi"))]
    .map((match) => ({ qty: Number(match[1]), unit: match[2].toLowerCase() }))
    .filter((item) => item.qty > 0);
  const counts = [...name.matchAll(new RegExp(COUNT_RE.source, "g"))]
    .map((match) => ({ qty: Number(match[1]), unit: match[2] }))
    .filter((item) => item.qty > 0);
  const volume = volumes.at(-1);
  const count = counts.at(-1);
  if (volume) {
    const base = toBase(volume.unit, volume.qty);
    if (!base) return null;
    const times = count ? count.qty : 1;
    return {
      unit: volume.unit,
      qty: volume.qty * times,
      kind: base.kind,
      baseQty: base.qty * times,
    };
  }
  if (count) {
    return { unit: count.unit, qty: count.qty, kind: "count", baseQty: count.qty };
  }
  return null;
}

function toBase(unit: string, qty: number): { kind: "mass" | "volume"; qty: number } | null {
  if (unit === "kg") return { kind: "mass", qty: qty * 1000 };
  if (unit === "g") return { kind: "mass", qty };
  if (unit === "l") return { kind: "volume", qty: qty * 1000 };
  if (unit === "ml") return { kind: "volume", qty };
  return null;
}

function perUnit(unit: string, qty: number, price: number): string | null {
  if (unit === "kg") return `100g당 ${won(Math.round((price / (qty * 1000)) * 100))}`;
  if (unit === "g") {
    return qty >= 100 ? `100g당 ${won(Math.round((price / qty) * 100))}` : `1g당 ${won(Math.round(price / qty))}`;
  }
  if (unit === "l") return `100ml당 ${won(Math.round((price / (qty * 1000)) * 100))}`;
  if (unit === "ml") {
    return qty >= 100 ? `100ml당 ${won(Math.round((price / qty) * 100))}` : `1ml당 ${won(Math.round(price / qty))}`;
  }
  const label = unit === "개입" ? "개" : unit;
  return `1${label}당 ${won(Math.round(price / qty))}`;
}

function won(price: number) {
  return `${price.toLocaleString("ko-KR")}원`;
}
