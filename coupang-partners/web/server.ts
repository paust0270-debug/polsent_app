import * as dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { fileURLToPath } from "url";
import { BEST_CATEGORIES } from "../catalog.js";
import { CoupangPartnersClient, type CollectedProduct } from "../client.js";
import { collectPriceSnapshot, startPriceCollector } from "./collector.js";
import { attachStores } from "./db.js";
import { startDigest, buildDigest } from "./digest.js";
import { cheaperAlternatives, staleHours, unitPriceLabel, weekdayHint } from "./insights.js";
import { kstDate, PriceHistoryStore } from "./price-history.js";
import { initPush } from "./push.js";
import { UserLibrary, type StoredPushSubscription } from "./user-library.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(rootDir, ".env") });

const PORT = Number(process.env.PARTNERS_WEB_PORT || 3780);
const PUBLIC_DIR = path.join(__dirname, "public");
const GOLD_TTL = 15 * 60 * 1000;
const SEARCH_TTL = 10 * 60 * 1000;
const BEST_TTL = 30 * 60 * 1000;
const COLLECT_INTERVAL = Number(process.env.PRICE_COLLECT_INTERVAL_MS || 3 * 60 * 60 * 1000);

const client = new CoupangPartnersClient({
  accessKey: process.env.COUPANG_PARTNERS_ACCESS_KEY || "",
  secretKey: process.env.COUPANG_PARTNERS_SECRET_KEY || "",
  subId: process.env.COUPANG_PARTNERS_SUB_ID || undefined,
});
const history = new PriceHistoryStore(path.join(__dirname, "price-history.json"));
const library = new UserLibrary(path.join(__dirname, "user-library.json"));
const pushPublicKey = initPush(path.join(__dirname, "vapid.json"));

type CacheEntry = { at: number; ttl: number; products: CollectedProduct[] };
const cache = new Map<string, CacheEntry>();

async function cached(
  key: string,
  ttl: number,
  loader: () => Promise<CollectedProduct[]>,
) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) {
    return { products: history.view(hit.products), cached: true, at: hit.at };
  }
  const products = await loader();
  history.record(products);
  cache.set(key, { at: Date.now(), ttl, products });
  return { products: history.view(products), cached: false, at: Date.now() };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  const headers = {
    "Content-Type": type,
    "Cache-Control": type.includes("json") ? "no-store" : "public, max-age=60",
  };
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, headers);
  res.end(payload);
}

function serveStatic(reqUrl: string, res: http.ServerResponse) {
  const urlPath = reqUrl === "/" ? "/index.html" : reqUrl.split("?")[0];
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, { error: "forbidden" });
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, fs.readFileSync(filePath), MIME[ext] || "application/octet-stream");
}

function collectMeta() {
  return {
    lastCollectAt: history.lastCollectAt,
    trackedCount: history.productCount,
    intervalMs: COLLECT_INTERVAL,
  };
}

function decorate<T extends { productId?: string | number | null }>(products: T[]) {
  return products.map((product) => {
    const id = String(product.productId ?? "");
    const row = product as T & {
      productName?: string | null;
      productPrice?: number | null;
      lastSeenAt?: number | null;
      pricePoints?: { date: string; price: number }[];
    };
    const purchase = library.purchase(id);
    const rule = library.rule(id);
    return {
      ...product,
      watched: library.isWatched(id),
      targetPrice: library.target(id),
      memo: library.memo(id),
      folderId: library.folderOf(id),
      purchasePrice: purchase?.price ?? null,
      purchasedAt: purchase?.at ?? null,
      snoozeUntil: library.snoozeUntil(id),
      belowAvgPercent: rule.belowAvgPercent,
      dropAmount: rule.dropAmount,
      unitLabel: unitPriceLabel(row.productName || "", row.productPrice ?? null),
      staleHours: staleHours(row.lastSeenAt ?? null),
      weekdayHint: weekdayHint(row.pricePoints || []),
    };
  });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(new Error("요청이 너무 큽니다."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(text) as unknown;
        resolve(value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
      } catch {
        reject(new Error("JSON 형식이 아닙니다."));
      }
    });
    req.on("error", reject);
  });
}

