import { Prisma } from '@prisma/client'
import type { CatalogLanguageProjection } from '@nexus/shared/products-grid'
import prisma from '../../db.js'
import { normalizeLanguage } from './content-language.js'
import { resolveContent } from './content-resolver.js'
import type { ProductListQuery } from '../products/list-products.service.js'
import { SCOPE_STATES } from './readiness-model.js'

// LX.5 already materializes this resolver verdict on every applicable text field,
// including optional fields. Match its recorded fallback, never infer from empty text.
//
// LX.F P2-14: the fact, not the prose. `ReadinessIndex.missing[].kind` is stamped
// by the one producer (`studio-sheet.service.ts`, via `ReadinessIssue.kind`), so
// the SQL predicate and the JS projection cannot disagree on a sentence — the
// two hand-written matchers they replace differed on an empty language segment
// (`LIKE '%…%'` matches empty, `/.+/` does not) and both went false silently
// whenever the operator-facing wording changed. Rows written by the older
// producer carry no `kind`; the reconcile that is already the R-LX-9 deploy
// prerequisite restamps them.
export const LANGUAGE_FALLBACK_KIND = 'language-fallback'
const fallbackSql = Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(r.missing) issue WHERE issue->>'kind' = ${LANGUAGE_FALLBACK_KIND})`
export function indexFallsBack(missing: unknown): boolean {
  return Array.isArray(missing) && missing.some(issue => issue?.kind === LANGUAGE_FALLBACK_KIND)
}
export async function restrictCatalogLanguage(q: ProductListQuery, where: Prisma.ProductWhereInput): Promise<string[] | null> {
  if (!q.language || q.languageStates === undefined && q.languageFallback === undefined) return null
  // Two independent empty-set states, each named for the field it belongs to (P2-16).
  if (q.languageStates?.length === 0) return []
  if (q.languageFallback === 'none') return []
  const candidates = await prisma.product.findMany({ where, select: { id: true } })
  if (!candidates.length) return []
  // R-LX-9: a product with no index row for this language is NOT COMPUTED, not absent.
  const states = q.languageStates?.length ? Prisma.sql`AND COALESCE(r.state, 'notComputed') IN (${Prisma.join(q.languageStates)})` : Prisma.empty
  // `'none'` already returned above, so by here the value is boolean | undefined —
  // tsc proved the second comparison dead (TS2367) and it is gone.
  const fallback = q.languageFallback === undefined ? Prisma.empty : Prisma.sql`AND r.id IS NOT NULL AND ${fallbackSql} = ${q.languageFallback}`
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT p.id FROM "Product" p LEFT JOIN "ReadinessIndex" r ON r."productId"=p.id AND r."workspaceId"=p."workspaceId"
      AND r.channel IS NULL AND r.market IS NULL AND r."accountId" IS NULL AND r."aliasId" IS NULL AND r.language=${normalizeLanguage(q.language)}
    WHERE p.id IN (${Prisma.join(candidates.map(p => p.id))}) ${states} ${fallback}`)
  return rows.map(row => row.id)
}

/** Batch only the requested page's content; no sheets and no provider schema reads. */
export async function catalogLanguageValues(ids: string[], language: string): Promise<Map<string, CatalogLanguageProjection>> {
  const requested = normalizeLanguage(language)
  const [products, index] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, include: { translations: true, parent: { include: { translations: true } } } }),
    prisma.readinessIndex.findMany({ where: { productId: { in: ids }, language: requested, channel: null, market: null, accountId: null, aliasId: null } }),
  ])
  const readiness = new Map(index.map(row => [row.productId, row]))
  return new Map(products.map(product => {
    const resolve = (field: string) => resolveContent({ product: product as any, parent: product.parent as any, field, address: { requested } })
    const row = readiness.get(product.id)
    return [product.id, { title: resolve('title'), description: resolve('description'),
      // The cast is gone with F2: the contract now declares `notComputed`, so tsc
      // sees a new state instead of the producer asserting its way past it.
      readiness: { state: (row?.state as CatalogLanguageProjection['readiness']['state'] | undefined) ?? 'notComputed', pct: row?.pct ?? null, computedAt: row?.computedAt.toISOString() ?? null },
      fallsBackToSource: row ? indexFallsBack(row.missing) : null }]
  }))
}

