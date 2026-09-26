import type { Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'node:async_hooks'
import prisma from '../../db.js'
import { afterDatabaseCommit, beforeDatabaseCommit, dropBeforeDatabaseCommit, hasBeforeDatabaseCommit, inDatabaseTransaction } from '../../lib/database-context.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { withCachedSchemas } from './cached-schema-context.js'
// LX.F2 R-LX-17 — the ONE resolver, the same function the catalogue projection calls.
import { resolveContent } from './content-resolver.js'
import { marketLanguages } from './market-languages.js'
import { coordinatesFor, VARIATION_THEME_KEY } from './sheet-columns.service.js'
// VT.1b — the provenance mapper and the cell type live with the resolver; this file only reads them.
import { variationSourceFor, type VariationThemeCell } from './variation-rules.service.js'
import { readinessLanguages, readinessCoordinateKey, readinessFromSheet, readinessMissingEntries, requirementSources, type ReadinessCoordinate } from './readiness-model.js'
import { runResumableSweep, type SweepReport } from './resumable-sweep.js'
import { logger } from '../../utils/logger.js'
import { channelFootprint, type ChannelFootprint } from '../channel-footprint.service.js'

export type ReadinessScope = { channel: string; market: string; accountId: string | null }

const producerKey = (rootId: string, scope?: ReadinessScope) => `readiness:${rootId}${scope ? `:${JSON.stringify(scope)}` : ''}`

const deferredFamilies = new AsyncLocalStorage<Set<string>>()
/**
 * PSIE (the Owner's choice, 2026-09-26) — inside `work`, a readiness refresh is only NOTED (the family's root id) and
 * never run in the write's transaction. The caller marks the noted families pending in that same transaction
 * (`markReadinessPending`, so no reader shows the old answer as current) and rebuilds each one right after the commit
 * (`rebuildPendingFamily`); the readiness-pending drain finishes any a restart interrupted. Used by the product sheet's
 * import only; every other writer keeps its own readiness path.
 */
export function deferReadiness<T>(families: Set<string>, work: () => Promise<T>): Promise<T> {
  return deferredFamilies.run(families, work)
}

/**
 * One family refresh per outer write, after cascades/formulas and before commit.
 *
 * PSIE — a whole-family refresh covers every coordinate of that family, so inside one transaction a scoped refresh
 * is skipped once the whole family is registered, and registering the whole family drops the scoped ones. A
 * transaction that saves many records of one family (the sheet import) then rebuilds its readiness ONCE.
 */
export async function produceReadiness(productId: string, scope?: ReadinessScope) {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { id: true, parentId: true } })
  const rootId = product.parentId ?? product.id
  const deferred = deferredFamilies.getStore()
  if (deferred) { deferred.add(rootId); return }
  const family = producerKey(rootId)
  if (scope && hasBeforeDatabaseCommit(family)) return
  if (!scope) dropBeforeDatabaseCommit(`${family}:`)
  await beforeDatabaseCommit(producerKey(rootId, scope), () => reconcileFamilyReadiness(rootId, scope))
}

/**
 * 🔴 P2 (docs/attributes/PLAN.md §10.1) — how many families one write may rebuild INSIDE its own transaction.
 *
 * Measured 2026-09-26 on 10,000 products: one family's rebuild = 3.0–5.3 s and ~1,000 statements (21 products × 34
 * destinations, one studio sheet per destination). A bulk edit across 15+ families crossed the 60 s transaction limit
 * and the WHOLE edit was lost (500 products / 24 families and 100 products / 100 families: nothing saved). Up to this
 * many families keep today's behaviour exactly — a single-cell edit still returns with its readiness rebuilt. Above
 * it, the rows are marked pending in the SAME transaction as the values (so no reader can show the old answer as
 * current) and the families are rebuilt after the commit (Owner Decision 2 = A, 2026-09-26).
 */
export const INLINE_READINESS_MAX_FAMILIES = 2

export interface ReadinessProduction {
  /** Families rebuilt inside the caller's transaction. */
  inline: number
  /** Families marked pending and handed to the background rebuild. */
  pending: number
}

/**
 * The batch form of `produceReadiness`: ONE query for the families of every product, then inline or pending.
 * Must run inside the content transaction (like `produceReadiness`), so the pending marks commit with the values.
 */
