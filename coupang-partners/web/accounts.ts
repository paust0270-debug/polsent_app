import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import type { IncomingMessage } from "node:http";
import pg from "pg";
import { UserLibrary } from "./user-library.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface AccountRow {
  id: string;
  code: string;
  claimed: boolean;
  library: UserLibrary;
}

export class AccountBook {
  readonly context = new AsyncLocalStorage<UserLibrary>();
  private readonly items = new Map<string, AccountRow>();
  private readonly byLibrary = new Map<UserLibrary, AccountRow>();
  private guest = new UserLibrary(path.join(os.tmpdir(), "sellerdeal-guest.json"));
  private chain: Promise<void> = Promise.resolve();
  private pool: pg.Pool | null = null;

  constructor(private readonly root: UserLibrary) {
    this.guest.useDatabase(() => {});
  }

  async open() {
    this.pool = databasePool();
    const client = await this.pool.connect();
    try {
      const table = await client.query(
        "select 1 from information_schema.tables where table_schema = 'polsent' and table_name = 'accounts'",
      );
      if (!table.rowCount) return;
      const rows = await client.query(
        "select id, code, claimed, document from polsent.accounts order by updated_at",
      );
      if (!rows.rowCount) {
        const row = this.bind(newId(), newCode(), false, this.root);
        await this.write(row);
        console.log("[account] 기존 관심 목록을 복구 코드에 연결했습니다.");
        return;
      }
      for (const item of rows.rows) {
        const library = new UserLibrary(path.join(os.tmpdir(), "sellerdeal-empty", `${item.id}.json`));
        library.importState(item.document);
        this.bind(item.id, item.code, Boolean(item.claimed), library);
      }
      console.log(`[account] loaded ${this.items.size}`);
    } finally {
      client.release();
    }
  }

  libraries() {
    return [...this.items.values()].map((item) => item.library);
  }

  choose(req: IncomingMessage) {
    const header = req.headers["x-account-id"];
    const id = Array.isArray(header) ? header[0] : header || "";
    return this.items.get(id)?.library ?? this.guest;
  }

  async currentAccount() {
    const library = this.context.getStore();
    const row = library ? this.byLibrary.get(library) : undefined;
    if (!row) return null;
    return { id: row.id, code: row.code };
  }

  async openNew() {
    const library = this.context.getStore();
    const existing = library ? this.byLibrary.get(library) : undefined;
    if (existing) return { id: existing.id, code: existing.code };
    const unclaimed = [...this.items.values()].find((item) => !item.claimed);
    if (unclaimed) {
      unclaimed.claimed = true;
      await this.write(unclaimed);
      return { id: unclaimed.id, code: unclaimed.code };
    }
    const row = this.bind(newId(), newCode(), true, new UserLibrary(path.join(os.tmpdir(), "sellerdeal-empty", `${Date.now()}.json`)));
    await this.write(row);
    return { id: row.id, code: row.code };
  }

  async restore(code: string) {
    const wanted = code.trim().toUpperCase();
    const row = [...this.items.values()].find((item) => item.code.toUpperCase() === wanted);
    if (!row) return null;
    row.claimed = true;
    await this.write(row);
    return { id: row.id, code: row.code };
  }

  private bind(id: string, code: string, claimed: boolean, library: UserLibrary) {
    const row: AccountRow = { id, code, claimed, library };
    this.items.set(id, row);
    this.byLibrary.set(library, row);
    library.useDatabase(() => {
      this.chain = this.chain.then(() => this.write(row)).catch((error) => {
        console.error("[account] save failed", error instanceof Error ? error.message : error);
      });
    });
    return row;
  }

  private async write(row: AccountRow) {
    if (!this.pool) return;
    await this.pool.query(
      `insert into polsent.accounts (id, code, claimed, document, updated_at)
       values ($1, $2, $3, $4::jsonb, $5)
       on conflict (id) do update
         set code = excluded.code,
             claimed = excluded.claimed,
             document = excluded.document,
             updated_at = excluded.updated_at`,
      [row.id, row.code, row.claimed, JSON.stringify(row.library.exportState()), Date.now()],
    );
  }
}

function databasePool() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL이 없습니다.");
  const url = new URL(raw);
  return new pg.Pool({
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || "postgres",
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10000,
  });
}

function newId() {
  return randomBytes(18).toString("hex");
}

function newCode() {
  const bytes = randomBytes(8);
  return [...bytes].map((value) => ALPHABET[value % ALPHABET.length]).join("");
}
