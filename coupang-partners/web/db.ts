import pg from "pg";
import type { HistoryFile, PriceHistoryStore, TrackedProduct } from "./price-history.js";
import type { LibraryFile, UserLibrary } from "./user-library.js";

pg.types.setTypeParser(20, (value) => Number(value));

const SCHEMA_SQL = `
do $drop$
declare r record;
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'polsent') then
    return;
  end if;
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute 'drop function ' || r.sig || ' cascade';
  end loop;
  for r in select tablename from pg_tables where schemaname = 'public'
  loop
    execute 'drop table public.' || quote_ident(r.tablename) || ' cascade';
  end loop;
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute 'drop sequence public.' || quote_ident(r.relname) || ' cascade';
  end loop;
end
$drop$;

create schema if not exists polsent;

create table if not exists polsent.products (
  product_id text primary key,
  product_name text not null default '',
  product_image text,
  product_url text,
  category_name text,
  is_rocket boolean,
  is_free_shipping boolean,
  last_price integer not null,
  last_seen_at bigint not null,
  source text not null default ''
);

create table if not exists polsent.price_daily (
  product_id text not null references polsent.products(product_id) on delete cascade,
  day date not null,
  price integer not null,
  primary key (product_id, day)
);

create table if not exists polsent.price_ticks (
  product_id text not null references polsent.products(product_id) on delete cascade,
  seen_at bigint not null,
  price integer not null,
  primary key (product_id, seen_at)
);

create table if not exists polsent.app_state (
  id integer primary key check (id = 1),
  last_collect_at bigint
);

create table if not exists polsent.profile (
  id integer primary key check (id = 1),
  display_name text not null,
  night_start integer not null,
  night_end integer not null,
  rocket_only boolean not null,
  alert_lowest boolean not null,
  alert_target boolean not null,
  alert_restore boolean not null,
  alert_restock boolean not null,
  alert_keyword boolean not null,
  digest boolean not null,
  digest_hour integer not null,
  last_digest_date text not null
);

create table if not exists polsent.watches (
  product_id text primary key,
  position integer not null
);

create table if not exists polsent.folders (
  id text primary key,
  name text not null,
  position integer not null
);

create table if not exists polsent.folder_items (
  folder_id text not null references polsent.folders(id) on delete cascade,
  product_id text not null,
  position integer not null,
  primary key (folder_id, product_id)
);

create table if not exists polsent.targets (
  product_id text primary key,
  price integer not null
);

create table if not exists polsent.memos (
  product_id text primary key,
  body text not null
);

create table if not exists polsent.keywords (
  keyword text primary key,
  position integer not null
);

create table if not exists polsent.misses (
  product_id text primary key,
  count integer not null
);

create table if not exists polsent.purchases (
  product_id text primary key,
  price integer not null,
  bought_at bigint not null
);

create table if not exists polsent.snoozes (
  product_id text primary key,
  until_at bigint not null
);

create table if not exists polsent.price_rules (
  product_id text primary key,
  below_avg_percent integer,
  drop_amount integer
);

create table if not exists polsent.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  position integer not null
);

create table if not exists polsent.alerts (
  id text primary key,
  at bigint not null,
  kind text not null,
  product_id text not null,
  title text not null,
  body text not null,
  read boolean not null,
  position integer not null
);

create table if not exists polsent.alert_dedupe (
  dedupe_key text primary key,
  day text not null
);

create table if not exists polsent.meta (
  key text primary key,
  value text not null
);

alter table polsent.products enable row level security;
alter table polsent.price_daily enable row level security;
alter table polsent.price_ticks enable row level security;
alter table polsent.app_state enable row level security;
alter table polsent.profile enable row level security;
alter table polsent.watches enable row level security;
alter table polsent.folders enable row level security;
alter table polsent.folder_items enable row level security;
alter table polsent.targets enable row level security;
alter table polsent.memos enable row level security;
alter table polsent.keywords enable row level security;
alter table polsent.misses enable row level security;
alter table polsent.purchases enable row level security;
alter table polsent.snoozes enable row level security;
alter table polsent.price_rules enable row level security;
alter table polsent.push_subscriptions enable row level security;
alter table polsent.alerts enable row level security;
alter table polsent.alert_dedupe enable row level security;
alter table polsent.meta enable row level security;

create table if not exists polsent.accounts (
  id text primary key,
  code text not null unique,
  claimed boolean not null default false,
  document jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0
);
alter table polsent.accounts enable row level security;

alter table polsent.products add column if not exists original_price integer;
alter table polsent.profile add column if not exists pin_cursor integer not null default 0;

revoke all on schema polsent from public;
revoke all on all tables in schema polsent from public;
`;

