/**
 * 쿠팡 파트너스 Open API 상품 수집
 *
 *   npx tsx coupang-partners/collect.ts goldbox
 *   npx tsx coupang-partners/collect.ts search 노트북
 *   npx tsx coupang-partners/collect.ts best 1001
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { CoupangPartnersClient } from "./client.js";
import { BEST_CATEGORIES } from "./catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env") });

function client() {
  return new CoupangPartnersClient({
    accessKey: process.env.COUPANG_PARTNERS_ACCESS_KEY || "",
    secretKey: process.env.COUPANG_PARTNERS_SECRET_KEY || "",
    subId: process.env.COUPANG_PARTNERS_SUB_ID || undefined,
  });
}

function save(kind: string, products: unknown[]) {
  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `${kind}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(products, null, 2), "utf8");
  return file;
}

function printProducts(products: { productName: string; productPrice: number | null; productUrl: string | null }[]) {
  if (!products.length) {
    console.log("수집된 상품이 없습니다.");
    return;
  }
  products.forEach((p, i) => {
    const price = p.productPrice == null ? "-" : `${p.productPrice.toLocaleString("ko-KR")}원`;
    console.log(`${String(i + 1).padStart(2, " ")}. ${p.productName}  ${price}`);
    if (p.productUrl) console.log(`    ${p.productUrl}`);
  });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const api = client();

  if (!cmd || cmd === "help" || cmd === "-h") {
    console.log(`쿠팡 파트너스 상품 수집

  npx tsx coupang-partners/collect.ts goldbox
  npx tsx coupang-partners/collect.ts search <키워드>
  npx tsx coupang-partners/collect.ts best <카테고리ID>

카테고리 예시:
${BEST_CATEGORIES.map(({ id, name }) => `  ${id}  ${name}`).join("\n")}
`);
    process.exit(0);
  }

  let products;
  let kind: string;

  if (cmd === "goldbox") {
    kind = "goldbox";
    products = await api.goldbox();
  } else if (cmd === "search") {
    const keyword = arg?.trim();
    if (!keyword) {
      console.error("검색 키워드가 필요합니다. 예: npx tsx coupang-partners/collect.ts search 노트북");
      process.exit(1);
    }
    kind = `search-${keyword}`;
    products = await api.search(keyword);
  } else if (cmd === "best") {
    const categoryId = arg?.trim();
    if (!categoryId) {
      console.error("카테고리 ID가 필요합니다. 예: npx tsx coupang-partners/collect.ts best 1016");
      process.exit(1);
    }
    kind = `best-${categoryId}`;
    products = await api.bestCategory(categoryId);
  } else {
    console.error(`알 수 없는 명령: ${cmd}`);
    process.exit(1);
  }

  const file = save(kind.replace(/[\\/:*?"<>|]/g, "_"), products);
  console.log(`[OK] ${products.length}건 수집`);
  printProducts(products);
  console.log(`저장: ${file}`);
}

main().catch((err) => {
  console.error("[FAIL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
