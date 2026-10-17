import { BEST_CATEGORIES } from "../catalog.js";
import type { CoupangPartnersClient } from "../client.js";
import { evaluateAlerts } from "./alerts.js";
import { notifyAlerts } from "./push.js";
import type { PriceHistoryStore } from "./price-history.js";
import type { UserLibrary } from "./user-library.js";

const GAP_MS = Number(process.env.PRICE_COLLECT_GAP_MS || 1200);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CollectResult {
  ok: number;
  fail: number;
  saved: number;
  at: number;
  errors: string[];
}

export async function collectPriceSnapshot(
  client: CoupangPartnersClient,
  history: PriceHistoryStore,
  library?: UserLibrary,
): Promise<CollectResult> {
  const errors: string[] = [];
  let ok = 0;
  let fail = 0;
  let saved = 0;
  const touched = new Set<string>();
  const restocked: string[] = [];

  const jobs: { name: string; run: () => Promise<unknown[]> }[] = [
    { name: "goldbox", run: () => client.goldbox() },
    ...BEST_CATEGORIES.map((cat) => ({
      name: `best:${cat.id}`,
      run: () => client.bestCategory(cat.id, 20),
    })),
  ];

  for (const [index, job] of jobs.entries()) {
    if (index > 0) await sleep(GAP_MS);
    try {
      const products = (await job.run()) as Parameters<PriceHistoryStore["record"]>[0];
      for (const id of history.record(products)) touched.add(id);
      saved += products.length;
      ok += 1;
      console.log(`[collect] ${job.name} ${products.length}건`);
    } catch (err) {
      fail += 1;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${job.name}: ${message}`);
      console.error(`[collect] ${job.name} 실패: ${message}`);
    }
  }

  if (library) {
    await refreshPinned(client, history, library, touched, restocked, errors);
    const notes = evaluateAlerts(history, library, [...touched], restocked);
    await notifyAlerts(library, notes);
  }

  const at = Date.now();
  history.markCollected(at);
  return { ok, fail, saved, at, errors };
}

function searchKeyword(name: string) {
  return name.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30);
}

async function refreshPinned(
  client: CoupangPartnersClient,
  history: PriceHistoryStore,
  library: UserLibrary,
  touched: Set<string>,
  restocked: string[],
  errors: string[],
) {
  const pending = library.watches.filter((id) => !touched.has(id)).slice(0, 15);
  for (const id of pending) {
    const known = history.getById(id);
    const keyword = searchKeyword(known?.productName || "");
    if (!keyword) continue;
    await sleep(GAP_MS);
    try {
      const found = await client.search(keyword, 10);
      const hit = found.find((product) => String(product.productId) === id);
      if (!hit) {
        library.addMiss(id);
        console.log(`[collect] pin ${id} 미발견`);
        continue;
      }
      history.record([hit]);
      touched.add(id);
      const missed = library.clearMiss(id);
      if (missed >= 2) restocked.push(id);
      console.log(`[collect] pin ${id} 갱신`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`pin:${id}: ${message}`);
      console.error(`[collect] pin ${id} 실패: ${message}`);
    }
  }
  for (const id of touched) {
    if (!library.isWatched(id)) continue;
    const missed = library.clearMiss(id);
    if (missed >= 2) restocked.push(id);
  }
}

export function startPriceCollector(
  client: CoupangPartnersClient,
  history: PriceHistoryStore,
  intervalMs: number,
  library?: UserLibrary,
) {
  let running = false;
  const run = async (reason: string) => {
    if (running) {
      console.log(`[collect] skip (${reason}): already running`);
      return;
    }
    running = true;
    console.log(`[collect] start (${reason})`);
    try {
      const result = await collectPriceSnapshot(client, history, library);
      console.log(
        `[collect] done ok=${result.ok} fail=${result.fail} products=${history.productCount}`,
      );
    } catch (err) {
      console.error("[collect] fatal", err);
    } finally {
      running = false;
    }
  };

  const last = history.lastCollectAt;
  const due = !last || Date.now() - last >= intervalMs;
  if (due) void run("startup");
  else {
    const remain = Math.ceil((intervalMs - (Date.now() - (last || 0))) / 60000);
    console.log(`[collect] next in ~${remain}분`);
  }

  const timer = setInterval(() => void run("interval"), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
