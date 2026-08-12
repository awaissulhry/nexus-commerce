/**
 * KT.2 — the Keyword Tracker's watchlist: the terms an operator chose to watch, per market.
 *
 * 🔴 Read this before touching anything named `KeywordCoverage*`. That table is the ACR coverage
 * engine's ARMING SWITCH, not a list. Measured on prod 2026-08-12:
 *
 *   · `ads-coverage-engine.service.ts:172` selects `{ enabled: true }` sets and, at
 *     `NEXUS_COVERAGE_ENGINE_MODE=auto`, steps their keyword bids through `updateAdTargetWithSync`
 *     — the real write path to Amazon;
 *   · that engine is **scheduled daily at 07:10** (`ads-sync.job.ts:798`) and has **run six
 *     nights**, every one `mode=observe sets=0`. It writes nothing today only because the single
 *     existing set is disabled;
 *   · all 97 of that set's terms already carry a `leadAsin` — the engine's precondition for
 *     acting on a term;
 *   · `PATCH /advertising/coverage-sets/:id { enabled }` is wired to a button on the Family
 *     Cockpit page.
 *
 * So this service reads coverage sets as an **import source only** (`importFromCoverageSet` COPIES
 * terms; it never references a set), writes nothing back to them, and this entity has no `enabled`
 * column for anything to mistake for one. `ads-coverage-sets.service.ts` remains the only writer
 * of those tables — verified by grep, four write calls, one file.
 */
import prisma from '../../db.js'

/** Lowercased, whitespace-collapsed. The same normalisation `AdKeywordProtection` stores and the
 *  same the tracker joins SQP on, so a stored term can never disagree with the join. */
export const normTerm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export const KT_WATCHLIST_MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

export interface ProtectionRule {
  term: string
  /** EXACT | PREFIX | CONTAINS. Null falls back to `isPrefix`, as the column's own doc says. */
  matchType: string | null
  isPrefix: boolean
  /** null = every marketplace */
  marketplace: string | null
}

/**
 * Is this term one of OUR brand terms, in this market?
 *
 * KT.1 answered with `protectedTerms.some((p) => term.includes(p))` — a blanket substring sweep
 * that ignored both `matchType` and the nullable `marketplace`. Measured 2026-08-12: all ten
 * protections are `CONTAINS` with `marketplace = null`, so the sweep is **accidentally correct
 * today** and honouring the columns changes zero classifications in all four markets. It is
 * honoured anyway, because the sweep is right by coincidence and the coincidence is one row away
 * from ending: a single `EXACT` protection on a common word would mis-flag every term containing
 * it, and this classifier also seeds a STORED flag, so a wrong answer would persist rather than
 * be recomputed away.
 */