export async function produceReadinessForProducts(productIds: string[], scope?: ReadinessScope): Promise<ReadinessProduction> {
  if (!productIds.length) return { inline: 0, pending: 0 }
  const rows = await prisma.product.findMany({ where: { id: { in: [...new Set(productIds)] } }, select: { id: true, parentId: true } })
  const roots = [...new Set(rows.map(row => row.parentId ?? row.id))].sort()
  // PSIE — inside `deferReadiness` (the sheet import) the families are only noted, as in `produceReadiness`.
  const deferred = deferredFamilies.getStore()
  if (deferred) { roots.forEach(rootId => deferred.add(rootId)); return { inline: 0, pending: roots.length } }
  if (roots.length <= INLINE_READINESS_MAX_FAMILIES) {
    for (const rootId of roots) await beforeDatabaseCommit(producerKey(rootId, scope), () => reconcileFamilyReadiness(rootId, scope))
    return { inline: roots.length, pending: 0 }
  }
  await markReadinessPending(roots, scope)
  await afterDatabaseCommit(`readiness-pending:${roots.length}:${roots[0]}:${roots[roots.length - 1]}`, () => enqueuePendingReadiness(roots))
  return { inline: 0, pending: roots.length }
}

/**
 * Mark every current readiness row of these families (in `scope`, when given) as pending. One statement.
 * A row that is already pending keeps its EARLIER time, so the drain's oldest-first order stays true.
 * Rows of deleted products are left alone: the rebuild never recreates them, so a mark there would never clear.
 */
/** A pending scope; `accountId` undefined = every account of that channel × market (a channel-rule change). */
export type PendingScope = { channel: string; market: string; accountId?: string | null }

export async function markReadinessPending(rootIds: string[], scope?: PendingScope): Promise<number> {
  if (!rootIds.length) return 0
  // 🔴 Rows are locked in `id` order (the subquery's ORDER BY … FOR UPDATE), so two bulk edits marking overlapping
  // families queue instead of deadlocking. Measured on a real server (readiness-pending-race.vitest.test.ts): against a
  // concurrent rebuild, the UPDATE and the rebuild's DELETE can still deadlock — PostgreSQL kills one, and
  // `inDatabaseTransaction` retries it (a lost race is rolled back whole), so the user's save is never lost.
  if (scope && scope.accountId === undefined) {
    return prisma.$executeRaw`
      UPDATE "ReadinessIndex" SET "pendingSince" = now()
      WHERE id IN (
        SELECT r.id FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
        WHERE p."deletedAt" IS NULL
          AND (p.id = ANY(${rootIds}::text[]) OR p."parentId" = ANY(${rootIds}::text[]))
          AND r."pendingSince" IS NULL
          AND r.channel = ${scope.channel} AND r.market = ${scope.market}
        ORDER BY r.id FOR UPDATE OF r)
    `
  }
  if (scope) {
    return prisma.$executeRaw`
      UPDATE "ReadinessIndex" SET "pendingSince" = now()
      WHERE id IN (
        SELECT r.id FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
        WHERE p."deletedAt" IS NULL
          AND (p.id = ANY(${rootIds}::text[]) OR p."parentId" = ANY(${rootIds}::text[]))
          AND r."pendingSince" IS NULL
          AND r.channel = ${scope.channel} AND r.market = ${scope.market} AND r."accountId" IS NOT DISTINCT FROM ${scope.accountId}
        ORDER BY r.id FOR UPDATE OF r)
    `
  }
  return prisma.$executeRaw`
    UPDATE "ReadinessIndex" SET "pendingSince" = now()
    WHERE id IN (
      SELECT r.id FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
      WHERE p."deletedAt" IS NULL
        AND (p.id = ANY(${rootIds}::text[]) OR p."parentId" = ANY(${rootIds}::text[]))
        AND r."pendingSince" IS NULL
      ORDER BY r.id FOR UPDATE OF r)
  `
}

/**
 * The fast lane: one deduplicated job per family. It runs AFTER the commit, so it must never fail the write that
 * already committed — a skipped or failed enqueue is only latency, because the drain cron finds the pending marks.
 */
