import { createPartnersAuthorization } from "./hmac.js";

const BASE_URL = "https://api-gateway.coupang.com";
const OPENAPI = "/v2/providers/affiliate_open_api/apis/openapi";

export interface PartnersConfig {
  accessKey: string;
  secretKey: string;
  subId?: string;
}

export interface CollectedProduct {
  productId: string | number | null;
  productName: string;
  productPrice: number | null;
  originalPrice: number | null;
  productImage: string | null;
  productUrl: string | null;
  isRocket: boolean | null;
  isFreeShipping: boolean | null;
  categoryName: string | null;
  keyword: string | null;
  source: string;
}

export class CoupangPartnersClient {
  constructor(private readonly config: PartnersConfig) {
    if (!config.accessKey || !config.secretKey) {
      throw new Error("COUPANG_PARTNERS_ACCESS_KEY / COUPANG_PARTNERS_SECRET_KEY 가 필요합니다.");
    }
  }

  async search(keyword: string, limit = 10): Promise<CollectedProduct[]> {
    const capped = Math.min(Math.max(limit, 1), 10);
    const params = new URLSearchParams({
      keyword,
      limit: String(capped),
    });
    if (this.config.subId) params.set("subId", this.config.subId);
    const data = await this.get(`${OPENAPI}/products/search?${params.toString()}`);
    return this.normalizeList(data, "search", keyword);
  }

  async goldbox(): Promise<CollectedProduct[]> {
    const params = new URLSearchParams();
    if (this.config.subId) params.set("subId", this.config.subId);
    const qs = params.toString();
    const path = qs ? `${OPENAPI}/products/goldbox?${qs}` : `${OPENAPI}/products/goldbox`;
    const data = await this.get(path);
    return this.normalizeList(data, "goldbox");
  }

  async bestCategory(categoryId: string | number, limit = 10): Promise<CollectedProduct[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const params = new URLSearchParams({ limit: String(capped) });
    if (this.config.subId) params.set("subId", this.config.subId);
    const data = await this.get(
      `${OPENAPI}/products/bestcategories/${categoryId}?${params.toString()}`,
    );
    return this.normalizeList(data, `bestcategories:${categoryId}`);
  }

  async deepLink(urls: string[]): Promise<unknown> {
    return this.post(`${OPENAPI}/v1/deeplink`, { coupangUrls: urls });
  }

  private async get(pathAndQuery: string): Promise<unknown> {
    return this.request("GET", pathAndQuery);
  }

  private async post(pathAndQuery: string, body: unknown): Promise<unknown> {
    return this.request("POST", pathAndQuery, body);
  }

  private async request(method: string, pathAndQuery: string, body?: unknown): Promise<unknown> {
    const authorization = createPartnersAuthorization(
      method,
      pathAndQuery,
      this.config.accessKey,
      this.config.secretKey,
    );

    const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`쿠팡 파트너스 응답 파싱 실패 (${res.status}): ${text.slice(0, 300)}`);
    }

    if (!res.ok) {
      throw new Error(
        `쿠팡 파트너스 API 오류 ${res.status}: ${typeof json === "object" ? JSON.stringify(json) : text}`,
      );
    }

    return json;
  }

  private normalizeList(payload: unknown, source: string, keyword: string | null = null): CollectedProduct[] {
    const rows = extractProductRows(payload);
    return rows.map((row) => ({
      productId: pick(row, ["productId", "itemId", "productIdStr"]) ?? null,
      productName: String(pick(row, ["productName", "title", "name"]) ?? ""),
      productPrice: toNumber(pick(row, ["productPrice", "price", "salePrice"])),
      originalPrice: toNumber(pick(row, ["originalPrice", "productOriginalPrice", "originPrice"])),
      productImage: (pick(row, ["productImage", "productImageUrl", "image"]) as string) ?? null,
      productUrl: (pick(row, ["productUrl", "productUrlMobile", "url"]) as string) ?? null,
      isRocket: toBool(pick(row, ["isRocket", "rocket"])),
      isFreeShipping: toBool(pick(row, ["isFreeShipping", "freeShipping"])),
      categoryName: (pick(row, ["categoryName", "category"]) as string) ?? null,
      keyword,
      source,
    }));
  }
}

function extractProductRows(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const data = root.data;

  if (Array.isArray(data)) return data.filter(isRecord);
  if (data && typeof data === "object") {
    const inner = data as Record<string, unknown>;
    for (const key of ["productData", "data", "productInfo", "goldBoxProductList"]) {
      if (Array.isArray(inner[key])) return inner[key].filter(isRecord);
    }
  }
  if (Array.isArray(root.productData)) return root.productData.filter(isRecord);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return undefined;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "Y" || value === 1) return true;
  if (value === "false" || value === "N" || value === 0) return false;
  return null;
}
