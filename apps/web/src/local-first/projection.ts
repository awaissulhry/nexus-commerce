/**
 * LF.1 — the local catalog PROJECTION.
 *
 * This is the shape the browser holds. It is deliberately NOT the `Product` model.
 *
 * ── Why a projection and not a replica ───────────────────────────────────────────────────────
 *
 * `Product` has **155 fields** and 64 relation-ish members in `schema.prisma`. Replicating that
 * into a browser would ship the entire write-side model — pricing internals, channel plumbing,
 * compliance columns — to every client, and would couple the local store to every future
 * migration of a table that changes constantly.
 *
 * The API already answers `/api/products` with a **30-field row**. That row is the read model,
 * arrived at by whoever built the grid, and it is the correct thing to mirror locally.
 *
 * ── This is guardrail 3 from the migration plan, arriving early ──────────────────────────────
 *
 * "Flatten variant projections early… this matches the exact document structure you will
 * eventually push to a search engine like Typesense." That is exactly what this table is. When
 * the CQRS phase lands, this DDL becomes the Typesense document schema and the transformer that
 * fills it is the same one that fills this. Nothing here is throwaway.
 *
 * ── Families are FLAT, deliberately ──────────────────────────────────────────────────────────
 *
 * `parentId` is kept as a column rather than modelled as a nested structure, mirroring what
 * `/products/next` already does with AG's tree data over a flat row set. A nested shape would
 * have to be flattened again for search later.
 */

/** One row of the local catalog. Mirrors the API's `/api/products` row, not the Prisma model. */
export interface LocalProductRow {
  id: string
  sku: string
  name: string
  brand: string | null
  status: string
  basePrice: number | null
  totalStock: number | null
  lowStockThreshold: number | null
  productType: string | null
  fulfillmentMethod: string | null
  isParent: boolean
  parentId: string | null
  /** JSON-encoded — PGlite holds it as text; the grid parses on read. */
  syncChannels: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * The local DDL.
 *
 * `TEXT` for ids and enums (no bespoke local types — the projection must stay trivially
 * re-derivable), `REAL` for money because this store is READ-ONLY and never does arithmetic that
 * settles anything. 🔴 Prices are `Decimal(10,2)` server-side; any local total is for display
 * only and must never be written back. Writes go through Fastify — guardrail 2.
 */
export const LOCAL_CATALOG_DDL = `
CREATE TABLE IF NOT EXISTS product (
  id                 TEXT PRIMARY KEY,
  sku                TEXT NOT NULL,
  name               TEXT NOT NULL,
  brand              TEXT,
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  base_price         REAL,
  total_stock        INTEGER,
  low_stock_threshold INTEGER,
  product_type       TEXT,
  fulfillment_method TEXT,
  is_parent          BOOLEAN NOT NULL DEFAULT FALSE,
  parent_id          TEXT,
  sync_channels      TEXT,
  created_at         TEXT,
  updated_at         TEXT
);

-- The three access patterns the grid actually uses: family expansion, the default sort, and
-- the status facet. Added up front because an index on 338 rows costs nothing and their absence
-- is invisible until the catalog is large enough for it to hurt.
CREATE INDEX IF NOT EXISTS product_parent_idx ON product (parent_id);
CREATE INDEX IF NOT EXISTS product_name_idx   ON product (name);
CREATE INDEX IF NOT EXISTS product_status_idx ON product (status);
`

/** Column list for the seed INSERT, kept beside the DDL so the two cannot drift. */
export const LOCAL_CATALOG_COLUMNS = [
  'id',
  'sku',
  'name',
  'brand',
  'status',
  'base_price',
  'total_stock',
  'low_stock_threshold',
  'product_type',
  'fulfillment_method',
  'is_parent',
  'parent_id',
  'sync_channels',
  'created_at',
  'updated_at',
] as const

/** Map one API row onto the projection. The ONLY place the wire shape is interpreted. */
export function toLocalRow(api: Record<string, unknown>): unknown[] {
  const num = (v: unknown): number | null =>
    v === null || v === undefined || v === '' ? null : Number(v)
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v)
  return [
    String(api.id),
    String(api.sku ?? ''),
    String(api.name ?? ''),
    str(api.brand),
    String(api.status ?? 'ACTIVE'),
    num(api.basePrice),
    num(api.totalStock),
    num(api.lowStockThreshold),
    str(api.productType),
    str(api.fulfillmentMethod),
    Boolean(api.isParent),
    str(api.parentId),
    api.syncChannels === null || api.syncChannels === undefined
      ? null
      : JSON.stringify(api.syncChannels),
    str(api.createdAt),
    str(api.updatedAt),
  ]
}
