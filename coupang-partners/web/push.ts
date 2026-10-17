import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import type { AlertNote } from "./alerts.js";
import { inQuietHours, type StoredPushSubscription, type UserLibrary } from "./user-library.js";

const require = createRequire(import.meta.url);
const webpush = require("web-push") as {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: StoredPushSubscription, payload: string): Promise<unknown>;
};

export function initPush(filePath: string) {
  let keys: { publicKey: string; privateKey: string };
  if (fs.existsSync(filePath)) {
    keys = JSON.parse(fs.readFileSync(filePath, "utf8")) as { publicKey: string; privateKey: string };
  } else {
    keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(keys), "utf8");
  }
  webpush.setVapidDetails("mailto:sellerdeal@localhost", keys.publicKey, keys.privateKey);
  return keys.publicKey;
}

export async function notifyAlerts(library: UserLibrary, notes: AlertNote[], ignoreQuiet = false) {
  if (!notes.length || !library.pushSubscriptions.length) return;
  if (!ignoreQuiet && inQuietHours(library.settings)) return;
  const first = notes[0];
  const title = notes.length === 1 ? first.title : `셀러딜 알림 ${notes.length}건`;
  const body = notes.length === 1 ? first.body : notes.slice(0, 3).map((item) => item.body).join("\n");
  await sendPush(library, { title, body, url: first.url });
}

export async function sendPush(
  library: UserLibrary,
  payload: { title: string; body: string; url: string },
) {
  const subscriptions = library.pushSubscriptions;
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) library.removeSubscription(subscription.endpoint);
        else console.error("[push]", status || err);
      }
    }),
  );
}
