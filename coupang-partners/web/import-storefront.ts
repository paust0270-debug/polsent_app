/**
 * 공개 스토어프론트의 상품 번호·이름·이미지를 가져와
 * 쿠팡 상품 주소만 이 계정의 파트너스 딥링크로 바꿉니다.
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { CoupangPartnersClient } from "../client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(rootDir, ".env") });

const STORE = "shopping_flavor";
const OUT = path.join(__dirname, "storefront-catalog.json");
const COLLECTIONS = [
  "1006102",
  "1038402",
  "1006100",
  "1006108",
  "1006106",
  "1006107",
  "1006104",
  "1006103",
  "1006098",
  "1006101",
];

interface RawProduct {
  productId: number;
  itemId: number;
  vendorItemId: number;
  salesPrice?: { units?: number };
  image?: string;
  customName?: string;
  title?: string;
}

interface ShelfProduct {
  productId: string;
  productName: string;
  productPrice: number | null;
  productImage: string;
  productUrl: string;
}

const client = new CoupangPartnersClient({
  accessKey: process.env.COUPANG_PARTNERS_ACCESS_KEY || "",
  secretKey: process.env.COUPANG_PARTNERS_SECRET_KEY || "",
  subId: process.env.COUPANG_PARTNERS_SUB_ID || undefined,
});

function cleanTitle(title: string) {
  return title.replace(/\s*펼처보기[\s\S]*$/u, "").replace(/\s*펼쳐보기[\s\S]*$/u, "").trim();
}

function productPage(product: RawProduct) {
  const url = new URL(`https://www.coupang.com/vp/products/${product.productId}`);
  url.searchParams.set("itemId", String(product.itemId));
  url.searchParams.set("vendorItemId", String(product.vendorItemId));
  return url.toString();
}

function biggerImage(image: string) {
  return image.replace("/212x212ex/", "/492x492ex/");
}

async function fetchCollection(id: string) {
  const products: RawProduct[] = [];
  let title = id;
  let total = 1;
  let offset = 0;
  while (offset < total) {
    const endpoint = new URL("https://influencers.coupang.com/api/v1/storefronts/rendering/landing/collection");
    endpoint.searchParams.set("storefrontName", STORE);
    endpoint.searchParams.set("collectionId", id);
    endpoint.searchParams.set("offset", String(offset));
    endpoint.searchParams.set("limit", "40");
    const res = await fetch(endpoint, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`컬렉션 ${id} 조회 실패 (${res.status})`);
    const json = await res.json() as {
      data?: { title?: string; elements?: { total?: number; list?: RawProduct[] } };
    };
    title = json.data?.title || title;
    total = json.data?.elements?.total || 0;
    const list = json.data?.elements?.list || [];
    products.push(...list);
    if (!list.length) break;
    offset += list.length;
  }
  return { id, title: cleanTitle(title), products };
}

function affiliateUrl(payload: unknown, index: number) {
  const data = (payload as { data?: unknown }).data;
  const rows = Array.isArray(data) ? data : [];
  const row = rows[index] as { shortenUrl?: string; landingUrl?: string } | undefined;
  return row?.shortenUrl || row?.landingUrl || "";
}

async function toOwnLinks(pages: string[]) {
  const links: string[] = [];
  for (let i = 0; i < pages.length; i += 20) {
    const batch = pages.slice(i, i + 20);
    const payload = await client.deepLink(batch);
    for (let n = 0; n < batch.length; n += 1) links.push(affiliateUrl(payload, n));
    process.stdout.write(`\r딥링크 ${Math.min(i + batch.length, pages.length)}/${pages.length}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  process.stdout.write("\n");
  return links;
}

const shelves: { id: string; title: string; products: ShelfProduct[] }[] = [];
const pages: string[] = [];
const pending: { shelfIndex: number; product: RawProduct }[] = [];

for (const id of COLLECTIONS) {
  const collection = await fetchCollection(id);
  const shelfIndex = shelves.length;
  shelves.push({ id: collection.id, title: collection.title, products: [] });
  for (const product of collection.products) {
    if (!product.productId || !product.itemId || !product.vendorItemId) continue;
    pages.push(productPage(product));
    pending.push({ shelfIndex, product });
  }
  console.log(`${collection.title} ${collection.products.length}개`);
}

const links = await toOwnLinks(pages);
let missing = 0;
pending.forEach((item, index) => {
  const productUrl = links[index] || "";
  if (!productUrl || productUrl.includes("AF7253345")) {
    missing += 1;
    return;
  }
  const product = item.product;
  shelves[item.shelfIndex].products.push({
    productId: String(product.productId),
    productName: product.customName || product.title || "",
    productPrice: product.salesPrice?.units ?? null,
    productImage: biggerImage(product.image || ""),
    productUrl,
  });
});

if (missing) console.log(`딥링크 실패 ${missing}개`);
const kept = shelves.reduce((sum, shelf) => sum + shelf.products.length, 0);
if (!kept) throw new Error("파트너스 링크로 바꾼 상품이 없습니다.");

fs.writeFileSync(OUT, JSON.stringify({ source: STORE, importedAt: new Date().toISOString(), shelves }, null, 2));
console.log(`저장 ${kept}개 → ${OUT}`);