async function enqueuePendingReadiness(rootIds: string[]): Promise<void> {
  try {
    const { addJobSafely, readinessQueue } = await import('../../lib/queue.js')
    for (const rootId of rootIds) {
      await addJobSafely(readinessQueue, 'rebuild', { rootId }, { jobId: `readiness:${rootId}` })
    }
  } catch (error) {
    logger.warn('[readiness] pending rebuild not enqueued; the readiness-pending drain will pick it up', {
      families: rootIds.length, error: error instanceof Error ? error.message : String(error),
    })
  }
}

interface PendingFamily { rootId: string; since: Date; scopes: number; shared: boolean; channel: string | null; market: string | null; accountId: string | null }

/** Families with pending rows, OLDEST first, with what the pending rows cover. One grouped query. */
export async function pendingReadinessFamilies(take: number, rootIds?: string[]): Promise<PendingFamily[]> {
  const rows = await prisma.$queryRaw<Array<PendingFamily & { scopes: bigint | number }>>`
    SELECT COALESCE(p."parentId", p.id) AS "rootId", MIN(r."pendingSince") AS "since",
           COUNT(DISTINCT (r.channel, r.market, r."accountId")) AS "scopes", BOOL_OR(r.channel IS NULL) AS "shared",
           MIN(r.channel) AS "channel", MIN(r.market) AS "market", MIN(r."accountId") AS "accountId"
    FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
    WHERE r."pendingSince" IS NOT NULL
      AND (${rootIds ?? null}::text[] IS NULL OR COALESCE(p."parentId", p.id) = ANY(${rootIds ?? null}::text[]))
    GROUP BY 1 ORDER BY 2, 1 LIMIT ${take}
  `
  return rows.map(row => ({ ...row, scopes: Number(row.scopes) }))
}

/**
 * Rebuild one family whose rows are pending. When every pending row is ONE channel coordinate (a listing-only bulk
 * edit), only that coordinate is rebuilt — the same narrowing the inline producer uses. Otherwise the whole family.
 * Returns the rows written; 0 when nothing was pending (another worker got there first).
 */
export async function rebuildPendingFamily(rootId: string): Promise<number> {
  const [pending] = await pendingReadinessFamilies(1, [rootId])
  if (!pending) return 0
  const scope = pending.scopes === 1 && !pending.shared && pending.channel && pending.market
    ? { channel: pending.channel, market: pending.market, accountId: pending.accountId }
    : undefined
  return reconcileFamilyReadiness(rootId, scope)
}

/** How many families have pending rows. Uses the `(workspaceId, pendingSince)` index; cheap when nothing is pending. */
export async function countPendingReadinessFamilies(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT COUNT(DISTINCT COALESCE(p."parentId", p.id)) AS n
    FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId" WHERE r."pendingSince" IS NOT NULL`
  return Number(row?.n ?? 0)
}

/** The drain: oldest pending families first, bounded by a time budget. The cron and a hand run call this. */
export async function drainPendingReadiness(options: { budgetMs?: number; batchSize?: number; now?: () => number } = {}): Promise<SweepReport> {
  return runResumableSweep({
    name: 'readiness-pending',
    budgetMs: options.budgetMs ?? 45_000,
    batchSize: options.batchSize ?? 10,
    dryRun: false,
    nextBatch: async take => (await pendingReadinessFamilies(take)).map(family => family.rootId),
    countOutstanding: countPendingReadinessFamilies,
    apply: rootId => rebuildPendingFamily(rootId),
    ...(options.now ? { now: options.now } : {}),
  })
}

export interface ReadinessDestination { coordinate: ReadinessCoordinate; language: string; label: string }
type DestinationMarket = { channel: string; code: string; name?: string | null; isActive?: boolean; languages?: string[]; language?: string }

/**
 * P3b S2 (docs/attributes/PLAN.md §10.9) — the CHANNEL destinations of a readiness rebuild: one per footprint channel ×
 * market × active account × market language. A market with no active account gets no row (before S2 it got an "absent"
 * row, "No active account for this destination."). The Shared destinations are not here: they stay one per language of
 * every switched-on market, because they hold the catalogue's sort keys.
 *
 * Pure. The rebuild and the footprint check (`reconcileReadinessFootprint`) both read it, so what the check expects is
 * exactly what a rebuild writes — the check can never ask for a row the rebuild cannot produce.
 */
