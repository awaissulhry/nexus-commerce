/**
 * LF.1 — the embedded browser database.
 *
 * PGlite (WASM Postgres) held as a lazily-created singleton, persisted to IndexedDB so a reload
 * does not re-seed.
 *
 * ── 🔴 Browser-only, and why that needs enforcing rather than assuming ───────────────────────
 *
 * PGlite is a WASM module. Importing it at module scope in a Next.js file drags it into the
 * SERVER bundle too, where it either fails to instantiate or silently bloats the Vercel function.
 * Both failure modes are quiet. So: the import is `await import(...)` inside a function that
 * refuses to run without `window`, and nothing in this directory is imported from a server
 * component.
 *
 * ── Persistence choice ──────────────────────────────────────────────────────────────────────
 *
 * `idb://` (IndexedDB) rather than OPFS. OPFS is faster and is the right eventual home, but it
 * wants a dedicated worker to avoid blocking the main thread, and that is a second moving part
 * this spike does not need in order to answer its one question. Swapping to `opfs-ahp://` is a
 * one-line change here and nothing above this file knows the difference.
 *
 * ── What this is NOT, yet ───────────────────────────────────────────────────────────────────
 *
 * There is no replication. Step 1 seeds from the existing authenticated API once and then serves
 * every query locally — which is precisely what proves the local read path is viable BEFORE
 * anyone enables `wal_level = logical` on production (an irreversible change that also pins Neon
 * out of scale-to-zero for good). Replication replaces `seedFromApi` and nothing else.
 */

import {
  LOCAL_CATALOG_DDL,
  LOCAL_CATALOG_COLUMNS,
  toLocalRow,
  type LocalProductRow,
} from './projection'

/** PGlite's surface, narrowed to what this module uses — avoids importing types at module scope. */
interface PGliteLike {
  exec(sql: string): Promise<unknown>
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>
}

const DB_NAME = 'idb://nexus-local-catalog'

let dbPromise: Promise<PGliteLike> | null = null

/** The singleton. Safe to call repeatedly; the WASM module instantiates once. */
export async function getLocalDb(): Promise<PGliteLike> {
  if (typeof window === 'undefined') {
    throw new Error(
      'local-first: getLocalDb() called on the server. PGlite is browser-only — call it from a client component inside an effect.',
    )
  }
  if (!dbPromise) {
    dbPromise = (async () => {
      const { PGlite } = await import('@electric-sql/pglite')
      const db = (await PGlite.create(DB_NAME)) as unknown as PGliteLike
      await db.exec(LOCAL_CATALOG_DDL)
      return db
    })()
  }
  return dbPromise
}

/** Row count currently held locally. Used to decide whether a seed is needed. */
export async function localRowCount(): Promise<number> {
  const db = await getLocalDb()
  const res = await db.query<{ n: string | number }>('SELECT COUNT(*)::int AS n FROM product')
  return Number(res.rows[0]?.n ?? 0)
}

/**
 * Seed the local store from the authenticated API.
 *
 * 🔴 Uses `credentials: 'include'` against the API's own origin. This is the ONLY way the browser
 * can authenticate here: the session cookie is host-only on the Railway origin, `SameSite=None`
 * and CHIPS-partitioned, so it rides a client-side fetch and is invisible to anything rendering
 * on Vercel. Seeding from a server component would be unauthenticated by construction.
 *
 * The API caps `pageSize`, so this pages until exhausted rather than assuming one round trip.
 */
export async function seedFromApi(apiBase: string, pageSize = 200): Promise<number> {
  const db = await getLocalDb()
  let page = 1
  let written = 0
  let totalPages = 1

  do {
    const res = await fetch(
      `${apiBase}/api/products?page=${page}&pageSize=${pageSize}`,
      { credentials: 'include', cache: 'no-store' },
    )
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? 'local-first: not signed in (401). The seed needs the API session cookie.'
          : `local-first: seed failed with HTTP ${res.status}`,
      )
    }
    const body = (await res.json()) as {
      products?: Record<string, unknown>[]
      totalPages?: number
    }
    const rows = body.products ?? []
    totalPages = body.totalPages ?? 1

    for (const row of rows) {
      const values = toLocalRow(row)
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
      await db.query(
        `INSERT INTO product (${LOCAL_CATALOG_COLUMNS.join(', ')})
         VALUES (${placeholders})
         ON CONFLICT (id) DO UPDATE SET ${LOCAL_CATALOG_COLUMNS.filter((c) => c !== 'id')
           .map((c) => `${c} = EXCLUDED.${c}`)
           .join(', ')}`,
        values,
      )
      written += 1
    }
    page += 1
  } while (page <= totalPages)

  return written
}

/** Read every local row in the grid's default order. Pure local — no network. */
export async function readLocalCatalog(): Promise<LocalProductRow[]> {
  const db = await getLocalDb()
  const res = await db.query<Record<string, unknown>>(
    `SELECT id, sku, name, brand, status,
            base_price          AS "basePrice",
            total_stock         AS "totalStock",
            low_stock_threshold AS "lowStockThreshold",
            product_type        AS "productType",
            fulfillment_method  AS "fulfillmentMethod",
            is_parent           AS "isParent",
            parent_id           AS "parentId",
            sync_channels       AS "syncChannels",
            created_at          AS "createdAt",
            updated_at          AS "updatedAt"
       FROM product
      ORDER BY name ASC`,
  )
  return res.rows as unknown as LocalProductRow[]
}

/** Drop everything. The spike's reset button — never called by production code. */
export async function clearLocalCatalog(): Promise<void> {
  const db = await getLocalDb()
  await db.exec('DELETE FROM product')
}
