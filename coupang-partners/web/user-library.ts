import * as fs from "fs";
import * as path from "path";

export type AlertKind = "lowest" | "target" | "restore" | "restock" | "keyword" | "rule" | "afterbuy" | "digest";

export interface UserAlert {
  id: string;
  at: number;
  kind: AlertKind;
  productId: string;
  title: string;
  body: string;
  read: boolean;
}

export interface Folder {
  id: string;
  name: string;
  productIds: string[];
}

export interface PurchaseRecord {
  price: number;
  at: number;
}

export interface PriceRule {
  belowAvgPercent: number | null;
  dropAmount: number | null;
}

export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface LibrarySettings {
  nightStart: number;
  nightEnd: number;
  rocketOnly: boolean;
  lowest: boolean;
  target: boolean;
  restore: boolean;
  restock: boolean;
  keyword: boolean;
  digest: boolean;
  digestHour: number;
}

export interface LibraryFile {
  version: 1;
  displayName: string;
  watches: string[];
  folders: Folder[];
  targets: Record<string, number>;
  memos: Record<string, string>;
  keywords: string[];
  misses: Record<string, number>;
  purchases: Record<string, PurchaseRecord>;
  snoozeUntil: Record<string, number>;
  rules: Record<string, PriceRule>;
  pushSubscriptions: StoredPushSubscription[];
  lastDigestDate: string;
  settings: LibrarySettings;
  alerts: UserAlert[];
  dedupe: Record<string, string>;
}

const DEFAULT_SETTINGS: LibrarySettings = {
  nightStart: 23,
  nightEnd: 8,
  rocketOnly: false,
  lowest: true,
  target: true,
  restore: true,
  restock: true,
  keyword: true,
  digest: true,
  digestHour: 8,
};

function emptyFile(): LibraryFile {
  return {
    version: 1,
    displayName: "나",
    watches: [],
    folders: [],
    targets: {},
    memos: {},
    keywords: [],
    misses: {},
    purchases: {},
    snoozeUntil: {},
    rules: {},
    pushSubscriptions: [],
    lastDigestDate: "",
    settings: { ...DEFAULT_SETTINGS },
    alerts: [],
    dedupe: {},
  };
}

export class UserLibrary {
  private file: LibraryFile = emptyFile();

  constructor(private readonly filePath: string) {
    this.load();
  }

  snapshot() {
    return {
      displayName: this.file.displayName,
      watches: [...this.file.watches],
      folders: this.file.folders.map((folder) => ({
        ...folder,
        productIds: [...folder.productIds],
      })),
      targets: { ...this.file.targets },
      memos: { ...this.file.memos },
      keywords: [...this.file.keywords],
      settings: { ...this.file.settings },
      unread: this.file.alerts.filter((alert) => !alert.read).length,
    };
  }

  get watches() {
    return [...this.file.watches];
  }

  get settings() {
    return { ...this.file.settings };
  }

  get keywords() {
    return [...this.file.keywords];
  }

  isWatched(id: string) {
    return this.file.watches.includes(id);
  }

  target(id: string) {
    return this.file.targets[id] ?? null;
  }

  memo(id: string) {
    return this.file.memos[id] ?? "";
  }

  folderOf(id: string) {
    return this.file.folders.find((folder) => folder.productIds.includes(id))?.id ?? null;
  }

  setDisplayName(name: string) {
    const next = name.trim().slice(0, 20);
    if (!next) return;
    this.file.displayName = next;
    this.save();
  }

  setWatch(id: string, on: boolean) {
    if (!id) return;
    if (on) {
      this.file.watches = [id, ...this.file.watches.filter((item) => item !== id)].slice(0, 200);
    } else {
      this.file.watches = this.file.watches.filter((item) => item !== id);
      for (const folder of this.file.folders) {
        folder.productIds = folder.productIds.filter((item) => item !== id);
      }
    }
    this.save();
  }

  addFolder(name: string) {
    const next = name.trim().slice(0, 30);
    if (!next) return null;
    if (this.file.folders.length >= 20) return null;
    const folder: Folder = { id: `f-${Date.now().toString(36)}`, name: next, productIds: [] };
    this.file.folders.push(folder);
    this.save();
    return folder;
  }

  renameFolder(id: string, name: string) {
    const folder = this.file.folders.find((item) => item.id === id);
    const next = name.trim().slice(0, 30);
    if (!folder || !next) return false;
    folder.name = next;
    this.save();
    return true;
  }

