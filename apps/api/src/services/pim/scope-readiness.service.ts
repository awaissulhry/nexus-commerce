import type { ReadinessIndex } from '@prisma/client'
import prisma from '../../db.js'
import { readFamilyAccountId } from './family-account.js'
import { resolveWorkspaceDestination } from './workspace-destination.js'
import { coordinatesFor } from './sheet-columns.service.js'
import { normalizeLanguage } from './content-language.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { readinessLanguages, readinessCoordinateKey, type ProductReadiness, type ReadinessCoordinate, type ReadinessMatrixEntry, type MissingReadinessField, type OptionalEmptyField, type ScopeReadiness } from './readiness-model.js'
export { readinessFromSheet } from './readiness-model.js'
export type { ScopeReadiness, ScopeState, ProductReadiness, ReadinessMatrixEntry } from './readiness-model.js'

/**
 * LX.FIN (R-LX-22) — the return type is the matrix entry WITHOUT `byProduct`: the per-product breakdown is
 * the matrix's business (it feeds the master sheet's per-coordinate ROW cells), and a scope chip has no use
 * for it. Declaring it here instead would put one entry per family product on every scope chip in the
 * response for nothing.
 */
export function summarizeReadinessIndex(rows: ReadinessIndex[], c: ReadinessCoordinate, language: string, label: string): Omit<ReadinessMatrixEntry, 'byProduct'> {
  const required = rows.reduce((sum, r) => ({ filled: sum.filled + r.requiredFilled, total: sum.total + r.requiredTotal }), { filled: 0, total: 0 })
  const unscorable = !rows.length || rows.some(r => r.pct === null) || !required.total
  const notes = [...new Set(rows.filter(r => r.pct === null).map(r => r.note).filter((n): n is string => !!n))]
  // Progress columns — one row without the optional counts makes the whole sum unknown, never a smaller known number.
  const optionalRecorded = rows.length > 0 && rows.every(r => r.optionalTotal != null && r.optionalFilled != null)
  const optional = optionalRecorded ? rows.reduce((sum, r) => ({ filled: sum.filled + (r.optionalFilled ?? 0), total: sum.total + (r.optionalTotal ?? 0) }), { filled: 0, total: 0 }) : null
  return { channel: c.channel, market: c.market, accountId: c.accountId, aliasId: c.aliasId, coordinateKey: readinessCoordinateKey(c), language, id: c.channel ?? 'master', label, required,
    pct: unscorable ? null : Math.round(100 * required.filled / required.total),
    // R-LX-9: no rows for this coordinate and language is NOT computed. It used
    // to answer `absent`, which is the word for "nothing is set up here" — so an
    // index that has never been built (production: 0 rows) was indistinguishable
    // from a scope an operator had deliberately left empty.
    state: !rows.length ? 'notComputed' : rows.some(r => r.state === 'blocked') ? 'blocked' : rows.some(r => r.state === 'absent') ? 'absent' : rows.some(r => r.state === 'warn') ? 'warn' : 'ready',
    note: !rows.length ? 'Readiness has not been computed for this language.' : notes.length ? notes.join(' · ') : `${required.filled} of ${required.total} required values filled across this scope. Information completeness does not establish publication eligibility or provider acceptance.`,
    aliasCount: new Set(rows.map(r => r.aliasId).filter(Boolean)).size,
    mappingRules: c.channel ? Math.max(0, ...rows.map(r => r.mappingRules ?? 0)) : null,
    missing: rows.flatMap(r => r.missing as unknown as MissingReadinessField[]),
    optional,
    optionalMissing: optionalRecorded ? rows.flatMap(r => ((r.optionalMissing ?? []) as unknown as Array<{ field: string; label: string }>)
      .map((m): OptionalEmptyField => ({ productId: r.productId, field: m.field, label: m.label }))) : [],
    computedAt: rows.length ? new Date(Math.min(...rows.map(r => r.computedAt.getTime()))).toISOString() : null,
    // P2 — any pending row makes the whole verdict provisional; the earliest mark says since when.
    ...(rows.some(r => r.pendingSince) ? { pendingSince: new Date(Math.min(...rows.filter(r => r.pendingSince).map(r => r.pendingSince!.getTime()))).toISOString() } : {}),
    // VT.4b — the provenance VT.1b's producer stamps, read back. The FIRST non-null across this coordinate's
    // rows: a coordinate groups the parent with its children, and a child has no projection, so it is NULL by
    // design. `null` therefore means "no row here carried a provenance" = NOT COMPUTED, never `derived`.
    variationSource: (rows.map(r => (r as { variationSource?: string | null }).variationSource ?? null)
      .find((v): v is 'derived' | 'rule' | 'overridden' | 'none' => v !== null) ?? null),
  }
}

