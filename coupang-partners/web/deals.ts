import { nameTokens, staleHours, unitBasis } from "./insights.js";
import type { ProductView } from "./price-history.js";

function won(price: number) {
  return `${price.toLocaleString("ko-KR")}원`;
}

export function buyAdvice(product: ProductView): string {
  const price = product.productPrice;
  const seen = seenText(product.lastSeenAt);
  if (price == null) return `가격을 아직 확인하지 못했습니다. ${seen}`;
  const days = product.dayCount || 0;
  if (days < 2) return `가격을 막 보기 시작했습니다. 싼지 아직 말하지 않습니다. ${seen}`;
  if (days < 7) {
    const dipped =
      product.previousPrice != null && product.previousPrice > price
        ? `이전보다 ${won(product.previousPrice - price)} 낮습니다. `
        : "";
    return `${dipped}기록은 ${days}일뿐입니다. 최저가라고 보기엔 짧습니다. ${seen}`;
  }
  const parts: string[] = [];
  if (product.isAllTimeLow) parts.push(`지금까지 본 ${days}일 중 가장 쌉니다`);
  else if (product.is14DayLow) parts.push("최근 2주 중 가장 쌉니다");
  if (product.averagePrice != null && price < product.averagePrice) {
    parts.push(`평소보다 ${won(product.averagePrice - price)} 낮습니다`);
  } else if (product.averagePrice != null && price > Math.round(product.averagePrice * 1.03)) {
    parts.push("평소보다 비쌉니다. 기다려도 됩니다");
  }
  if (!parts.length) parts.push("평소와 비슷한 가격입니다");
  return `${parts.join(". ")}. ${seen}`;
}

function seenText(lastSeenAt: number | null) {
  if (!lastSeenAt) return "확인 시각이 없습니다.";
  const hours = Math.max(0, Math.floor((Date.now() - lastSeenAt) / 3_600_000));
  if (hours < 1) return "가격은 방금 확인했습니다.";
  if (hours < 48) return `가격은 ${hours}시간 전 확인입니다.`;
  return `가격은 ${Math.floor(hours / 24)}일 전 확인입니다.`;
}

const VOLUME_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l)(?![a-z])/gi;
const COUNT_RE = /(\d+(?:\.\d+)?)\s*(개입|매|팩|롤|병|캔|포|입|개)/g;

export interface DealFields {
  familyKey: string;
  familyName: string;
  brand: string;
  dealScore: number;
  reasons: string[];
  unitRank: number | null;
  familySize: number;
}

export interface DealView extends ProductView, DealFields {}

export interface DealContext {
  watched: Set<string>;
  keywords: string[];
}

export function familyKey(name: string): string {
  const stripped = name
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(new RegExp(VOLUME_RE.source, "gi"), " ")
    .replace(new RegExp(COUNT_RE.source, "g"), " ");
  const tokens = nameTokens(stripped).slice(0, 5);
  if (tokens.length < 2) return "";
  return tokens.join(" ");
}

export function annotateDeals(products: ProductView[], context: DealContext): DealView[] {
  const groups = new Map<string, ProductView[]>();
  for (const product of products) {
    const key = familyKey(product.productName || "");
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(product);
    groups.set(key, list);
  }

  const unitRank = new Map<string, number>();
  const familySize = new Map<string, number>();
  for (const [key, members] of groups) {
    familySize.set(key, members.length);
    const byKind = new Map<string, { id: string; per: number }[]>();
    for (const product of members) {
      const basis = unitBasis(product.productName || "", product.productPrice);
      if (!basis) continue;
      const list = byKind.get(basis.kind) ?? [];
      list.push({ id: String(product.productId), per: basis.per });
      byKind.set(basis.kind, list);
    }
    for (const list of byKind.values()) {
      list.sort((a, b) => a.per - b.per || a.id.localeCompare(b.id));
      list.forEach((item, index) => unitRank.set(item.id, index + 1));
    }
  }

  return products.map((product) => {
    const id = String(product.productId ?? "");
    const key = familyKey(product.productName || "");
    const size = key ? familySize.get(key) ?? 1 : 1;
    const rank = unitRank.get(id) ?? null;
    const name = product.productName || "";
    const keyword = context.keywords.find((item) => item && name.toLowerCase().includes(item.toLowerCase())) || "";
    const reasons: string[] = [];
    if (product.dropPercent != null && product.dropPercent >= 8 && product.dayCount >= 2) {
      reasons.push(`평균보다 ${product.dropPercent}% 쌈`);
    }
    if (
      product.previousPrice != null &&
      product.productPrice != null &&
      product.previousPrice > product.productPrice
    ) {
      const gap = Math.round((1 - product.productPrice / product.previousPrice) * 100);
      if (gap >= 5) reasons.push(`이전보다 ${gap}% 내림`);
    }
    if (rank === 1 && size >= 2) reasons.push("같은 상품군에서 단위가격이 가장 쌈");
    if (product.isAllTimeLow) reasons.push("역대 최저");
    if (product.is14DayLow && !product.isAllTimeLow) reasons.push("14일 최저");
    if (keyword) reasons.push(`키워드 ${keyword}`);

    let score = 0;
    if (product.dropPercent != null && product.dropPercent > 0 && product.dayCount >= 2) {
      score += Math.min(40, product.dropPercent * 2);
    }
    if (
      product.previousPrice != null &&
      product.productPrice != null &&
      product.previousPrice > product.productPrice
    ) {
      const gap = Math.round((1 - product.productPrice / product.previousPrice) * 100);
      if (gap >= 5) score += Math.min(20, gap);
    }
    if (rank === 1 && size >= 2) score += 25;
    else if (rank === 2 && size >= 2) score += 12;
    if (context.watched.has(id)) score += 12;
    if (keyword) score += 10;
    if (product.isRocket) score += 5;
    if (!staleHours(product.lastSeenAt)) score += 8;
    if (product.isAllTimeLow) score += 15;
    if (product.is14DayLow) score += 10;

    return {
      ...product,
      familyKey: key,
      familyName: key || name,
      brand: key.split(" ")[0] || "",
      dealScore: Math.min(100, Math.round(score)),
      reasons,
      unitRank: rank,
      familySize: size,
    };
  });
}