let pool: pg.Pool | null = null;
let readHistoryState: () => HistoryFile = () => ({ version: 2, lastCollectAt: null, products: {} });
let readLibraryState: () => LibraryFile = () => {
  throw new Error("library is not attached");
};
let historyDirty = false;
let libraryDirty = false;
let chain: Promise<void> = Promise.resolve();

function databasePool() {
  if (pool) return pool;
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL이 없습니다.");
  const url = new URL(raw);
  pool = new pg.Pool({
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || "postgres",
    ssl: { rejectUnauthorized: false },
    max: 4,
    connectionTimeoutMillis: 10000,
  });
  return pool;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function insertHistory(client: pg.PoolClient, file: HistoryFile) {
  const snap = clone(file);
  const products = Object.values(snap.products);
  await client.query("truncate polsent.price_ticks, polsent.price_daily, polsent.products, polsent.app_state");
  if (products.length) {
    await client.query(
      `insert into polsent.products (
         product_id, product_name, product_image, product_url, category_name,
         is_rocket, is_free_shipping, last_price, last_seen_at, source, original_price
       )
       select * from unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
         $6::boolean[], $7::boolean[], $8::int[], $9::bigint[], $10::text[], $11::int[]
       )`,
      [
        products.map((item) => item.productId),
        products.map((item) => item.productName || ""),
        products.map((item) => item.productImage),
        products.map((item) => item.productUrl),
        products.map((item) => item.categoryName),
        products.map((item) => item.isRocket),
        products.map((item) => item.isFreeShipping),
        products.map((item) => item.lastPrice),
        products.map((item) => item.lastSeenAt),
        products.map((item) => item.source || ""),
        products.map((item) => item.originalPrice ?? null),
      ],
    );
    const days: { productId: string; day: string; price: number }[] = [];
    for (const product of products) {
      for (const [day, price] of Object.entries(product.daily || {})) {
        if (!day || !Number.isFinite(price)) continue;
        days.push({ productId: product.productId, day, price });
      }
    }
    if (days.length) {
      await client.query(
        `insert into polsent.price_daily (product_id, day, price)
         select * from unnest($1::text[], $2::date[], $3::int[])`,
        [days.map((item) => item.productId), days.map((item) => item.day), days.map((item) => item.price)],
      );
    }
    const ticks: { productId: string; at: number; price: number }[] = [];
    const seenTicks = new Set<string>();
    for (const product of products) {
      for (const tick of product.observations || []) {
        if (!Number.isFinite(tick.at) || !Number.isFinite(tick.price)) continue;
        const key = `${product.productId}:${tick.at}`;
        if (seenTicks.has(key)) continue;
        seenTicks.add(key);
        ticks.push({ productId: product.productId, at: tick.at, price: tick.price });
      }
    }
    for (let index = 0; index < ticks.length; index += 5000) {
      const slice = ticks.slice(index, index + 5000);
      await client.query(
        `insert into polsent.price_ticks (product_id, seen_at, price)
         select * from unnest($1::text[], $2::bigint[], $3::int[])`,
        [slice.map((item) => item.productId), slice.map((item) => item.at), slice.map((item) => item.price)],
      );
    }
  }
  await client.query("insert into polsent.app_state (id, last_collect_at) values (1, $1)", [
    snap.lastCollectAt,
  ]);
}

async function insertLibrary(client: pg.PoolClient, file: LibraryFile) {
  const snap = clone(file);
  await client.query(
    `truncate
       polsent.folder_items,
       polsent.folders,
       polsent.watches,
       polsent.targets,
       polsent.memos,
       polsent.keywords,
       polsent.misses,
       polsent.purchases,
       polsent.snoozes,
       polsent.price_rules,
       polsent.push_subscriptions,
       polsent.alerts,
       polsent.alert_dedupe,
       polsent.profile`,
  );
  const settings = snap.settings;
  await client.query(
    `insert into polsent.profile (
       id, display_name, night_start, night_end, rocket_only,
       alert_lowest, alert_target, alert_restore, alert_restock, alert_keyword,
       digest, digest_hour, last_digest_date, pin_cursor
     ) values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      snap.displayName,
      settings.nightStart,
      settings.nightEnd,
      settings.rocketOnly,
      settings.lowest,
      settings.target,
      settings.restore,
      settings.restock,
      settings.keyword,
      settings.digest,
      settings.digestHour,
      snap.lastDigestDate || "",
      snap.pinCursor || 0,
    ],
  );
  await insertPairs(
    client,
    "insert into polsent.watches (product_id, position) select * from unnest($1::text[], $2::int[])",
    snap.watches,
    (id) => id,
  );
  if (snap.folders.length) {
    await client.query(
      "insert into polsent.folders (id, name, position) select * from unnest($1::text[], $2::text[], $3::int[])",
      [snap.folders.map((folder) => folder.id), snap.folders.map((folder) => folder.name), snap.folders.map((_, index) => index)],
    );
    const items = snap.folders.flatMap((folder) =>
      folder.productIds.map((productId, index) => ({ folderId: folder.id, productId, position: index })),
    );
    if (items.length) {
      await client.query(
        `insert into polsent.folder_items (folder_id, product_id, position)
         select * from unnest($1::text[], $2::text[], $3::int[])`,
        [items.map((item) => item.folderId), items.map((item) => item.productId), items.map((item) => item.position)],
      );
    }
  }
  const targets = Object.entries(snap.targets);
  if (targets.length) {
    await client.query(
      "insert into polsent.targets (product_id, price) select * from unnest($1::text[], $2::int[])",
      [targets.map(([id]) => id), targets.map(([, price]) => price)],
    );
  }
  const memos = Object.entries(snap.memos);
  if (memos.length) {
    await client.query(
      "insert into polsent.memos (product_id, body) select * from unnest($1::text[], $2::text[])",
      [memos.map(([id]) => id), memos.map(([, body]) => body)],
    );
  }
  await insertPairs(
    client,
    "insert into polsent.keywords (keyword, position) select * from unnest($1::text[], $2::int[])",
    snap.keywords,
    (keyword) => keyword,
  );
  const misses = Object.entries(snap.misses);
  if (misses.length) {
    await client.query(
      "insert into polsent.misses (product_id, count) select * from unnest($1::text[], $2::int[])",
      [misses.map(([id]) => id), misses.map(([, count]) => count)],
    );
  }
  const purchases = Object.entries(snap.purchases);
  if (purchases.length) {
    await client.query(
      "insert into polsent.purchases (product_id, price, bought_at) select * from unnest($1::text[], $2::int[], $3::bigint[])",
      [purchases.map(([id]) => id), purchases.map(([, item]) => item.price), purchases.map(([, item]) => item.at)],
    );
  }
  const snoozes = Object.entries(snap.snoozeUntil);
  if (snoozes.length) {
    await client.query(
      "insert into polsent.snoozes (product_id, until_at) select * from unnest($1::text[], $2::bigint[])",
      [snoozes.map(([id]) => id), snoozes.map(([, until]) => until)],
    );
  }
  const rules = Object.entries(snap.rules);
  if (rules.length) {
    await client.query(
      `insert into polsent.price_rules (product_id, below_avg_percent, drop_amount)
       select * from unnest($1::text[], $2::int[], $3::int[])`,
      [
        rules.map(([id]) => id),
        rules.map(([, rule]) => rule.belowAvgPercent),
        rules.map(([, rule]) => rule.dropAmount),
      ],
    );
  }
  if (snap.pushSubscriptions.length) {
    await client.query(
      `insert into polsent.push_subscriptions (endpoint, p256dh, auth, position)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::int[])`,
      [
        snap.pushSubscriptions.map((item) => item.endpoint),
        snap.pushSubscriptions.map((item) => item.keys.p256dh),
        snap.pushSubscriptions.map((item) => item.keys.auth),
        snap.pushSubscriptions.map((_, index) => index),
      ],
    );
  }
  if (snap.alerts.length) {
    await client.query(
      `insert into polsent.alerts (id, at, kind, product_id, title, body, read, position)
       select * from unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[], $8::int[])`,
      [
        snap.alerts.map((alert) => alert.id),
        snap.alerts.map((alert) => alert.at),
        snap.alerts.map((alert) => alert.kind),
        snap.alerts.map((alert) => alert.productId),
        snap.alerts.map((alert) => alert.title),
        snap.alerts.map((alert) => alert.body),
        snap.alerts.map((alert) => alert.read),
        snap.alerts.map((_, index) => index),
      ],
    );
  }
  const dedupe = Object.entries(snap.dedupe);
  if (dedupe.length) {
    await client.query(
      "insert into polsent.alert_dedupe (dedupe_key, day) select * from unnest($1::text[], $2::text[])",
      [dedupe.map(([key]) => key), dedupe.map(([, day]) => day)],
    );
  }
}

async function insertPairs(
  client: pg.PoolClient,
  sql: string,
  values: string[],
  pick: (value: string) => string,
) {
  if (!values.length) return;
  await client.query(sql, [values.map(pick), values.map((_, index) => index)]);
}

async function withTransaction(run: (client: pg.PoolClient) => Promise<void>) {
  const client = await databasePool().connect();
  try {
    await client.query("begin");
    await run(client);
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadHistory(client: pg.PoolClient): Promise<HistoryFile> {
  const products = await client.query(
    `select product_id, product_name, product_image, product_url, category_name,
            is_rocket, is_free_shipping, last_price, last_seen_at, source, original_price
     from polsent.products`,
  );
  const daily = await client.query(
    "select product_id, to_char(day, 'YYYY-MM-DD') as day, price from polsent.price_daily",
  );
  const ticks = await client.query(
    "select product_id, seen_at, price from polsent.price_ticks order by seen_at",
  );
  const state = await client.query("select last_collect_at from polsent.app_state where id = 1");
  const byId: Record<string, TrackedProduct> = {};
  for (const row of products.rows) {
    byId[row.product_id] = {
      productId: row.product_id,
      productName: row.product_name,
      productImage: row.product_image,
      productUrl: row.product_url,
      categoryName: row.category_name,
      isRocket: row.is_rocket,
      isFreeShipping: row.is_free_shipping,
      lastPrice: row.last_price,
      originalPrice: row.original_price,
      lastSeenAt: row.last_seen_at,
      source: row.source,
      daily: {},
      observations: [],
    };
  }
  for (const row of daily.rows) {
    const product = byId[row.product_id];
    if (!product) continue;
    product.daily[row.day] = row.price;
  }
  for (const row of ticks.rows) {
    const product = byId[row.product_id];
    if (!product || !Number.isFinite(row.seen_at) || !Number.isFinite(row.price)) continue;
    product.observations.push({ at: row.seen_at, price: row.price });
  }
  for (const product of Object.values(byId)) {
    if (product.observations.length) continue;
    product.observations = Object.entries(product.daily)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, price]) => ({ at: Date.parse(`${day}T12:00:00+09:00`), price }))
      .filter((item) => Number.isFinite(item.at));
  }
  return {
    version: 2,
    lastCollectAt: state.rows[0]?.last_collect_at ?? null,
    products: byId,
  };
}

async function loadLibrary(client: pg.PoolClient): Promise<LibraryFile> {
  const profile = await client.query("select * from polsent.profile where id = 1");
  const row = profile.rows[0];
  const watches = await client.query("select product_id from polsent.watches order by position");
  const folders = await client.query("select id, name from polsent.folders order by position");
  const items = await client.query(
    "select folder_id, product_id from polsent.folder_items order by position",
  );
  const targets = await client.query("select product_id, price from polsent.targets");
  const memos = await client.query("select product_id, body from polsent.memos");
  const keywords = await client.query("select keyword from polsent.keywords order by position");
  const misses = await client.query("select product_id, count from polsent.misses");
  const purchases = await client.query("select product_id, price, bought_at from polsent.purchases");
  const snoozes = await client.query("select product_id, until_at from polsent.snoozes");
  const rules = await client.query(
    "select product_id, below_avg_percent, drop_amount from polsent.price_rules",
  );
  const pushes = await client.query(
    "select endpoint, p256dh, auth from polsent.push_subscriptions order by position",
  );
  const alerts = await client.query(
    "select id, at, kind, product_id, title, body, read from polsent.alerts order by position",
  );
  const dedupe = await client.query("select dedupe_key, day from polsent.alert_dedupe");
  const folderItems = new Map<string, string[]>();
  for (const item of items.rows) {
    const list = folderItems.get(item.folder_id) ?? [];
    list.push(item.product_id);
    folderItems.set(item.folder_id, list);
  }
  return {
    version: 1,
    displayName: row?.display_name || "나",
    watches: watches.rows.map((item) => item.product_id),
    folders: folders.rows.map((folder) => ({
      id: folder.id,
      name: folder.name,
      productIds: folderItems.get(folder.id) ?? [],
    })),
    targets: Object.fromEntries(targets.rows.map((item) => [item.product_id, item.price])),
    memos: Object.fromEntries(memos.rows.map((item) => [item.product_id, item.body])),
    keywords: keywords.rows.map((item) => item.keyword),
    misses: Object.fromEntries(misses.rows.map((item) => [item.product_id, item.count])),
    purchases: Object.fromEntries(
      purchases.rows.map((item) => [item.product_id, { price: item.price, at: item.bought_at }]),
    ),
    snoozeUntil: Object.fromEntries(snoozes.rows.map((item) => [item.product_id, item.until_at])),
    rules: Object.fromEntries(
      rules.rows.map((item) => [
        item.product_id,
        { belowAvgPercent: item.below_avg_percent, dropAmount: item.drop_amount },
      ]),
    ),
    pushSubscriptions: pushes.rows.map((item) => ({
      endpoint: item.endpoint,
      keys: { p256dh: item.p256dh, auth: item.auth },
    })),
    lastDigestDate: row?.last_digest_date || "",
    settings: {
      nightStart: row?.night_start ?? 23,
      nightEnd: row?.night_end ?? 8,
      rocketOnly: row?.rocket_only ?? false,
      lowest: row?.alert_lowest ?? true,
      target: row?.alert_target ?? true,
      restore: row?.alert_restore ?? true,
      restock: row?.alert_restock ?? true,
      keyword: row?.alert_keyword ?? true,
      digest: row?.digest ?? true,
      digestHour: row?.digest_hour ?? 8,
    },
    alerts: alerts.rows.map((alert) => ({
      id: alert.id,
      at: alert.at,
      kind: alert.kind,
      productId: alert.product_id,
      title: alert.title,
      body: alert.body,
      read: alert.read,
    })),
    dedupe: Object.fromEntries(dedupe.rows.map((item) => [item.dedupe_key, item.day])),
    pinCursor: row?.pin_cursor ?? 0,
  };
}

async function drain() {
  while (historyDirty || libraryDirty) {
    if (historyDirty) {
      historyDirty = false;
      const snap = clone(readHistoryState());
      try {
        await withTransaction((client) => insertHistory(client, snap));
      } catch (error) {
        historyDirty = true;
        throw error;
      }
    }
    if (libraryDirty) {
      libraryDirty = false;
      const snap = clone(readLibraryState());
      try {
        await withTransaction((client) => insertLibrary(client, snap));
      } catch (error) {
        libraryDirty = true;
        throw error;
      }
    }
  }
}

function enqueue() {
  chain = chain
    .then(drain)
    .catch((error) => {
      console.error("[db] save failed", error instanceof Error ? error.message : error);
    });
}

export function whenSaved() {
  return chain;
}

export async function attachStores(history: PriceHistoryStore, library: UserLibrary) {
  const db = databasePool();
  const client = await db.connect();
  try {
    await client.query("select pg_advisory_lock(8675309)");
    const before = await client.query("select count(*)::int as n from pg_tables where schemaname = 'public'");
    const exists = await client.query(
      "select 1 from information_schema.schemata where schema_name = 'polsent'",
    );
    await client.query(SCHEMA_SQL);
    if (!exists.rowCount) {
      console.log(`[db] removed ${before.rows[0].n} public tables`);
    }
    const seeded = await client.query("select value from polsent.meta where key = 'seeded'");
    if (!seeded.rowCount) {
      await client.query("begin");
      try {
        await insertHistory(client, history.exportState());
        await insertLibrary(client, library.exportState());
        await client.query("insert into polsent.meta (key, value) values ('seeded', '1')");
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      console.log(`[db] imported json products=${history.productCount} watches=${library.watches.length}`);
    } else {
      history.importState(await loadHistory(client));
      library.importState(await loadLibrary(client));
      console.log(`[db] loaded products=${history.productCount} watches=${library.watches.length}`);
    }
  } finally {
    try {
      await client.query("select pg_advisory_unlock(8675309)");
    } catch {
      /* ignore */
    }
    client.release();
  }

  readHistoryState = () => history.exportState();
  readLibraryState = () => library.exportState();
  history.useDatabase(() => {
    historyDirty = true;
    enqueue();
  });
  library.useDatabase(() => {
    libraryDirty = true;
    enqueue();
  });
}