export function classifyBranded(term: string, market: string, protections: ProtectionRule[]): boolean {
  const t = normTerm(term)
  return protections.some((p) => {
    if (p.marketplace && p.marketplace !== market) return false
    const needle = normTerm(p.term)
    if (!needle) return false
    const mt = (p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')).toUpperCase()
    if (mt === 'EXACT') return t === needle
    if (mt === 'PREFIX') return t.startsWith(needle)
    return t.includes(needle)
  })
}

async function protectionsFor(market: string): Promise<ProtectionRule[]> {
  return prisma.adKeywordProtection.findMany({
    where: { mode: 'WHITELIST' },
    select: { term: true, matchType: true, isPrefix: true, marketplace: true },
  }).then((rows) => rows.filter((r) => !r.marketplace || r.marketplace === market))
}

export interface WatchlistSummary {
  id: string
  marketplace: string
  name: string
  isDefault: boolean
  source: string
  terms: number
  brandedTerms: number
  updatedAt: string
}

const summarise = (w: {
  id: string; marketplace: string; name: string; isDefault: boolean; source: string; updatedAt: Date
  terms: Array<{ isBranded: boolean }>
}): WatchlistSummary => ({
  id: w.id,
  marketplace: w.marketplace,
  name: w.name,
  isDefault: w.isDefault,
  source: w.source,
  terms: w.terms.length,
  brandedTerms: w.terms.filter((t) => t.isBranded).length,
  updatedAt: w.updatedAt.toISOString(),
})

/** Every list, or one market's. Ordered default-first so a picker's first row is the live one. */
export async function listWatchlists(market?: string | null): Promise<WatchlistSummary[]> {
  const rows = await prisma.keywordWatchlist.findMany({
    where: market ? { marketplace: market } : {},
    select: {
      id: true, marketplace: true, name: true, isDefault: true, source: true, updatedAt: true,
      terms: { select: { isBranded: true } },
    },
    orderBy: [{ marketplace: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
  })
  return rows.map(summarise)
}

/**
 * The list a market opens on, or null.
 *
 * 🔴 There is deliberately **no cross-market fallback**. KT.1's
 * `sets.find((s) => s.marketplace === market) ?? sets[0]` is the defect this whole build exists to
 * remove: it served 97 Italian terms to DE, ES and FR, of which only 8 / 3 / 3 have ever had a row
 * in those markets. A market with no list must say it has no list.
 */
export async function resolveWatchlist(market: string, requestedId?: string | null) {
  if (requestedId) {
    const w = await prisma.keywordWatchlist.findUnique({
      where: { id: requestedId },
      select: { id: true, marketplace: true, name: true, isDefault: true, source: true },
    })
    // A list from another market is refused rather than silently honoured — the same rule the
    // scope spine applies to a campaign id from the wrong market.
    if (w && w.marketplace === market) return w
    if (w) return null
  }
  return prisma.keywordWatchlist.findFirst({
    where: { marketplace: market },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, marketplace: true, name: true, isDefault: true, source: true },
  })
}

export async function watchlistTerms(watchlistId: string) {
  return prisma.keywordWatchlistTerm.findMany({
    where: { watchlistId },
    select: { id: true, term: true, isBranded: true, addedFrom: true, notes: true },
    orderBy: { term: 'asc' },
  })
}

export async function createWatchlist(args: {
  marketplace: string; name: string; source?: string; isDefault?: boolean; createdBy?: string | null
}): Promise<WatchlistSummary> {
  const w = await prisma.keywordWatchlist.create({
    data: {
      marketplace: args.marketplace,
      name: args.name.trim(),
      source: args.source ?? 'manual',
      isDefault: false,
      createdBy: args.createdBy ?? null,
    },
    select: { id: true, marketplace: true, name: true, isDefault: true, source: true, updatedAt: true, terms: { select: { isBranded: true } } },
  })
  // First list in a market becomes its default automatically: a market with lists but no default
  // would fall through `resolveWatchlist`'s ordering silently.
  const count = await prisma.keywordWatchlist.count({ where: { marketplace: args.marketplace } })
  if (args.isDefault || count === 1) await setDefaultWatchlist(w.id)
  return summarise({ ...w, isDefault: args.isDefault || count === 1 })
}

/** Exactly one default per market — set in a transaction so no market can end up with two. */
export async function setDefaultWatchlist(id: string): Promise<void> {
  const w = await prisma.keywordWatchlist.findUnique({ where: { id }, select: { marketplace: true } })
  if (!w) throw new Error('watchlist not found')
  await prisma.$transaction([
    prisma.keywordWatchlist.updateMany({ where: { marketplace: w.marketplace }, data: { isDefault: false } }),
    prisma.keywordWatchlist.update({ where: { id }, data: { isDefault: true } }),
  ])
}

export async function renameWatchlist(id: string, name: string): Promise<void> {
  await prisma.keywordWatchlist.update({ where: { id }, data: { name: name.trim() } })
}

/**
 * Delete a list and its terms. Returns what was destroyed so the caller can say it.
 *
 * If the deleted list was its market's default, the oldest remaining list in that market takes
 * over — a market with lists and no default renders as a market with no list at all.
 */
export async function deleteWatchlist(id: string): Promise<{ name: string; marketplace: string; terms: number; promoted: string | null }> {
  const w = await prisma.keywordWatchlist.findUnique({
    where: { id },
    select: { id: true, name: true, marketplace: true, isDefault: true, terms: { select: { id: true } } },
  })
  if (!w) throw new Error('watchlist not found')
  await prisma.keywordWatchlist.delete({ where: { id } })
  let promoted: string | null = null
  if (w.isDefault) {
    const next = await prisma.keywordWatchlist.findFirst({
      where: { marketplace: w.marketplace }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true },
    })
    if (next) { await setDefaultWatchlist(next.id); promoted = next.name }
  }
  return { name: w.name, marketplace: w.marketplace, terms: w.terms.length, promoted }
}

export interface AddTermsResult {
  added: number
  duplicates: number
  invalid: number
  branded: number
  /** the terms actually written, normalised */
  terms: string[]
}

/**
 * Paste-a-list: normalise, dedupe within the paste AND against the list, classify branded, insert.
 *
 * `createMany` + `skipDuplicates` would hide the count the operator needs ("14 added, 3 already
 * there"), so the existing terms are read first and the difference is reported.
 */
export async function addTerms(args: {
  watchlistId: string; terms: string[]; addedFrom?: string | null
}): Promise<AddTermsResult> {
  const list = await prisma.keywordWatchlist.findUnique({
    where: { id: args.watchlistId }, select: { id: true, marketplace: true },
  })
  if (!list) throw new Error('watchlist not found')

  const raw = args.terms.flatMap((t) => String(t).split(/[\n\r,;\t]+/))
  const normalised = raw.map(normTerm).filter(Boolean)
  const invalid = raw.length - normalised.length
  const unique = [...new Set(normalised)]

  const existing = new Set(
    (await prisma.keywordWatchlistTerm.findMany({ where: { watchlistId: list.id }, select: { term: true } }))
      .map((t) => t.term),
  )
  const fresh = unique.filter((t) => !existing.has(t))
  const protections = await protectionsFor(list.marketplace)

  if (fresh.length) {
    await prisma.keywordWatchlistTerm.createMany({
      data: fresh.map((term) => ({
        watchlistId: list.id,
        term,
        isBranded: classifyBranded(term, list.marketplace, protections),
        addedFrom: args.addedFrom ?? null,
      })),
      skipDuplicates: true,
    })
    await prisma.keywordWatchlist.update({ where: { id: list.id }, data: { updatedAt: new Date() } })
  }

  return {
    added: fresh.length,
    duplicates: unique.length - fresh.length,
    invalid,
    branded: fresh.filter((t) => classifyBranded(t, list.marketplace, protections)).length,
    terms: fresh,
  }
}

export async function removeTerms(watchlistId: string, termIds: string[]): Promise<{ removed: number }> {
  const r = await prisma.keywordWatchlistTerm.deleteMany({ where: { watchlistId, id: { in: termIds } } })
  if (r.count) await prisma.keywordWatchlist.update({ where: { id: watchlistId }, data: { updatedAt: new Date() } })
  return { removed: r.count }
}

/** Flip one term's branded flag. The operator owns the classification once it is stored. */
export async function setTermBranded(watchlistId: string, termId: string, isBranded: boolean): Promise<void> {
  await prisma.keywordWatchlistTerm.updateMany({ where: { id: termId, watchlistId }, data: { isBranded } })
}

/**
 * COPY the terms of a `KeywordCoverageSet` into a watchlist.
 *
 * Copy, never reference — see the file header. Nothing here writes to the coverage tables, and the
 * copy carries no `leadAsin` / `targetSharePct` / cap, because those are the engine's intent and
 * this list is not the engine's.
 */
export async function importFromCoverageSet(args: {
  watchlistId: string; coverageSetId: string
}): Promise<AddTermsResult & { setName: string }> {
  const set = await prisma.keywordCoverageSet.findUnique({
    where: { id: args.coverageSetId },
    select: { id: true, name: true, marketplace: true, terms: { select: { term: true } } },
  })
  if (!set) throw new Error('coverage set not found')
  const res = await addTerms({
    watchlistId: args.watchlistId,
    terms: set.terms.map((t) => t.term),
    addedFrom: `coverage-set:${set.name}`,
  })
  return { ...res, setName: set.name }
}

/** Coverage sets offered as import sources. `enabled` is NOT returned — see the file header. */
export async function coverageSetsAsImportSources(market?: string | null) {
  const rows = await prisma.keywordCoverageSet.findMany({
    where: market ? { marketplace: market } : {},
    select: { id: true, name: true, marketplace: true, _count: { select: { terms: true } } },
    orderBy: { name: 'asc' },
  })
  return rows.map((r) => ({ id: r.id, name: r.name, marketplace: r.marketplace, terms: r._count.terms }))
}