  deleteFolder(id: string) {
    const before = this.file.folders.length;
    this.file.folders = this.file.folders.filter((folder) => folder.id !== id);
    if (this.file.folders.length === before) return false;
    this.save();
    return true;
  }

  assign(productId: string, folderId: string | null) {
    if (!productId) return;
    if (folderId && !this.file.folders.some((folder) => folder.id === folderId)) return;
    for (const folder of this.file.folders) {
      folder.productIds = folder.productIds.filter((id) => id !== productId);
    }
    if (folderId) {
      const folder = this.file.folders.find((item) => item.id === folderId);
      folder?.productIds.unshift(productId);
      if (!this.file.watches.includes(productId)) {
        this.file.watches = [productId, ...this.file.watches].slice(0, 200);
      }
    }
    this.save();
  }

  setTarget(productId: string, price: number | null) {
    if (!productId) return;
    if (price == null || !Number.isFinite(price) || price <= 0) delete this.file.targets[productId];
    else this.file.targets[productId] = Math.round(price);
    this.save();
  }

  setMemo(productId: string, memo: string) {
    if (!productId) return;
    const next = memo.trim().slice(0, 500);
    if (!next) delete this.file.memos[productId];
    else this.file.memos[productId] = next;
    this.save();
  }

  setKeywords(keywords: string[]) {
    const next = [...new Set(keywords.map((item) => item.trim()).filter((item) => item.length >= 2))];
    this.file.keywords = next.slice(0, 30);
    this.save();
  }

  purchase(id: string) {
    return this.file.purchases[id] ?? null;
  }

  rule(id: string) {
    return this.file.rules[id] ?? { belowAvgPercent: null, dropAmount: null };
  }

  snoozeUntil(id: string) {
    const until = this.file.snoozeUntil[id];
    return until && until > Date.now() ? until : null;
  }

  isSnoozed(id: string) {
    return this.snoozeUntil(id) != null;
  }

  digestDate() {
    return this.file.lastDigestDate;
  }

  get pushSubscriptions() {
    return this.file.pushSubscriptions.map((item) => ({
      endpoint: item.endpoint,
      keys: { ...item.keys },
    }));
  }

  setPurchase(productId: string, price: number | null) {
    if (!productId) return;
    if (price == null || !Number.isFinite(price) || price <= 0) {
      delete this.file.purchases[productId];
    } else {
      this.file.purchases[productId] = { price: Math.round(price), at: Date.now() };
      this.rememberWatch(productId);
    }
    this.save();
  }

  setSnooze(productId: string, days: number) {
    if (!productId) return;
    if (!Number.isFinite(days) || days <= 0) delete this.file.snoozeUntil[productId];
    else this.file.snoozeUntil[productId] = Date.now() + Math.round(days) * 86_400_000;
    this.save();
  }

  setRule(productId: string, belowAvgPercent: number | null, dropAmount: number | null) {
    if (!productId) return;
    const below = cleanPercent(belowAvgPercent);
    const drop = cleanMoney(dropAmount);
    if (below == null && drop == null) delete this.file.rules[productId];
    else {
      this.file.rules[productId] = { belowAvgPercent: below, dropAmount: drop };
      this.rememberWatch(productId);
    }
    this.save();
  }