/** `onlyCoordinate` was asked without the coordinate it names. */
export class ReadinessCoordinateRequiredError extends Error {
  readonly code = 'coordinate_required'
  readonly statusCode = 400
  constructor() { super('only=coordinate needs channel, market and accountId (or a listing that names its account).') }
}

/**
 * Read only the materialized index and destination identity; never construct a sheet here.
 *
 * P2 (2026-09-30) — `onlyCoordinate`: the answer holds only the named channel coordinate (its account, and its listing
 * alias when the destination names one): its scope chip in `scopes` and its entries, every language, in `matrix`.
 * The chip leaves out `missing` / `optionalMissing`, the lists its matrix entry carries (the chip parser reads neither).
 * Measured on GALE-JACKET · eBay · IT: the family-wide answer was 13.1 MB, every coordinate of the family.
 */
export async function getProductReadiness(input: { productId: string; market: string; channel?: string; accountId?: string; selectedOnly?: boolean; listingId?: string; locale?: string; onlyCoordinate?: boolean }): Promise<ProductReadiness> {
  const market = input.market.toUpperCase()
  const locale = normalizeLanguage(input.locale ?? PRIMARY_CONTENT_LOCALE)
  if (input.onlyCoordinate && (!input.channel || !(input.accountId || input.listingId))) throw new ReadinessCoordinateRequiredError()
  const destination = input.channel ? await resolveWorkspaceDestination({ productId: input.productId, channel: input.channel, marketplace: market, accountId: input.accountId, listingId: input.listingId }) : null
  const only = input.onlyCoordinate ? { channel: input.channel!.toUpperCase(), accountId: destination?.accountId ?? input.accountId ?? null, aliasId: destination?.aliasKey ?? null } : null
  if (only && !only.accountId) throw new ReadinessCoordinateRequiredError()
  const product = await prisma.product.findFirstOrThrow({ where: { id: input.productId, deletedAt: null }, select: { id: true, parentId: true } })
  const rootId = product.parentId ?? product.id
  const [familyRows, markets] = await Promise.all([
    prisma.readinessIndex.findMany({ where: { product: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null },
      ...(only ? { channel: only.channel, accountId: only.accountId, ...(only.aliasId !== null ? { aliasId: only.aliasId } : {}) } : {}) },
    orderBy: [{ coordinateKey: 'asc' }, { language: 'asc' }, { productId: 'asc' }] }),
    prisma.marketplace.findMany({ where: { isActive: true }, orderBy: [{ channel: 'asc' }, { code: 'asc' }], select: { channel: true, code: true, name: true, languages: true, language: true } }),
  ])
  const onlyCoordinate = only ? coordinatesFor(market, markets, { only: [only.channel] })[0] : undefined
  if (only && !onlyCoordinate) throw new ReadinessCoordinateRequiredError()
  const rows = onlyCoordinate ? familyRows.filter(r => r.market === onlyCoordinate.marketplace) : familyRows
  const groups = new Map<string, ReadinessIndex[]>()
  for (const row of rows) { const key = JSON.stringify([row.coordinateKey, row.language]); const group = groups.get(key) ?? []; group.push(row); groups.set(key, group) }
  const languages = readinessLanguages(markets)
  /**
   * LX.FIN (R-LX-22) — the coordinate's verdict, PLUS the same verdict per product in the family.
   *
   * `ReadinessIndex` is keyed `(productId, coordinateKey, language)`, so the per-product answer is this
   * group filtered by product id and handed to the SAME `summarizeReadinessIndex` — one summariser, no second
   * rule, and no mapping between the two readiness vocabularies (PES.0 #3). It exists because the master
   * sheet's per-coordinate readiness columns (design §8 LX.15) are per-ROW cells and had nothing true to put
   * in them: they were fed only on the retired `adaptLegacySheet` path, in the ROW vocabulary.
   *
   * A product with no row for this coordinate is deliberately NOT a key here — the cell then says
   * `Not computed` rather than a score, which is R-LX-9's rule one column over.
   */
  const perProduct = (group: ReadinessIndex[], c: ReadinessCoordinate, language: string, label: string) =>
    Object.fromEntries([...new Set(group.map(row => row.productId))].map(productId => {
      const one = summarizeReadinessIndex(group.filter(row => row.productId === productId), c, language, label)
      // A-45 — the product's own required counts and age, so its completeness card can say "18 of 22" and "computed 6 h ago".
      return [productId, { state: one.state, pct: one.pct, ...(one.note ? { note: one.note } : {}), required: one.required, optional: one.optional, computedAt: one.computedAt, ...(one.pendingSince ? { pendingSince: one.pendingSince } : {}) }]
    }))
  const matrix = [...groups.values()].map(group => ({
    ...summarizeReadinessIndex(group, group[0], group[0].language, group[0].label),
    byProduct: perProduct(group, group[0], group[0].language, group[0].label),
  })).sort((a, b) =>
    Number(!!a.channel) - Number(!!b.channel) || a.coordinateKey.localeCompare(b.coordinateKey) || languages.indexOf(a.language) - languages.indexOf(b.language))
  const shared: ReadinessCoordinate = { channel: null, market: null, accountId: null, aliasId: null }
  const languageSummaries = (candidates: ReadinessIndex[], c: ReadinessCoordinate, label: string) => [...new Set(candidates.map(r => r.language))].map(language => {
    const result = summarizeReadinessIndex(candidates.filter(r => r.language === language), c, language, label)
    return { language, pct: result.pct, state: result.state }
  })
  const scopes: ScopeReadiness[] = []
  if (!onlyCoordinate) {
    const master = summarizeReadinessIndex(rows.filter(r => !r.channel && r.language === locale), shared, locale, 'Shared product')
    master.languages = languageSummaries(rows.filter(r => !r.channel), shared, 'Shared product')
    scopes.push(master)
  }
  for (const coordinate of onlyCoordinate ? [onlyCoordinate] : coordinatesFor(market, markets, input.selectedOnly ? { only: input.channel ? [input.channel] : [] } : {})) {
    let accountId: string | null = null
    let unavailable: string | undefined
    try { accountId = coordinate.channel === input.channel ? destination?.accountId ?? input.accountId ?? null : await readFamilyAccountId(rootId, coordinate.channel, coordinate.marketplace) }
    catch (error) { unavailable = error instanceof Error ? error.message : 'Choose an account for this destination.' }
    const aliasId = coordinate.channel === input.channel ? destination?.aliasKey ?? null : null
    const candidates = rows.filter(r => r.channel === coordinate.channel && r.market === coordinate.marketplace && r.accountId === accountId && r.language === locale && (aliasId === null || r.aliasId === aliasId))
    const summary = summarizeReadinessIndex(candidates, { channel: coordinate.channel, market: coordinate.marketplace, accountId, aliasId }, locale, coordinate.label)
    if (unavailable) { summary.pct = null; summary.state = 'absent'; summary.note = unavailable }
    summary.languages = languageSummaries(rows.filter(r => r.channel === coordinate.channel && r.market === coordinate.marketplace && r.accountId === accountId && (aliasId === null || r.aliasId === aliasId)), summary, coordinate.label)
    if (onlyCoordinate) { delete (summary as Partial<typeof summary>).missing; delete (summary as Partial<typeof summary>).optionalMissing }
    scopes.push(summary)
  }
  return { market, locale, scopes, matrix, computedAt: rows.length ? new Date(Math.min(...rows.map(r => r.computedAt.getTime()))).toISOString() : new Date().toISOString() }
}