async function handleUser(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (url.pathname === "/api/library" && req.method === "GET") {
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/alerts" && req.method === "GET") {
    send(res, 200, { alerts: library.listAlerts() });
    return true;
  }
  if (url.pathname === "/api/suggest" && req.method === "GET") {
    send(res, 200, { names: history.suggest(url.searchParams.get("q") || "", 8) });
    return true;
  }
  if (url.pathname === "/api/push/key" && req.method === "GET") {
    send(res, 200, { publicKey: pushPublicKey });
    return true;
  }
  if (url.pathname === "/api/digest" && req.method === "GET") {
    send(res, 200, {
      text: buildDigest(history, library) || "관심 상품이 없습니다.",
      sentToday: library.digestDate() === kstDate(),
      hour: library.settings.digestHour,
    });
    return true;
  }
  if (url.pathname === "/api/lowest" && req.method === "GET") {
    send(res, 200, {
      products: decorate(history.listLowest(80)),
      cached: true,
      at: history.lastCollectAt || Date.now(),
      source: "lowest",
      title: "최저가",
      ...collectMeta(),
    });
    return true;
  }
  if (url.pathname === "/api/timing" && req.method === "GET") {
    send(res, 200, {
      products: decorate(history.listTiming(80)),
      cached: true,
      at: history.lastCollectAt || Date.now(),
      source: "timing",
      title: "사기 좋은 타이밍",
      ...collectMeta(),
    });
    return true;
  }
  if (url.pathname === "/api/home" && req.method === "GET") {
    const gold = await cached("goldbox", GOLD_TTL, () => client.goldbox());
    const timing = uniqueProducts([
      ...gold.products.filter((product) => product.isTiming),
      ...history.listTiming(12),
    ]).slice(0, 12);
    send(res, 200, {
      goldbox: decorate(gold.products),
      timing: decorate(timing),
      lowest: decorate(history.listLowest(12)),
      cached: gold.cached,
      at: gold.at,
      source: "home",
      title: "지금 사기 좋은 딜",
      ...collectMeta(),
    });
    return true;
  }
  if (req.method !== "POST") return false;

  if (url.pathname === "/api/library/profile") {
    const body = await readJson(req);
    library.setDisplayName(String(body.displayName || ""));
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/watch") {
    const body = await readJson(req);
    library.setWatch(String(body.productId || ""), Boolean(body.on));
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/import") {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : [];
    for (const id of ids.slice(0, 80)) library.setWatch(id, true);
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/folder") {
    const body = await readJson(req);
    const folder = library.addFolder(String(body.name || ""));
    if (!folder) {
      send(res, 400, { error: "폴더 이름을 확인해 주세요." });
      return true;
    }
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/folder/rename") {
    const body = await readJson(req);
    library.renameFolder(String(body.id || ""), String(body.name || ""));
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/folder/delete") {
    const body = await readJson(req);
    library.deleteFolder(String(body.id || ""));
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/assign") {
    const body = await readJson(req);
    const folderId = body.folderId == null || body.folderId === "" ? null : String(body.folderId);
    library.assign(String(body.productId || ""), folderId);
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/target") {
    const body = await readJson(req);
    const price = body.price == null || body.price === "" ? null : Number(body.price);
    library.setTarget(String(body.productId || ""), price);
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/memo") {
    const body = await readJson(req);
    library.setMemo(String(body.productId || ""), String(body.memo || ""));
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/keywords") {
    const body = await readJson(req);
    const keywords = Array.isArray(body.keywords) ? body.keywords.map((item) => String(item)) : [];
    library.setKeywords(keywords);
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/purchase") {
    const body = await readJson(req);
    const price = body.price == null || body.price === "" ? null : Number(body.price);
    library.setPurchase(String(body.productId || ""), price);
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/snooze") {
    const body = await readJson(req);
    const days = body.on === false || body.days === 0 ? 0 : Number(body.days ?? 7);
    library.setSnooze(String(body.productId || ""), days);
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/library/rule") {
    const body = await readJson(req);
    const below = body.belowAvgPercent == null || body.belowAvgPercent === "" ? null : Number(body.belowAvgPercent);
    const drop = body.dropAmount == null || body.dropAmount === "" ? null : Number(body.dropAmount);
    library.setRule(String(body.productId || ""), below, drop);
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/push/subscribe") {
    const body = await readJson(req);
    const subscription = asSubscription(body);
    if (!subscription) {
      send(res, 400, { error: "푸시 구독 형식이 아닙니다." });
      return true;
    }
    library.addSubscription(subscription);
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/push/unsubscribe") {
    const body = await readJson(req);
    library.removeSubscription(String(body.endpoint || ""));
    send(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/library/settings") {
    const body = await readJson(req);
    library.updateSettings({
      nightStart: numberOrUndefined(body.nightStart),
      nightEnd: numberOrUndefined(body.nightEnd),
      digestHour: numberOrUndefined(body.digestHour),
      rocketOnly: boolOrUndefined(body.rocketOnly),
      lowest: boolOrUndefined(body.lowest),
      target: boolOrUndefined(body.target),
      restore: boolOrUndefined(body.restore),
      restock: boolOrUndefined(body.restock),
      keyword: boolOrUndefined(body.keyword),
      digest: boolOrUndefined(body.digest),
    });
    send(res, 200, library.snapshot());
    return true;
  }
  if (url.pathname === "/api/alerts/read") {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : undefined;
    library.markAlertsRead(ids);
    send(res, 200, { alerts: library.listAlerts() });
    return true;
  }
  return false;
}

function numberOrUndefined(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function boolOrUndefined(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function asSubscription(body: Record<string, unknown>): StoredPushSubscription | null {
  const endpoint = String(body.endpoint || "");
  const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  const p256dh = String(keys?.p256dh || "");
  const auth = String(keys?.auth || "");
  if (!endpoint.startsWith("https://") || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function sharePage(product: {
  productName?: string | null;
  productPrice?: number | null;
  productImage?: string | null;
  productUrl?: string | null;
  low14Price?: number | null;
  unitLabel?: string | null;
}, productId: string, pageUrl: string) {
  const name = escapeHtml(product.productName || "상품");
  const price = product.productPrice != null ? `${product.productPrice.toLocaleString("ko-KR")}원` : "가격 확인 중";
  const low = product.low14Price != null ? `14일 최저 ${product.low14Price.toLocaleString("ko-KR")}원` : "";
  const unit = product.unitLabel ? escapeHtml(product.unitLabel) : "";
  const image = escapeHtml(product.productImage || "");
  const coupang = escapeHtml(product.productUrl || "https://www.coupang.com");
  const description = escapeHtml([price, low, unit].filter(Boolean).join(" · "));
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${name} · 셀러딜</title>
  <meta property="og:title" content="${name}" />
  <meta property="og:description" content="${description}" />
  ${image ? `<meta property="og:image" content="${image}" />` : ""}
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
  <style>
    body { font-family: Pretendard, sans-serif; margin: 0; background: #f4f7f5; color: #14201b; }
    main { max-width: 520px; margin: 32px auto; background: #fff; border-radius: 20px; padding: 20px; }
    img { width: 100%; border-radius: 16px; background: #eef3f0; }
    h1 { font-size: 22px; line-height: 1.4; }
    p { color: #66746d; }
    .price { font-size: 28px; font-weight: 800; color: #14201b; }
    a { display: block; margin-top: 10px; background: #0f9f6e; color: #fff; text-align: center; text-decoration: none; border-radius: 12px; padding: 12px; font-weight: 700; }
    a.ghost { background: #eef3f0; color: #14201b; }
  </style>
</head>
<body>
  <main>
    ${image ? `<img src="${image}" alt="" />` : ""}
    <h1>${name}</h1>
    <div class="price">${escapeHtml(price)}</div>
    <p>${description}</p>
    <a href="${coupang}">쿠팡에서 보기</a>
    <a class="ghost" href="/?product=${encodeURIComponent(productId)}">셀러딜에서 가격 보기</a>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function uniqueProducts<T extends { productId?: string | number | null }>(products: T[]) {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const product of products) {
    const id = String(product.productId ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push(product);
  }
  return rows;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  try {
    if (url.pathname === "/api/categories") {
      send(res, 200, { categories: BEST_CATEGORIES });
      return;
    }

    if (url.pathname === "/api/status") {
      send(res, 200, collectMeta());
      return;
    }

    if (await handleUser(req, res, url)) return;

    if (url.pathname === "/api/collect" && req.method === "POST") {
      const result = await collectPriceSnapshot(client, history, library);
      send(res, 200, { ...result, ...collectMeta() });
      return;
    }

    if (url.pathname === "/api/tracked") {
      send(res, 200, {
        products: decorate(history.listTracked(80)),
        cached: true,
        at: history.lastCollectAt || Date.now(),
        source: "tracked",
        title: "가격 추적",
        ...collectMeta(),
      });
      return;
    }

    if (url.pathname === "/api/products") {
      const ids = (url.searchParams.get("ids") || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 80);
      const products = ids.map((id) => history.getById(id)).filter((product) => product != null);
      send(res, 200, {
        products: decorate(products),
        cached: true,
        at: history.lastCollectAt || Date.now(),
        source: "watch",
        title: "관심상품",
        ...collectMeta(),
      });
      return;
    }

    if (url.pathname.startsWith("/api/product/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/product/", "").trim());
      const product = history.getById(id);
      if (!product) {
        send(res, 404, { error: "추적 중인 상품이 아닙니다." });
        return;
      }
      send(res, 200, {
        ...decorate([product])[0],
        alternatives: decorate(cheaperAlternatives(product, history.listAll(), 3)),
      });
      return;
    }

    if (url.pathname === "/api/goldbox") {
      const result = await cached("goldbox", GOLD_TTL, () => client.goldbox());
      send(res, 200, { ...result, products: decorate(result.products), source: "goldbox", title: "오늘의 골드박스", ...collectMeta() });
      return;
    }

    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) {
        send(res, 400, { error: "검색어를 입력해 주세요." });
        return;
      }
      const result = await cached(`search:${q}`, SEARCH_TTL, () => client.search(q, 10));
      send(res, 200, { ...result, products: decorate(result.products), source: "search", title: `'${q}' 검색 결과`, query: q, ...collectMeta() });
      return;
    }

    if (url.pathname.startsWith("/api/best/")) {
      const id = url.pathname.replace("/api/best/", "").trim();
      const meta = BEST_CATEGORIES.find((c) => c.id === id);
      if (!meta) {
        send(res, 404, { error: "알 수 없는 카테고리입니다." });
        return;
      }
      const result = await cached(`best:${id}`, BEST_TTL, () => client.bestCategory(id, 20));
      send(res, 200, { ...result, products: decorate(result.products), source: "best", title: `${meta.name} 인기상품`, categoryId: id, ...collectMeta() });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      send(res, 404, { error: "없는 API입니다." });
      return;
    }

    if (url.pathname.startsWith("/share/")) {
      const id = decodeURIComponent(url.pathname.slice("/share/".length).split("/")[0] || "");
      const product = history.getById(id);
      if (!product) {
        send(res, 404, "상품을 찾지 못했습니다.", "text/plain; charset=utf-8");
        return;
      }
      const host = req.headers.host || `127.0.0.1:${PORT}`;
      const pageUrl = `http://${host}/share/${encodeURIComponent(id)}`;
      send(res, 200, sharePage(decorate([product])[0], id, pageUrl), "text/html; charset=utf-8");
      return;
    }

    serveStatic(url.pathname, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, 502, { error: message });
  }
});

attachStores(history, library)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`셀러딜  http://127.0.0.1:${PORT}`);
      startPriceCollector(client, history, COLLECT_INTERVAL, library);
      startDigest(history, library);
    });
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