export async function orderCatalogLanguage(q: ProductListQuery, where: Prisma.ProductWhereInput, offset: number, limit: number): Promise<string[]> {
  const candidates = await prisma.product.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })
  if (!candidates.length) return []
  const sort = q.languageSort!, dir = sort.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`
  if (sort.field === 'readiness' || sort.field === 'fallback') {
    // LX.F F6 — severity, not the alphabet. The CASE is BUILT from `SCOPE_STATES`
    // (the one ordered definition), so adding a state cannot leave the sort behind;
    // a state the array does not know sorts last rather than silently first.
    const rank = Prisma.sql`CASE COALESCE(r.state, 'notComputed') ${Prisma.join(SCOPE_STATES.map((state, index) => Prisma.sql`WHEN ${state} THEN ${index}`), ' ')} ELSE ${SCOPE_STATES.length} END`
    const expression = sort.field === 'fallback' ? Prisma.sql`CASE WHEN r.id IS NULL THEN NULL ELSE ${fallbackSql} END` : rank
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p.id FROM "Product" p LEFT JOIN "ReadinessIndex" r ON r."productId"=p.id AND r."workspaceId"=p."workspaceId"
        AND r.channel IS NULL AND r.market IS NULL AND r."accountId" IS NULL AND r."aliasId" IS NULL AND r.language=${q.language!}
      WHERE p.id IN (${Prisma.join(candidates.map(p => p.id))}) ORDER BY ${expression} ${dir} NULLS LAST, p.id ASC LIMIT ${limit} OFFSET ${offset}`)
    return rows.map(row => row.id)
  }
  // LX.F2 R-LX-17 (LX.R P2-21) — ONE `ORDER BY` on the materialised projection.
  //
  // This used to re-read every FILTERED product in 100-row batches, each read pulling the product,
  // its `translations` and its parent's, and run the resolver over all of them, to order fifty rows:
  // measured on the local catalogue at 360 products, warm, `title@de` **101.7 ms** and
  // `description@de` **86.0 ms** per page — linear in the filtered set, not in the page, so ≈0.85 s
  // at 3,000 products and ≈2.8 s at 10,000. The producer writes `sortTitle` / `sortDescription` from
  // the SAME `resolveContent()` this file's own projection calls, so the order is the resolver's
  // order, read from an index instead of recomputed.
  //
  // 🔴 NULL is NOT COMPUTED and sorts LAST in both directions (`NULLS LAST` on ASC and DESC alike):
  // a row written before the column existed, or a family whose readiness has never been produced,
  // must never be ordered as if it held an empty string — that is R-LX-9's rule, one column over.
  // `COLLATE "C"` is deliberate: Postgres cannot apply the requested language's collation per row,
  // and a stable byte order that matches for every language beats a collation that silently differs
  // from the previous page's.
  const column = sort.field === 'title' ? Prisma.sql`r."sortTitle"` : Prisma.sql`r."sortDescription"`
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT p.id FROM "Product" p LEFT JOIN "ReadinessIndex" r ON r."productId"=p.id AND r."workspaceId"=p."workspaceId"
      AND r.channel IS NULL AND r.market IS NULL AND r."accountId" IS NULL AND r."aliasId" IS NULL AND r.language=${q.language!}
    WHERE p.id IN (${Prisma.join(candidates.map(p => p.id))})
    ORDER BY ${column} COLLATE "C" ${dir} NULLS LAST, p.id ASC LIMIT ${limit} OFFSET ${offset}`)
  return rows.map(row => row.id)
}
