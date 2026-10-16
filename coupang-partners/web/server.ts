import * as dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { fileURLToPath } from "url";
import { BEST_CATEGORIES } from "../catalog.js";
import { CoupangPartnersClient, type CollectedProduct } from "../client.js";
import { collectPriceSnapshot, startPriceCollector } from "./collector.js";
import { PriceHistoryStore } from "./price-history.js";

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

    if (url.pathname === "/api/collect" && req.method === "POST") {
      const result = await collectPriceSnapshot(client, history);
      send(res, 200, { ...result, ...collectMeta() });
      return;
    }

    if (url.pathname === "/api/tracked") {
      send(res, 200, {
        products: history.listTracked(80),
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
      const products = ids.map((id) => history.getById(id)).filter(Boolean);
      send(res, 200, {
        products,
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
      send(res, 200, product);
      return;
    }

    if (url.pathname === "/api/goldbox") {
      const result = await cached("goldbox", GOLD_TTL, () => client.goldbox());
      send(res, 200, { ...result, source: "goldbox", title: "오늘의 골드박스", ...collectMeta() });
      return;
    }

    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) {
        send(res, 400, { error: "검색어를 입력해 주세요." });
        return;
      }
      const result = await cached(`search:${q}`, SEARCH_TTL, () => client.search(q, 10));
      send(res, 200, { ...result, source: "search", title: `'${q}' 검색 결과`, query: q, ...collectMeta() });
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
      send(res, 200, { ...result, source: "best", title: `${meta.name} 인기상품`, categoryId: id, ...collectMeta() });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      send(res, 404, { error: "없는 API입니다." });
      return;
    }

    serveStatic(url.pathname, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, 502, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`셀러딜  http://127.0.0.1:${PORT}`);
  startPriceCollector(client, history, COLLECT_INTERVAL);
});
