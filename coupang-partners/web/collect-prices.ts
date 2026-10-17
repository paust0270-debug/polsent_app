/**
 * 일별 최저가 스냅샷 1회 수집
 *   npx tsx coupang-partners/web/collect-prices.ts
 */
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
import { CoupangPartnersClient } from "../client.js";
import { collectPriceSnapshot } from "./collector.js";
import { attachStores, whenSaved } from "./db.js";
import { PriceHistoryStore } from "./price-history.js";
import { UserLibrary } from "./user-library.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(rootDir, ".env") });

const client = new CoupangPartnersClient({
  accessKey: process.env.COUPANG_PARTNERS_ACCESS_KEY || "",
  secretKey: process.env.COUPANG_PARTNERS_SECRET_KEY || "",
  subId: process.env.COUPANG_PARTNERS_SUB_ID || undefined,
});
const history = new PriceHistoryStore(path.join(__dirname, "price-history.json"));
const library = new UserLibrary(path.join(__dirname, "user-library.json"));

async function main() {
  await attachStores(history, library);
  const result = await collectPriceSnapshot(client, history);
  await whenSaved();
  console.log(
    `[OK] 수집 ${result.ok}개 성공 / ${result.fail}개 실패 / 추적 ${history.productCount}상품`,
  );
  if (result.errors.length) {
    for (const err of result.errors) console.error(" ", err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
