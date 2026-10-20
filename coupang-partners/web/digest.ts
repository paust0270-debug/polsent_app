import type { AlertNote } from "./alerts.js";
import { notifyAlerts } from "./push.js";
import { kstDate, type PriceHistoryStore } from "./price-history.js";
import type { UserLibrary } from "./user-library.js";

export function buildDigest(history: PriceHistoryStore, library: UserLibrary): string | null {
  const ids = library.watches;
  if (!ids.length) return null;
  let timing = 0;
  let targets = 0;
  let cheaper = 0;
  for (const id of ids) {
    const product = history.getById(id);
    if (!product || product.productPrice == null) continue;
    if (product.isTiming) timing += 1;
    const target = library.target(id);
    if (target != null && product.productPrice <= target) targets += 1;
    const bought = library.purchase(id);
    if (bought && product.productPrice < bought.price) cheaper += 1;
  }
  if (!timing && !targets && !cheaper) {
    return `관심 ${ids.length}개. 오늘은 타이밍·목표가·구매가 이하가 없습니다.`;
  }
  return `관심 ${ids.length}개 중 타이밍 ${timing}, 목표가 ${targets}, 산 가격보다 낮은 상품 ${cheaper}`;
}

export function startDigest(history: PriceHistoryStore, libraries: () => UserLibrary[]) {
  const tickOne = (library: UserLibrary) => {
    const settings = library.settings;
    if (!settings.digest) return;
    const day = kstDate();
    const hour = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
    if (hour < settings.digestHour) return;
    if (library.digestDate() === day) return;
    const body = buildDigest(history, library);
    if (!body) return;
    library.markDigest(day);
    const note: AlertNote = { title: "오늘 관심 상품", body, url: "/" };
    const created = library.pushAlert({
      kind: "digest",
      productId: "digest",
      title: note.title,
      body: note.body,
    });
    if (created) void notifyAlerts(library, [note], true);
  };
  const tick = () => {
    for (const library of libraries()) tickOne(library);
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