  addSubscription(subscription: StoredPushSubscription) {
    if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) return;
    this.file.pushSubscriptions = [
      subscription,
      ...this.file.pushSubscriptions.filter((item) => item.endpoint !== subscription.endpoint),
    ].slice(0, 10);
    this.save();
  }

  removeSubscription(endpoint: string) {
    const before = this.file.pushSubscriptions.length;
    this.file.pushSubscriptions = this.file.pushSubscriptions.filter((item) => item.endpoint !== endpoint);
    if (this.file.pushSubscriptions.length !== before) this.save();
  }

  markDigest(day: string) {
    if (!day || this.file.lastDigestDate === day) return;
    this.file.lastDigestDate = day;
    this.save();
  }

  updateSettings(partial: Partial<LibrarySettings>) {
    const settings = { ...this.file.settings };
    if (typeof partial.nightStart === "number") settings.nightStart = clampHour(partial.nightStart);
    if (typeof partial.nightEnd === "number") settings.nightEnd = clampHour(partial.nightEnd);
    if (typeof partial.digestHour === "number") settings.digestHour = clampHour(partial.digestHour);
    for (const key of ["rocketOnly", "lowest", "target", "restore", "restock", "keyword", "digest"] as const) {
      if (typeof partial[key] === "boolean") settings[key] = partial[key];
    }
    this.file.settings = settings;
    this.save();
  }

  private rememberWatch(productId: string) {
    if (!this.file.watches.includes(productId)) {
      this.file.watches = [productId, ...this.file.watches].slice(0, 200);
    }
  }

  clearMiss(id: string) {
    const previous = this.file.misses[id] || 0;
    if (!previous) return 0;
    delete this.file.misses[id];
    this.save();
    return previous;
  }

  addMiss(id: string) {
    const next = (this.file.misses[id] || 0) + 1;
    this.file.misses[id] = next;
    this.save();
    return next;
  }

  pushAlert(alert: Omit<UserAlert, "id" | "at" | "read"> & { at?: number }) {
    const day = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const key = `${alert.kind}:${alert.productId}:${day}`;
    if (this.file.dedupe[key]) return false;
    this.file.dedupe[key] = day;
    this.file.alerts.unshift({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at: alert.at ?? Date.now(),
      kind: alert.kind,
      productId: alert.productId,
      title: alert.title,
      body: alert.body,
      read: false,
    });
    this.file.alerts = this.file.alerts.slice(0, 100);
    const keep = new Set(Object.values(recentDays(3)));
    for (const dedupeKey of Object.keys(this.file.dedupe)) {
      if (!keep.has(this.file.dedupe[dedupeKey])) delete this.file.dedupe[dedupeKey];
    }
    this.save();
    return true;
  }

  listAlerts() {
    return this.file.alerts.map((alert) => ({ ...alert }));
  }

  markAlertsRead(ids?: string[]) {
    const set = ids?.length ? new Set(ids) : null;
    for (const alert of this.file.alerts) {
      if (!set || set.has(alert.id)) alert.read = true;
    }
    this.save();
  }

  exportState() {
    return this.file;
  }

  importState(raw: unknown) {
    if (!raw || typeof raw !== "object") {
      this.file = emptyFile();
      return;
    }
    this.apply(raw as Partial<LibraryFile>);
  }

  useDatabase(save: () => void) {
    this.databaseSave = save;
  }

  private databaseSave: (() => void) | null = null;

  private apply(raw: Partial<LibraryFile>) {
    const base = emptyFile();
    this.file = {
      ...base,
      ...raw,
      version: 1,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      watches: Array.isArray(raw.watches) ? raw.watches.map(String) : [],
      folders: Array.isArray(raw.folders) ? raw.folders : [],
      targets: raw.targets && typeof raw.targets === "object" ? raw.targets : {},
      memos: raw.memos && typeof raw.memos === "object" ? raw.memos : {},
      keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String) : [],
      misses: raw.misses && typeof raw.misses === "object" ? raw.misses : {},
      purchases: raw.purchases && typeof raw.purchases === "object" ? raw.purchases : {},
      snoozeUntil: raw.snoozeUntil && typeof raw.snoozeUntil === "object" ? raw.snoozeUntil : {},
      rules: raw.rules && typeof raw.rules === "object" ? raw.rules : {},
      pushSubscriptions: Array.isArray(raw.pushSubscriptions) ? raw.pushSubscriptions : [],
      lastDigestDate: typeof raw.lastDigestDate === "string" ? raw.lastDigestDate : "",
      alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
      dedupe: raw.dedupe && typeof raw.dedupe === "object" ? raw.dedupe : {},
      displayName: typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName : "나",
    };
  }

  private load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      this.apply(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<LibraryFile>);
    } catch {
      this.file = emptyFile();
    }
  }

  private save() {
    if (this.databaseSave) {
      this.databaseSave();
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.file), "utf8");
  }
}

function cleanPercent(value: number | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(90, Math.max(1, Math.round(value)));
}

function cleanMoney(value: number | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function clampHour(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(23, Math.max(0, Math.round(value)));
}

function recentDays(count: number) {
  const days: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    const day = new Date(Date.now() + 9 * 60 * 60 * 1000 - i * 86400000).toISOString().slice(0, 10);
    days[day] = day;
  }
  return days;
}

export function inQuietHours(settings: LibrarySettings, date = new Date()) {
  const hour = new Date(date.getTime() + 9 * 60 * 60 * 1000).getUTCHours();
  const { nightStart, nightEnd } = settings;
  if (nightStart === nightEnd) return false;
  if (nightStart < nightEnd) return hour >= nightStart && hour < nightEnd;
  return hour >= nightStart || hour < nightEnd;
}
