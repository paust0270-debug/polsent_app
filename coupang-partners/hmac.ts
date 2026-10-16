import { createHmac } from "crypto";

/** Coupang Partners HMAC: UTC yyMMdd'T'HHmmss'Z' + method + path + query */
export function createPartnersAuthorization(
  method: string,
  uriWithQuery: string,
  accessKey: string,
  secretKey: string,
): string {
  const qIndex = uriWithQuery.indexOf("?");
  const path = qIndex >= 0 ? uriWithQuery.slice(0, qIndex) : uriWithQuery;
  const query = qIndex >= 0 ? uriWithQuery.slice(qIndex + 1) : "";

  const datetime = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
    .slice(2);

  const message = `${datetime}${method.toUpperCase()}${path}${query}`;
  const signature = createHmac("sha256", secretKey).update(message).digest("hex");

  return `CEA algorithm=HmacSHA256,access-key=${accessKey},signed-date=${datetime},signature=${signature}`;
}
