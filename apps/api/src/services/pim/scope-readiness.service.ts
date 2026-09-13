import type { ReadinessIndex } from '@prisma/client'
import prisma from '../../db.js'
import { readFamilyAccountId } from './family-account.js'
import { resolveWorkspaceDestination } from './workspace-destination.js'
import { coordinatesFor } from './sheet-columns.service.js'
import { normalizeLanguage } from './content-language.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { readinessLanguages, readinessCoordinateKey, type ProductReadiness, type ReadinessCoordinate, type ReadinessMatrixEntry, type MissingReadinessField, type ScopeReadiness } from './readiness-model.js'
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
    computedAt: rows.length ? new Date(Math.min(...rows.map(r => r.computedAt.getTime()))).toISOString() : null,
    // VT.4b — the provenance VT.1b's producer stamps, read back. The FIRST non-null across this coordinate's
    // rows: a coordinate groups the parent with its children, and a child has no projection, so it is NULL by
    // design. `null` therefore means "no row here carried a provenance" = NOT COMPUTED, never `derived`.
    variationSource: (rows.map(r => (r as { variationSource?: string | null }).variationSource ?? null)
      .find((v): v is 'derived' | 'rule' | 'overridden' | 'none' => v !== null) ?? null),
  }
}

/** Read only the materialized index and destination identity; never construct a sheet here. */
export async function getProductReadiness(input: { productId: string; market: string; channel?: string; accountId?: string; selectedOnly?: boolean; listingId?: string; locale?: string }): Promise<ProductReadiness> {
  const market = input.market.toUpperCase()
  const locale = normalizeLanguage(input.locale ?? PRIMARY_CONTENT_LOCALE)
  const destination = input.channel ? await resolveWorkspaceDestination({ productId: input.productId, channel: input.channel, marketplace: market, accountId: input.accountId, listingId: input.listingId }) : null
  const product = await prisma.product.findFirstOrThrow({ where: { id: input.productId, deletedAt: null }, select: { id: true, parentId: true } })
  const rootId = product.parentId ?? product.id
  const [rows, markets] = await Promise.all([
    prisma.readinessIndex.findMany({ where: { product: { OR: [{ id: rootId }, { parentId: rootId }], deletedAt: null } }, orderBy: [{ coordinateKey: 'asc' }, { language: 'asc' }, { productId: 'asc' }] }),
    prisma.marketplace.findMany({ where: { isActive: true }, orderBy: [{ channel: 'asc' }, { code: 'asc' }], select: { channel: true, code: true, name: true, languages: true, language: true } }),
  ])
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
      return [productId, { state: one.state, pct: one.pct, ...(one.note ? { note: one.note } : {}) }]
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
  const master = summarizeReadinessIndex(rows.filter(r => !r.channel && r.language === locale), shared, locale, 'Shared product')
  master.languages = languageSummaries(rows.filter(r => !r.channel), shared, 'Shared product')
  const scopes: ScopeReadiness[] = [master]
  for (const coordinate of coordinatesFor(market, markets, input.selectedOnly ? { only: input.channel ? [input.channel] : [] } : {})) {
    let accountId: string | null = null
    let unavailable: string | undefined
    try { accountId = coordinate.channel === input.channel ? destination?.accountId ?? input.accountId ?? null : await readFamilyAccountId(rootId, coordinate.channel, coordinate.marketplace) }
    catch (error) { unavailable = error instanceof Error ? error.message : 'Choose an account for this destination.' }
    const aliasId = coordinate.channel === input.channel ? destination?.aliasKey ?? null : null
    const candidates = rows.filter(r => r.channel === coordinate.channel && r.market === coordinate.marketplace && r.accountId === accountId && r.language === locale && (aliasId === null || r.aliasId === aliasId))
    const summary = summarizeReadinessIndex(candidates, { channel: coordinate.channel, market: coordinate.marketplace, accountId, aliasId }, locale, coordinate.label)
    if (unavailable) { summary.pct = null; summary.state = 'absent'; summary.note = unavailable }
    summary.languages = languageSummaries(rows.filter(r => r.channel === coordinate.channel && r.market === coordinate.marketplace && r.accountId === accountId && (aliasId === null || r.aliasId === aliasId)), summary, coordinate.label)
    scopes.push(summary)
  }
  return { market, locale, scopes, matrix, computedAt: rows.length ? new Date(Math.min(...rows.map(r => r.computedAt.getTime()))).toISOString() : new Date().toISOString() }
}