export function readinessChannelDestinations(footprint: ChannelFootprint, markets: readonly DestinationMarket[]): ReadinessDestination[] {
  const out: ReadinessDestination[] = []
  for (const channel of footprint.channels) {
    for (const code of channel.markets) {
      const market = markets.find(m => m.channel === channel.channel && m.code === code)
      const coordinate = market ? coordinatesFor(market.code, [market as never])[0] : undefined
      if (!market || !coordinate) continue
      for (const account of channel.accounts) {
        for (const language of marketLanguages(market.channel, market.code, [market as never])) {
          out.push({ coordinate: { channel: channel.channel, market: code, accountId: account.id, aliasId: null }, language,
            label: `${coordinate.label}${channel.accounts.length > 1 ? ` · ${account.label ?? 'Connected account'}` : ''}` })
        }
      }
    }
  }
  return out
}

const coordinateOf = (row: { channel: string | null; market: string | null; accountId: string | null }) => JSON.stringify([row.channel, row.market, row.accountId])

export interface FootprintReconcile {
  /** Channel coordinates the index held that the footprint no longer has (a disconnected account, an old no-account row). */
  removed: Array<{ channel: string; market: string | null; accountId: string | null; rows: number }>
  /** Footprint coordinates with no row at all (a newly connected account or market). */
  missing: Array<{ channel: string; market: string; accountId: string }>
  /** Families pending after this check marked them (0 when nothing was marked). The drain rebuilds them. */
  markedFamilies: number
}

/**
 * P3b S2 — keep the readiness index in step with the channel footprint, whatever changed it (a connect, a disconnect,
 * a revoked grant, a switched-off market). Runs in the business's context, each minute, before the pending drain:
 *   · rows of a channel coordinate outside the footprint are DELETED — the index is derived, and a rebuild would not
 *     write them; this also clears the old "No active account" rows once;
 *   · a footprint coordinate that has no row at all marks every family's Shared rows pending, so the existing drain
 *     rebuilds them (oldest first) and the new coordinate appears. Only when the business has rows already: a business
 *     never computed is the nightly reconcile's.
 * Cheap when nothing changed: the footprint (2 reads) and one DISTINCT over the `(channel, market, …)` index.
 */
export async function reconcileReadinessFootprint(): Promise<FootprintReconcile> {
  const [markets, footprint, present] = await Promise.all([
    prisma.marketplace.findMany({ where: { isActive: true } }),
    channelFootprint(),
    prisma.readinessIndex.groupBy({ by: ['channel', 'market', 'accountId'], where: { channel: { not: null } }, _count: { _all: true } }),
  ])
  const expected = new Map(readinessChannelDestinations(footprint, markets).map(d => [coordinateOf(d.coordinate), d.coordinate]))
  const have = new Set(present.map(coordinateOf))
  const removed: FootprintReconcile['removed'] = []
  for (const row of present) {
    if (expected.has(coordinateOf(row))) continue
    const deleted = await prisma.readinessIndex.deleteMany({ where: { channel: row.channel, market: row.market, accountId: row.accountId } })
    removed.push({ channel: row.channel!, market: row.market, accountId: row.accountId, rows: deleted.count })
  }
  const missing = [...expected.entries()].filter(([key]) => !have.has(key)).map(([, c]) => ({ channel: c.channel!, market: c.market!, accountId: c.accountId! }))
  let markedFamilies = 0
  if (missing.length) {
    // Shared rows exist for every computed product; marking them makes the drain rebuild the whole family.
    const markedRows = await prisma.$executeRaw`
      UPDATE "ReadinessIndex" SET "pendingSince" = now()
      WHERE id IN (
        SELECT r.id FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
        WHERE p."deletedAt" IS NULL AND r.channel IS NULL AND r."pendingSince" IS NULL
        ORDER BY r.id FOR UPDATE OF r)`
    if (markedRows > 0) markedFamilies = await countPendingReadinessFamilies()
  }
  return { removed, missing, markedFamilies }
}

