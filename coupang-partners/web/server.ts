import * as dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { fileURLToPath } from "url";
import { BEST_CATEGORIES } from "../catalog.js";
import { CoupangPartnersClient, type CollectedProduct } from "../client.js";
import { AccountBook } from "./accounts.js";
import { collectPriceSnapshot, startPriceCollector } from "./collector.js";
import { attachStores } from "./db.js";
import { annotateDeals, buyAdvice, type DealView } from "./deals.js";
import { startDigest, buildDigest } from "./digest.js";
import { cheaperAlternatives, staleHours, unitPriceLabel, weekdayHint } from "./insights.js";
import { kstDate, PriceHistoryStore } from "./price-history.js";
import { initPush } from "./push.js";
import { UserLibrary, type StoredPushSubscription } from "./user-library.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(rootDir, ".env") });

const PORT = Number(process.env.PARTNERS_WEB_PORT || 3780);
const STORE_NAME = (process.env.STORE_NAME || "셀러딜").trim() || "셀러딜";
const STORE_TAGLINE = (process.env.STORE_TAGLINE || "번호 또는 상품 이름으로 검색하세요").trim();
const STORE_HOSTS = new Set(
  (process.env.STORE_HOST || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
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
const rootLibrary = new UserLibrary(path.join(__dirname, "user-library.json"));
const accountBook = new AccountBook(rootLibrary);
const library: UserLibrary = new Proxy(rootLibrary, {
  get(target, prop) {
    const current = accountBook.context.getStore() ?? target;
    const value = Reflect.get(current, prop, current);
    return typeof value === "function" ? value.bind(current) : value;
  },
});
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
  dealMap = null;
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

function isStoreHost(req: http.IncomingMessage) {
  const host = String(req.headers.host || "").split(":")[0].trim().toLowerCase();
  return STORE_HOSTS.has(host);
}

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

let dealMap: Map<string, DealView> | null = null;
let dealAt = 0;

function dealIndex() {
  if (dealMap && Date.now() - dealAt < 3000) return dealMap;
  dealAt = Date.now();
  dealMap = new Map(
    annotateDeals(history.listAll(), {
      watched: new Set(library.watches),
      keywords: library.keywords,
    }).map((item) => [String(item.productId), item]),
  );
  return dealMap;
}

function decorate<T extends { productId?: string | number | null }>(products: T[]) {
  const deals = dealIndex();
  return products.map((product) => {
    const id = String(product.productId ?? "");
    const deal = deals.get(id);
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
      rebuyDays: library.rebuyDays(id),
      advice: buyAdvice(product as DealView),
      snoozeUntil: library.snoozeUntil(id),
      belowAvgPercent: rule.belowAvgPercent,
      dropAmount: rule.dropAmount,
      unitLabel: unitPriceLabel(row.productName || "", row.productPrice ?? null),
      missCount: library.missCount(id),
      familyKey: deal?.familyKey || "",
      familyName: deal?.familyName || row.productName || "",
      brand: deal?.brand || "",
      dealScore: deal?.dealScore ?? 0,
      reasons: deal?.reasons || [],
      unitRank: deal?.unitRank ?? null,
      familySize: deal?.familySize ?? 1,
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

function coupangProductId(text: string) {
  const match = text.match(/products\/(\d+)|productId=(\d+)/i);
  return match ? match[1] || match[2] || "" : "";
}

function cleanTitle(value: string) {
  const title = value.replace(/\s*[-|–]\s*쿠팡.*$/i, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (title.length < 2) return "";
  if (/access denied|just a moment|forbidden|captcha|로봇|로그인|오류|error/i.test(title)) return "";
  return title;
}

async function pageTitle(url: string) {
  if (!/^https:\/\/([a-z0-9-]+\.)*coupang\.com\//i.test(url)) return "";
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0" },
    });
    const html = (await res.text()).slice(0, 120_000);
    const og = html.match(/property="og:title"\s+content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
    return og ? cleanTitle(og[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'")) : "";
  } catch {
    return "";
  }
}

async function trackProduct(text: string, title: string) {
  const raw = text.trim();
  const id = coupangProductId(raw);
  const named = cleanTitle(title) || (/^https?:\/\//i.test(raw) ? "" : raw);
  if (id && history.getById(id)?.productName) {
    library.setWatch(id, true);
    library.clearPending(id);
    return { ok: true, productId: id, pending: false };
  }
  let query = named;
  if (!query && /^https?:\/\//i.test(raw)) query = await pageTitle(raw);
  if (query) {
    try {
      const found = await client.search(query.slice(0, 30), 10);
      const hit = id ? found.find((item) => String(item.productId) === id) : null;
      if (hit) {
        history.record([hit]);
        const productId = String(hit.productId);
        library.setWatch(productId, true);
        library.clearPending(productId);
        return { ok: true, productId, pending: false };
      }
    } catch (err) {
      console.error("[track]", err instanceof Error ? err.message : err);
    }
    if (id) {
      library.setPending(id, query, raw);
      return { ok: true, productId: id, pending: true, name: query };
    }
  }
  if (id) return { ok: false, needName: true, productId: id, url: /^https?:\/\//i.test(raw) ? raw : "" };
  return { ok: false, error: "쿠팡 링크나 상품명을 입력해 주세요." };
}

async function handleUser(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (url.pathname === "/api/account" && req.method === "GET") {
    const account = await accountBook.currentAccount();
    if (!account) {
      send(res, 401, { error: "계정이 없습니다." });
      return true;
    }
    send(res, 200, account);
    return true;
  }
  if (url.pathname === "/api/account" && req.method === "POST") {
    send(res, 200, await accountBook.openNew());
    return true;
  }
  if (url.pathname === "/api/account/restore" && req.method === "POST") {
    const body = await readJson(req);
    const account = await accountBook.restore(String(body.code || ""));
    if (!account) {
      send(res, 404, { error: "복구 코드를 찾지 못했습니다." });
      return true;
    }
    send(res, 200, account);
    return true;
  }
  if (url.pathname === "/api/track" && req.method === "POST") {
    const body = await readJson(req);
    send(res, 200, await trackProduct(String(body.text || ""), String(body.title || "")));
    return true;
  }
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
  if (url.pathname === "/api/storefront" && req.method === "GET") {
    send(res, 200, await storefrontPayload());
    return true;
  }
  if (url.pathname === "/api/storefront/proposal" && req.method === "POST") {
    try {
      saveProposal(await readJson(req));
      send(res, 200, { ok: true });
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : "제안을 저장하지 못했습니다." });
    }
    return true;
  }
  if (url.pathname === "/api/home" && req.method === "GET") {
    const gold = await cached("goldbox", GOLD_TTL, () => client.goldbox());
    dealMap = null;
    const feed = [...dealIndex().values()].sort((a, b) => b.dealScore - a.dealScore || (b.dropPercent ?? -999) - (a.dropPercent ?? -999)).slice(0, 48);
    send(res, 200, {
      feed: decorate(feed),
      families: new Set(feed.map((item) => item.familyKey).filter(Boolean)).size,
      cached: gold.cached,
      at: gold.at,
      source: "home",
      title: "지금 살 만한 순",
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
  if (url.pathname === "/api/library/rebuy") {
    const body = await readJson(req);
    const days = body.days == null || body.days === "" ? null : Number(body.days);
    library.setRebuy(String(body.productId || ""), days);
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

const CATALOG_PATH = path.join(__dirname, "storefront-catalog.json");
const PROPOSAL_PATH = path.join(__dirname, "business-proposals.json");
const PROPOSAL_TYPES = new Set(["광고", "공동구매", "협찬", "제품제공", "기타"]);
const PROPOSAL_CATEGORIES = new Set([
  "육아·키즈",
  "홈·리빙",
  "식품·요리",
  "뷰티",
  "패션",
  "디지털·가전",
  "가구·인테리어",
  "스포츠·건강",
  "여행·아웃도어",
  "교육·커리어",
  "취미·아트",
  "반려동물",
  "기타",
]);
const PROPOSAL_PAYS = new Set(["cash", "profit_share", "negotiation"]);

function clip(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function saveProposal(body: Record<string, unknown>) {
  if (clip(body.website, 80)) return;
  const type = clip(body.type, 20);
  const brand = clip(body.brand, 100);
  const product = clip(body.product, 100);
  const categories = Array.isArray(body.categories)
    ? [...new Set(body.categories.map((item) => clip(item, 20)).filter((item) => PROPOSAL_CATEGORIES.has(item)))].slice(0, 5)
    : [];
  const detail = clip(body.detail, 2000);
  const letter = clip(body.letter, 2000);
  const payType = clip(body.payType, 20);
  const payAmount = clip(body.payAmount, 20);
  const start = clip(body.start, 10);
  const end = clip(body.end, 10);
  const contactName = clip(body.contactName, 40);
  const email = clip(body.email, 80);
  const phone = clip(body.phone, 20);
  if (!PROPOSAL_TYPES.has(type)) throw new Error("캠페인 유형을 선택해 주세요.");
  if (!brand) throw new Error("브랜드명을 입력해 주세요.");
  if (!product) throw new Error("상품 또는 서비스명을 입력해 주세요.");
  if (!categories.length) throw new Error("제품 카테고리를 하나 이상 선택해 주세요.");
  if (!letter) throw new Error("제안서를 작성해 주세요.");
  if (!contactName) throw new Error("담당자 이름을 입력해 주세요.");
  if (!email && !phone) throw new Error("이메일 또는 전화번호를 입력해 주세요.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("이메일 형식을 확인해 주세요.");
  if (payType && !PROPOSAL_PAYS.has(payType)) throw new Error("보상 형태를 확인해 주세요.");
  const current = fs.existsSync(PROPOSAL_PATH)
    ? JSON.parse(fs.readFileSync(PROPOSAL_PATH, "utf8"))
    : [];
  const list = Array.isArray(current) ? current : [];
  list.unshift({
    id: `p-${Date.now().toString(36)}`,
    at: Date.now(),
    type,
    brand,
    product,
    categories,
    detail,
    letter,
    payType,
    payAmount: payType === "negotiation" ? "" : payAmount,
    start,
    end,
    contactName,
    email,
    phone,
  });
  fs.writeFileSync(PROPOSAL_PATH, JSON.stringify(list.slice(0, 300), null, 2));
}

async function storefrontPayload() {
  const catalog = readCatalog();
  if (catalog) {
    return {
      name: STORE_NAME,
      tagline: STORE_TAGLINE,
      shelves: catalog.shelves,
    };
  }
  let gold: CollectedProduct[] = [];
  try {
    gold = (await cached("goldbox", GOLD_TTL, () => client.goldbox())).products;
  } catch (error) {
    console.error("[storefront]", error instanceof Error ? error.message : error);
  }
  const all = history.listAll();
  const byId = new Map(all.map((product) => [String(product.productId), product]));
  const shelves = [
    storeShelf("timing", "지금 사기 좋은 타이밍", history.listTiming(40)),
    storeShelf("lowest", "최근 최저가", history.listLowest(40)),
    storeShelf("goldbox", "오늘의 골드박스", gold),
    ...rootLibrary.snapshot().folders.map((folder) =>
      storeShelf(
        folder.id,
        folder.name,
        folder.productIds.map((id) => byId.get(id)).filter((product) => product != null),
      ),
    ),
    ...categoryShelves(all),
  ].filter((shelf) => shelf != null);
  const profileName = STORE_NAME;
  return {
    name: profileName,
    tagline: STORE_TAGLINE,
    shelves,
  };
}

function readCatalog() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")) as {
      shelves?: { id: string; title: string; products: unknown[] }[];
    };
    if (!parsed.shelves?.length) return null;
    return parsed;
  } catch (error) {
    console.error("[storefront]", error instanceof Error ? error.message : error);
    return null;
  }
}

function categoryShelves(products: CollectedProduct[]) {
  const groups = new Map<string, CollectedProduct[]>();
  for (const product of products) {
    const name = (product.categoryName || "").trim();
    if (!name) continue;
    const list = groups.get(name) || [];
    list.push(product);
    groups.set(name, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([name, list]) => storeShelf(`cat:${name}`, name, list))
    .filter((shelf) => shelf != null);
}

function storeShelf<T extends { productId?: string | number | null; productName?: string | null; productPrice?: number | null; productImage?: string | null; productUrl?: string | null }>(
  id: string,
  title: string,
  products: T[],
) {
  const items = uniqueProducts(products).slice(0, 18).map((product) => ({
    productId: product.productId,
    productName: product.productName || "",
    productPrice: product.productPrice ?? null,
    productImage: product.productImage || "",
    productUrl: product.productUrl || "",
  }));
  if (!items.length) return null;
  return { id, title, products: items };
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
  const chosen = accountBook.choose(req);
  await accountBook.context.run(chosen, async () => {
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
      const result = await collectPriceSnapshot(client, history, accountBook.libraries());
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
      const deal = dealIndex().get(id);
      const current = deal || product;
      const family = deal?.familyKey
        ? [...dealIndex().values()]
            .filter((item) => item.familyKey === deal.familyKey && String(item.productId) !== id)
            .sort((a, b) => (a.unitRank ?? 99) - (b.unitRank ?? 99) || (a.productPrice ?? 0) - (b.productPrice ?? 0))
            .slice(0, 8)
        : [];
      send(res, 200, {
        ...decorate([current])[0],
        family: decorate(family),
        alternatives: decorate(cheaperAlternatives(current, history.listAll(), 3)),
      });
      return;
    }

    if (url.pathname === "/api/catalog") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const category = (url.searchParams.get("category") || "").trim();
      let rows = [...dealIndex().values()];
      if (q) {
        rows = rows.filter((product) => {
          const name = (product.productName || "").toLowerCase();
          return name.includes(q) || product.familyName.toLowerCase().includes(q) || product.brand.toLowerCase().includes(q);
        });
      }
      if (category) {
        rows = rows.filter((product) => (product.categoryName || "").includes(category));
      }
      rows.sort((a, b) => b.dealScore - a.dealScore || (a.productPrice ?? 0) - (b.productPrice ?? 0));
      send(res, 200, {
        products: decorate(rows.slice(0, 80)),
        cached: true,
        at: history.lastCollectAt || Date.now(),
        source: "catalog",
        title: q ? `'${q}' 상품 사전` : "상품 사전",
        query: q,
        total: rows.length,
        ...collectMeta(),
      });
      return;
    }

    if (url.pathname === "/api/units") {
      const rows = [...dealIndex().values()]
        .filter((product) => product.unitRank === 1 && product.familySize >= 2)
        .sort((a, b) => b.dealScore - a.dealScore || (a.productPrice ?? 0) - (b.productPrice ?? 0))
        .slice(0, 60);
      send(res, 200, {
        products: decorate(rows),
        cached: true,
        at: history.lastCollectAt || Date.now(),
        source: "units",
        title: "단위가격이 가장 싼 상품",
        ...collectMeta(),
      });
      return;
    }

    if (url.pathname === "/api/family") {
      const key = (url.searchParams.get("key") || "").trim();
      const rows = [...dealIndex().values()]
        .filter((product) => product.familyKey === key)
        .sort((a, b) => (a.unitRank ?? 99) - (b.unitRank ?? 99) || (a.productPrice ?? 0) - (b.productPrice ?? 0));
      send(res, 200, {
        products: decorate(rows),
        cached: true,
        at: history.lastCollectAt || Date.now(),
        source: "family",
        title: rows[0]?.familyName || "상품군",
        query: key,
        ...collectMeta(),
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

    if (isStoreHost(req) && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveStatic("/store.html", res);
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
});

attachStores(history, rootLibrary)
  .then(() => accountBook.open())
  .then(() => {
    server.listen(PORT, () => {
      console.log(`셀러딜  http://127.0.0.1:${PORT}`);
      if (STORE_HOSTS.size) console.log(`스토어 도메인  ${[...STORE_HOSTS].join(", ")}`);
      startPriceCollector(client, history, COLLECT_INTERVAL, () => accountBook.libraries());
      startDigest(history, () => accountBook.libraries());
    });
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
