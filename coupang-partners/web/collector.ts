import { BEST_CATEGORIES } from "../catalog.js";
import type { CoupangPartnersClient } from "../client.js";
import { evaluateAlerts } from "./alerts.js";
import { nameTokens } from "./insights.js";
import { notifyAlerts } from "./push.js";
import type { PriceHistoryStore } from "./price-history.js";
import type { UserLibrary } from "./user-library.js";

const GAP_MS = Number(process.env.PRICE_COLLECT_GAP_MS || 1200);
const PIN_BATCH = 40;

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
  libraries: UserLibrary[] = [],
): Promise<CollectResult> {
  const errors: string[] = [];
  let ok = 0;
  let fail = 0;
  let saved = 0;
  const touched = new Set<string>();

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

  if (libraries.length) {
    const restocks = await refreshPinned(client, history, libraries, touched, errors);
    for (const library of libraries) {
      const notes = evaluateAlerts(history, library, [...touched], restocks.get(library) || []);
      await notifyAlerts(library, notes);
    }
  }

  const at = Date.now();
  history.markCollected(at);
  return { ok, fail, saved, at, errors };
}

function searchQueries(name: string) {
  const tokens = nameTokens(name);
  const focused = tokens.slice(0, 4).join(" ");
  const short = tokens.slice(0, 2).join(" ");
  const plain = name.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const queries: string[] = [];
  for (const query of [focused, short, plain]) {
    const text = query.trim().slice(0, 30);
    if (text.length < 2 || queries.includes(text)) continue;
    queries.push(text);
    if (queries.length >= 2) break;
  }
  return queries;
}

let pinCursor = 0;

async function refreshPinned(
  client: CoupangPartnersClient,
  history: PriceHistoryStore,
  libraries: UserLibrary[],
  touched: Set<string>,
  errors: string[],
) {
  const owners = new Map<string, UserLibrary[]>();
  for (const library of libraries) {
    for (const id of library.watches) {
      const list = owners.get(id) ?? [];
      list.push(library);
      owners.set(id, list);
    }
  }
  const ids = [...owners.keys()];
  const pending: string[] = [];
  if (ids.length) {
    const start = pinCursor % ids.length;
    const ordered = [...ids.slice(start), ...ids.slice(0, start)];
    let consumed = 0;
    for (const id of ordered) {
      consumed += 1;
      if (!touched.has(id)) pending.push(id);
      if (pending.length >= PIN_BATCH) break;
    }
    pinCursor = (start + consumed) % ids.length;
  }
  const restocks = new Map<UserLibrary, string[]>();
  const markRestock = (library: UserLibrary, id: string) => {
    const list = restocks.get(library) ?? [];
    list.push(id);
    restocks.set(library, list);
  };
  for (const id of pending) {
    const known = history.getById(id);
    const named = (owners.get(id) || []).map((library) => library.pendingName(id)).find(Boolean) || "";
    const queries = searchQueries(known?.productName || named);
    if (!queries.length) continue;
    await sleep(GAP_MS);
    try {
      let hit: Awaited<ReturnType<CoupangPartnersClient["search"]>>[number] | null = null;
      for (const [index, keyword] of queries.entries()) {
        if (index > 0) await sleep(GAP_MS);
        const found = await client.search(keyword, 10);
        hit = found.find((product) => String(product.productId) === id) ?? null;
        if (hit) break;
      }
      if (!hit) {
        for (const library of owners.get(id) || []) library.addMiss(id);
        console.log(`[collect] pin ${id} 미발견`);
        continue;
      }
      history.record([hit]);
      touched.add(id);
      for (const library of owners.get(id) || []) {
        library.clearPending(id);
        const missed = library.clearMiss(id);
        if (missed >= 2) markRestock(library, id);
      }
      console.log(`[collect] pin ${id} 갱신`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`pin:${id}: ${message}`);
      console.error(`[collect] pin ${id} 실패: ${message}`);
    }
  }
  for (const id of touched) {
    for (const library of owners.get(id) || []) {
      const missed = library.clearMiss(id);
      if (missed >= 2) markRestock(library, id);
    }
  }
  return restocks;
}

export function startPriceCollector(
  client: CoupangPartnersClient,
  history: PriceHistoryStore,
  intervalMs: number,
  libraries: () => UserLibrary[] = () => [],
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
      const result = await collectPriceSnapshot(client, history, libraries());
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
