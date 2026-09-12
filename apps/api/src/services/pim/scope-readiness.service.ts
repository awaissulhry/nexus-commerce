import { readFamilyAccountId } from './family-account.js'
import { resolveWorkspaceDestination } from './workspace-destination.js'
/**
 * PES.5 — readiness for EVERY scope of one product, in ONE call.
 *
 * Contract specified by PES.1 in `docs/pes-claims.md` and adopted verbatim, route
 * and all. The scope bar renders a chip per scope; a call per chip would be
 * N round-trips to paint one row of the header, which is exactly the pattern
 * `project_master_sheet_gds4` records as making the older surfaces unusable.
 *
 * The honesty rule is PES.1's and it is the important part:
 *
 *   `pct: null` whenever readiness CANNOT be computed — no cached schema for
 *   the product type, or the channel is not active on this market. The frame
 *   renders `—` plus the note and never derives a percentage in the browser
 *   (feedback_100_percent_honest_ui).
 *
 * Both null cases are reported by the substrate rather than guessed at:
 * `schemaMissing[]` comes back from the column build, and an inactive channel
 * simply produces no coordinate.
 *
 * Cost: one product findMany + one listing findMany + one (5-min cached)
 * column build per channel, then pure work.
 */
import type { StudioSheet } from './studio-sheet.service.js'
import { getInformationSheet as getStudioSheet } from './information-sheet.js'
import { getStudioColumns } from './studio-columns.js'
/** PES.1's four-value scope vocabulary. Deliberately NOT the row-level
 *  `ReadinessState` (`ready|missing|errors|live|unlisted`) — that describes one
 *  listing, this describes a whole scope. Neither is mapped onto the other. */
export type ScopeState = 'ready' | 'warn' | 'blocked' | 'absent'

export interface ScopeReadiness {
  /** `master`, or the channel name (`AMAZON`, `EBAY`, …). */
  id: string
  label: string
  pct: number | null
  required: { filled: number; total: number }
  state: ScopeState
  /** Why `pct` is null, or why the scope is absent. Rendered beside the chip. */
  note?: string
  aliasCount: number
  /** Rules applicable to the selected categories. Explicit listing values can
   * also supply fields without a mapping rule. `null` for Master. */
  mappingRules: number | null
}

export interface ProductReadiness {
  market: string
  locale: string
  scopes: ScopeReadiness[]
  computedAt: string
}

/** Summarize the same rows and validators the editor serves, including listing aliases. */
export function readinessFromSheet(sheet: StudioSheet, mappingRules: number | null): ScopeReadiness {
  const required = sheet.rows.reduce((sum, row) => ({
    filled: sum.filled + row.completeness.required.filled,
    total: sum.total + row.completeness.required.total,
  }), { filled: 0, total: 0 })
  const issues = sheet.rows.flatMap(row => row.readiness.issues)
  const missing = sheet.meta.schemaMissing
  const mappingUnavailable = sheet.scope.kind === 'channel' && (!sheet.meta.mapping || !!sheet.meta.mapping.skippedReason || sheet.meta.mapping.missingProductIds.length > 0)
  const unavailable = missing.length > 0 || required.total === 0 || mappingUnavailable
  return {
    id: sheet.scope.channel ?? 'master', label: sheet.scope.label, required,
    pct: unavailable ? null : Math.round(100 * required.filled / required.total),
    state: issues.some(i => i.severity === 'error') ? 'blocked' : missing.length > 0 || required.total === 0 ? 'absent'
      : mappingUnavailable || issues.length > 0 ? 'warn' : 'ready',
    ...(missing.length ? { note: `Category metadata is incomplete: ${missing.join(', ')}` }
      : mappingUnavailable ? { note: sheet.meta.mapping?.skippedReason ?? 'Channel mapping values have not been fully checked' }
      : required.total === 0 ? { note: 'No required attributes are defined for this scope' }
      : { note: `${required.filled} of ${required.total} required values filled across this scope. Row completeness also includes optional attributes. Information completeness does not establish publication eligibility or provider acceptance.` }),
    aliasCount: sheet.aliases.filter(alias => alias.id !== null).length,
    mappingRules,
  }
}

export async function getProductReadiness(input: { productId: string; market: string; channel?: string; accountId?: string; selectedOnly?: boolean; listingId?: string; locale?: string }): Promise<ProductReadiness> {
  const market = input.market.toUpperCase()
  const { default: prisma } = await import('../../db.js')
  const destination = input.channel ? await resolveWorkspaceDestination({ productId: input.productId, channel: input.channel, marketplace: market, accountId: input.accountId, listingId: input.listingId }) : null
  const master = await getStudioSheet({ ...input, market, scope: 'master', includeMapping: false })
  const [set, mappings] = await Promise.all([
    getStudioColumns({ market, productTypes: [...new Set(master.rows.map(row => row.productType).filter((v): v is string => !!v))], includeEmptyChannels: true }),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, schemaMapping: true } }),
  ])
  const coordinates = input.selectedOnly ? set.coordinates.filter(coordinate => coordinate.channel === input.channel) : set.coordinates
  const sheets = await Promise.allSettled(coordinates.map(async coordinate => getStudioSheet({
    productId: input.productId, market: coordinate.marketplace, locale: input.locale, scope: 'channel', channel: coordinate.channel,
    accountId: coordinate.channel === input.channel ? destination?.accountId ?? input.accountId : await readFamilyAccountId(input.productId, coordinate.channel, coordinate.marketplace),
  })))
  const scopes = [readinessFromSheet(master, null)]
  for (const [index, result] of sheets.entries()) {
    if (result.status === 'rejected') {
      const coordinate = coordinates[index]
      scopes.push({ id: coordinate.channel, label: coordinate.label, pct: null, required: { filled: 0, total: 0 },
        state: 'absent', aliasCount: 0, mappingRules: null,
        note: result.reason instanceof Error ? result.reason.message : 'Requirements could not be checked for this destination.' })
      continue
    }
    const enriched = result.value
    const sheet = enriched.scope.channel === input.channel && destination?.aliasKey !== null && destination?.aliasKey !== undefined ? { ...enriched, rows: enriched.rows.filter(row => (row.aliasId ?? '') === destination.aliasKey), aliases: enriched.aliases.filter(alias => (alias.id ?? '') === destination.aliasKey) } : enriched
    const mapping = mappings.find(m => m.channel === sheet.scope.channel && m.code === sheet.scope.marketplace)
    const rules = (mapping?.schemaMapping ?? {}) as { fields?: Record<string, unknown>; byProductType?: Record<string, Record<string, unknown>> }
    const keys = new Set(Object.keys(rules.fields ?? {}))
    for (const row of sheet.rows) for (const key of Object.keys(rules.byProductType?.[row.productType ?? ''] ?? {})) keys.add(key)
    scopes.push(readinessFromSheet(sheet, keys.size))
  }
  return { market, locale: master.schema.locale, scopes, computedAt: new Date().toISOString() }
}
