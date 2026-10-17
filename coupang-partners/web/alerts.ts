import type { PriceHistoryStore } from "./price-history.js";
import type { UserLibrary } from "./user-library.js";

export interface AlertNote {
  title: string;
  body: string;
  url: string;
}

function won(price: number) {
  return `${price.toLocaleString("ko-KR")}원`;
}

function note(title: string, body: string, productId: string): AlertNote {
  const url = productId ? `/?product=${encodeURIComponent(productId)}` : "/";
  return { title, body, url };
}

export function evaluateAlerts(
  history: PriceHistoryStore,
  library: UserLibrary,
  touchedIds: string[],
  restockedIds: string[],
): AlertNote[] {
  const settings = library.settings;
  const restocked = new Set(restockedIds);
  const notes: AlertNote[] = [];
  for (const id of new Set([...touchedIds, ...restockedIds])) {
    const product = history.getById(id);
    if (!product || product.productPrice == null) continue;
    if (settings.rocketOnly && product.isRocket === false) continue;
    const name = product.productName || "상품";
    const price = product.productPrice;
    const watched = library.isWatched(id);
    const muted = watched && library.isSnoozed(id);
    const push = (title: string, body: string, kind: Parameters<UserLibrary["pushAlert"]>[0]["kind"]) => {
      const created = library.pushAlert({ kind, productId: id, title, body });
      if (created) notes.push(note(title, body, id));
    };

    if (!muted && watched && settings.lowest && product.isAllTimeLow) {
      push("역대 최저가", `${name} ${won(price)}`, "lowest");
    }

    const target = library.target(id);
    if (!muted && watched && settings.target && target != null && price <= target) {
      push("목표 가격 이하", `${name} ${won(price)} · 목표 ${won(target)}`, "target");
    }

    if (
      !muted &&
      watched &&
      settings.restore &&
      product.previousPrice != null &&
      price >= Math.round(product.previousPrice * 1.05)
    ) {
      push("가격이 다시 올랐어요", `${name} ${won(product.previousPrice)} → ${won(price)}`, "restore");
    }

    if (!muted && watched && settings.restock && restocked.has(id)) {
      push("다시 찾았어요", `${name}이 검색에 다시 나왔습니다. ${won(price)}`, "restock");
    }

    if (!muted && settings.keyword && (product.isTiming || product.isAllTimeLow || product.is14DayLow)) {
      const matched = library.keywords.find((keyword) => name.toLowerCase().includes(keyword.toLowerCase()));
      if (matched) push(`키워드 · ${matched}`, `${name} ${won(price)}`, "keyword");
    }

    const rule = library.rule(id);
    const reasons: string[] = [];
    if (
      !muted &&
      watched &&
      rule.belowAvgPercent != null &&
      product.averagePrice != null &&
      product.dayCount >= 2 &&
      price <= Math.round(product.averagePrice * (1 - rule.belowAvgPercent / 100))
    ) {
      reasons.push(`평균 ${won(product.averagePrice)}보다 ${rule.belowAvgPercent}% 이상 쌈`);
    }
    if (
      !muted &&
      watched &&
      rule.dropAmount != null &&
      product.previousPrice != null &&
      product.previousPrice - price >= rule.dropAmount
    ) {
      reasons.push(`이전보다 ${won(rule.dropAmount)} 이상 내림`);
    }
    if (reasons.length) push("가격 조건", `${name} ${won(price)} · ${reasons.join(", ")}`, "rule");

    const bought = library.purchase(id);
    const week = 7 * 86_400_000;
    if (watched && bought && Date.now() - bought.at <= week && price < bought.price) {
      push("산 가격보다 내려감", `${name} ${won(price)} · 산 가격 ${won(bought.price)}`, "afterbuy");
    }
  }
  return notes;
}
