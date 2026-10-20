import { annotateDeals, buyAdvice } from "./deals.js";
import type { PriceHistoryStore, ProductView } from "./price-history.js";
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
  const focus = new Set([...touchedIds, ...restockedIds]);
  const scored = new Map(
    annotateDeals(history.listAll(), {
      watched: new Set(library.watches),
      keywords: library.keywords,
    }).map((item) => [String(item.productId), item]),
  );
  for (const id of new Set([...focus, ...library.watches])) {
    const product: ProductView | undefined = scored.get(id) || history.getById(id) || undefined;
    if (!product || product.productPrice == null) continue;
    if (settings.rocketOnly && product.isRocket === false) continue;
    const name = product.productName || "상품";
    const price = product.productPrice;
    const watched = library.isWatched(id);
    const muted = watched && library.isSnoozed(id);
    const fresh = focus.has(id);
    const enough = product.dayCount >= 7;
    const belowUsual =
      enough &&
      ((product.averagePrice != null && price <= Math.round(product.averagePrice * 0.92)) ||
        product.is14DayLow ||
        product.isAllTimeLow);
    const push = (
      title: string,
      body: string,
      kind: Parameters<UserLibrary["pushAlert"]>[0]["kind"],
      dedupe?: string,
    ) => {
      const created = library.pushAlert({ kind, productId: id, title, body, dedupe });
      if (created) notes.push(note(title, body, id));
    };

    if (fresh && !muted && watched && settings.lowest && belowUsual) {
      push("지금이 살 타이밍", `${name} ${won(price)}. ${buyAdvice(product)}`, "lowest");
    }

    const target = library.target(id);
    if (fresh && !muted && watched && settings.target && target != null && price <= target) {
      push("목표 가격 이하", `${name} ${won(price)} · 목표 ${won(target)}. ${buyAdvice(product)}`, "target");
    }

    if (fresh && !muted && watched && settings.restock && restocked.has(id) && belowUsual) {
      push("다시 찾았고 가격도 좋습니다", `${name} ${won(price)}. ${buyAdvice(product)}`, "restock");
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
    if (fresh && reasons.length) push("가격 조건", `${name} ${won(price)} · ${reasons.join(", ")}`, "rule");

    const bought = library.purchase(id);
    const week = 7 * 86_400_000;
    if (fresh && watched && bought && Date.now() - bought.at <= week && price < bought.price) {
      push("산 가격보다 내려감", `${name} ${won(price)} · 산 가격 ${won(bought.price)}`, "afterbuy");
    }

    const cycle = library.rebuyDays(id);
    if (!muted && watched && cycle && bought && Date.now() - bought.at >= cycle * 86_400_000) {
      push(
        "다시 살 때입니다",
        `${name}을 산 지 ${cycle}일이 지났습니다. 지금 ${won(price)}. ${buyAdvice(product)}`,
        "rebuy",
        `rebuy:${id}:${bought.at}`,
      );
    }
  }
  return notes;
}
