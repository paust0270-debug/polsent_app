import { BEST_CATEGORIES } from "../catalog.js";
import type { CoupangPartnersClient } from "../client.js";
import type { PriceHistoryStore } from "./price-history.js";

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
): Promise<CollectResult> {
  const errors: string[] = [];
  let ok = 0;
  let fail = 0;
  let saved = 0;

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
      history.record(products);
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

  const at = Date.now();
  history.markCollected(at);
  return { ok, fail, saved, at, errors };
}

export function startPriceCollector(
  client: CoupangPartnersClient,
  history: PriceHistoryStore,
  intervalMs: number,
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
      const result = await collectPriceSnapshot(client, history);
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