/** The only materializer. Schema misses are honest absent rows; persistence failures roll back. */
export async function reconcileFamilyReadiness(productId: string, scope?: ReadinessScope): Promise<number> {
  return inDatabaseTransaction(prisma, () => withCachedSchemas(async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { id: true, parentId: true } })
    const rootId = product.parentId ?? product.id
    const [products, markets, footprint] = await Promise.all([
      // LX.F2 R-LX-17 — `translations` + `parent.translations` are loaded HERE, once per family, because the sort
      // projection below must come from the SAME `resolveContent()` call the catalogue's own projection makes
      // (`catalog-language.ts` `catalogLanguageValues`). Deriving it from the sheet cell instead would be a second
      // answer to "what does this cell say", and the two would drift the first time either changed.
      prisma.product.findMany({ where: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null },
        select: { id: true, parentId: true, familyId: true, name: true, description: true, bulletPoints: true, keywords: true, categoryAttributes: true, localizedContent: true,
          translations: true, parent: { select: { id: true, name: true, description: true, bulletPoints: true, keywords: true, categoryAttributes: true, localizedContent: true, translations: true } } } }),
      prisma.marketplace.findMany({ where: { isActive: true }, orderBy: [{ channel: 'asc' }, { code: 'asc' }] }),
      // P3b S2 — the channel destinations follow the business's footprint (active accounts and their markets).
      channelFootprint(),
    ])
    const languages = readinessLanguages(markets)
    // P7 — the family names a `requiredBy` source reads ("Family: Jackets"). One query per rebuild.
    const familyIds = [...new Set(products.map(p => p.familyId).filter((id): id is string => !!id))]
    const familyLabels = new Map(familyIds.length ? (await prisma.productFamily.findMany({ where: { id: { in: familyIds } }, select: { id: true, label: true } })).map(f => [f.id, f.label]) : [])
    const destinations: Array<{ coordinate: ReadinessCoordinate; language: string; label: string }> = languages.map(language => ({
      coordinate: { channel: null, market: null, accountId: null, aliasId: null }, language, label: 'Shared product',
    }))
    destinations.push(...readinessChannelDestinations(footprint, markets))
    const computedAt = new Date()
    /**
     * LX.F2 R-LX-17 — the SORT KEY for `title@<lang>` / `description@<lang>`, from the one resolver.
     * 🔴 It is a sort key, never a content read: nothing may serve these columns as a value. `null` (an
     * unresolvable field, or a language this product has nothing for) stays null so it sorts LAST rather
     * than first, and a description is cut to 512 characters — a sort key's business, not a content
     * decision, and enough that two rows only tie when their first 512 characters are identical.
     */
    const SORT_DESCRIPTION_CHARS = 512
    const sortProjection = (productId: string, language: string) => {
      const product = products.find(row => row.id === productId)
      if (!product) return { sortTitle: null, sortDescription: null }
      const text = (field: 'title' | 'description') => {
        const value = resolveContent({ product: product as never, parent: (product.parent ?? undefined) as never, field, address: { requested: language } }).value
        return typeof value === 'string' && value.length ? value : null
      }
      const description = text('description')
      return { sortTitle: text('title'), sortDescription: description ? description.slice(0, SORT_DESCRIPTION_CHARS) : null }
    }
    const rows: Prisma.ReadinessIndexCreateManyInput[] = []
    for (const { coordinate, language, label } of destinations) {
      // A listing edit cannot change shared content or another account/market.
      // Rebuilding every destination here made imports exceed their transaction deadline.
      if (scope && (coordinate.channel !== scope.channel || coordinate.market !== scope.market || coordinate.accountId !== scope.accountId)) continue
      let sheet: Awaited<ReturnType<typeof getStudioSheet>> | undefined
      let unavailable: string | undefined
      try {
        if (coordinate.channel && !coordinate.accountId) throw new Error('No active account for this destination.')
        sheet = await getStudioSheet({ productId: rootId, scope: coordinate.channel ? 'channel' : 'master', channel: coordinate.channel ?? undefined,
          market: coordinate.market ?? markets.find(m => m.code !== 'GLOBAL')?.code ?? 'IT', locale: language,
          accountId: coordinate.accountId ?? undefined, includeMapping: !!coordinate.channel })
      } catch (error) {
        // Business/schema availability is a readable state. Never swallow database failures.
        if (error instanceof TypeError || error instanceof ReferenceError || (error as { code?: string }).code?.startsWith('P')) throw error
        unavailable = error instanceof Error ? error.message : 'Requirements could not be checked.'
      }
      if (!sheet) {
        for (const product of products) rows.push({ productId: product.id, ...coordinate, coordinateKey: readinessCoordinateKey(coordinate), language, label,
          pct: null, state: 'absent', requiredFilled: 0, requiredTotal: 0, missing: [], note: unavailable, mappingRules: null,
          // R-LX-17 — the sort key does not depend on the sheet, so an unavailable destination still sorts.
          ...sortProjection(product.id, language), computedAt })
        continue
      }
      const market = markets.find(m => m.channel === coordinate.channel && m.code === coordinate.market)
      const columnByKey = new Map(sheet.columns.map(column => [column.key, column]))
      const mapping = market?.schemaMapping as { fields?: Record<string, unknown>; byProductType?: Record<string, Record<string, unknown>> } | null
      for (const row of sheet.rows) {
        const c = { ...coordinate, aliasId: row.aliasId }
        const summary = readinessFromSheet({ ...sheet, rows: [row], aliases: sheet.aliases.filter(a => a.id === row.aliasId) }, coordinate.channel ? new Set([
          ...Object.keys(mapping?.fields ?? {}), ...Object.keys(mapping?.byProductType?.[row.productType ?? ''] ?? {}),
        ]).size : null)
        // LX.F P2-14 — `kind` carries the FACT beside the sentence. Two readers
        // (the SQL filter and the fallback@<lang> projection) matched the prose
        // with `LIKE '%; showing % fallback.'` and `/; showing .+ fallback\.$/`,
        // which disagree on an empty language segment and both go false the day
        // the wording changes. They read this key now.
        // A-45 (Step 4.3 #4) — the same entries, plus every required-and-empty field FLAGGED (`requiredEmpty`),
        // from the set behind `requiredFilled/requiredTotal`, so the completeness card can name them.
        const missing = readinessMissingEntries(row, field => requirementSources(columnByKey.get(field), row, coordinate.channel ? sheet.scope.label : null, id => familyLabels.get(id)))
        // VT.1b (VT.4's request) — the variation-rule PROVENANCE for this coordinate, from the cell the sheet already
        // computed. It is the one thing `missing[].kind` cannot express: a CORRECT mapping raises no readiness item, so
        // `derived` / `rule` / `overridden` are invisible to the filter without a column. `unset` and `collides` stay in
        // `missing[].kind` — one fact, one home. `null` = NOT COMPUTED (a child row has no projection of its own), and it
        // must never be read as `derived`.
        const variationSource = variationSourceFor(
          row.values?.[VARIATION_THEME_KEY]?.value as VariationThemeCell | null | undefined,
        )
        rows.push({ productId: row.id, ...c, coordinateKey: readinessCoordinateKey(c), language, label: row.aliasId ? `${label} · ${sheet.aliases.find(a => a.id === row.aliasId)?.label ?? 'Listing customization'}` : label,
          pct: summary.pct, state: summary.state, requiredFilled: summary.required.filled, requiredTotal: summary.required.total,
          missing: missing as unknown as Prisma.InputJsonValue, note: summary.note, mappingRules: summary.mappingRules, variationSource,
          ...sortProjection(row.id, language), computedAt })
      }
    }
    // Only the derived index is replaced; content, versions and legacy bags are untouched.
    const scopeWhere = scope ? { channel: scope.channel, market: scope.market, accountId: scope.accountId } : {}
    // A concurrent bulk edit marking these rows can deadlock with this DELETE (PostgreSQL picks one victim) or lose a
    // serialization check; either way `inDatabaseTransaction` retries, and the race test proves the end state is PENDING
    // or rebuilt from the edit's data (readiness-pending-race.vitest.test.ts, both orders). An explicit ordered lock
    // here was tried and dropped: it saved the ~1 s deadlock wait but needs raw SQL the import tests' store cannot run.
    await prisma.readinessIndex.deleteMany({ where: { productId: { in: products.map(p => p.id) }, ...scopeWhere } })
    if (rows.length) await prisma.readinessIndex.createMany({ data: rows })
    // P2 — the rows just written are current (pendingSince NULL). A pending mark can survive only on a row this rebuild
    // did not replace (a product deleted after it was marked); clear it in THIS transaction, so a mark is never left
    // behind to be drained forever. A mark set by a write that commits after this snapshot conflicts with this
    // Serializable transaction and is retried, so it is never cleared unseen.
    await prisma.readinessIndex.updateMany({ where: { product: { OR: [{ id: rootId }, { parentId: rootId }] }, pendingSince: { not: null }, ...scopeWhere }, data: { pendingSince: null } })
    return rows.length
  }))
}
