/**
 * Tests only — an ENGINE-NATIVE stop-waste rule, as the Negative Targeting page's earlier editor and Claude saved one
 * (flat conditions, one action carrying its stop-waste test). Wave 4 makes every new rule in the builder; rules of this
 * shape still exist, and the gate, the Rules view and the preview must keep reading them. Moved here from
 * waste-rules/pure.ts (audit S5): nothing in the app saves this shape any more.
 */
import { stopWasteParamsOf, type StopWasteKind, type StopWasteParams } from '../services/advertising/ads-graduation-stopwaste.js'
import { STARTERS, type WasteScope } from '../services/advertising/waste-rules/pure.js'

export type NegateMatch = 'EXACT' | 'PHRASE'
export type NegateLevel = 'AD_GROUP' | 'CAMPAIGN'

/** A stop-waste rule as the page's earlier editor (and Claude) sent it. */
export interface WasteRuleBody {
  kind: StopWasteKind
  name?: string
  scope?: WasteScope
  windowDays?: number
  minClicks?: number
  cpaMultiple?: number
  spendFloorCents?: number
  /** NEGATE_TERM: negative exact (default) or phrase (a phrase always asks). */
  match?: NegateMatch
  /** NEGATE_TERM: in the ad group it served in (default) or the whole campaign. */
  level?: NegateLevel
  /** The daily run's time in Rome, "HH:MM" (default 06:00). */
  runAt?: string
}

/** The account-wide harvest wire a negative exact rides (ads-harvest-wire.ts): the source ad group, row + audit row + undo. */
const SOURCE_WIRE = { blocks: null, filters: { containsAny: [], notContains: [], brandExclude: [], competitorOnly: false }, dedupe: true } as const

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** The engine rule a body saves as (engine-native: flat conditions, one action carrying its stop-waste test). Pure. */
export function ruleOfBody(b: WasteRuleBody): {
  name: string
  trigger: 'TARGET_PERFORMANCE' | 'SEARCH_TERM_WASTING'
  conditions: Array<{ field: string; op: string; value: number }>
  actions: Array<Record<string, unknown>>
  params: StopWasteParams
} {
  const starter = { ...STARTERS.find((s) => s.kind === b.kind)!, name: b.kind === 'PAUSE_KEYWORD' ? 'Stop waste — keywords' : 'Stop waste — search terms' }
  const params = stopWasteParamsOf([{ stopWaste: {
    kind: b.kind,
    windowDays: b.windowDays ?? starter.windowDays,
    minClicks: b.minClicks ?? starter.minClicks,
    cpaMultiple: b.cpaMultiple ?? starter.cpaMultiple,
    spendFloorCents: b.spendFloorCents ?? starter.spendFloorCents,
  } }])!
  const [hh, mm] = (b.runAt && HHMM.test(b.runAt) ? b.runAt : '06:00').split(':')
  const schedule = { frequency: 'Daily', time: `${hh.padStart(2, '0')}:${mm}`, timezone: 'cet' }
  const stopWaste = { ...params }
  if (b.kind === 'PAUSE_KEYWORD') {
    return {
      name: b.name?.trim() || starter.name,
      trigger: 'TARGET_PERFORMANCE',
      conditions: [{ field: 'adTarget.orders', op: 'eq', value: 0 }, { field: 'adTarget.clicks', op: 'gte', value: params.minClicks }],
      actions: [{ type: 'pause_target', keepPaused: true, stopWaste, schedule, reason: 'Stop waste — keyword paused, kept paused' }],
      params,
    }
  }
  const level: NegateLevel = b.level ?? 'AD_GROUP'
  const phrase = b.match === 'PHRASE'
  return {
    name: b.name?.trim() || starter.name,
    trigger: 'SEARCH_TERM_WASTING',
    conditions: [{ field: 'searchTerm.orders', op: 'eq', value: 0 }, { field: 'searchTerm.clicks', op: 'gte', value: params.minClicks }],
    actions: [phrase
      // A phrase negative: the single-scope path (match type from the action).
      ? { type: 'add_negative_phrase', scope: level, stopWaste, schedule, reason: 'Stop waste — search term negated (phrase)' }
      // A negative exact rides the account-wide wire: in the source ad group (or its campaign), mirrored with its audit row.
      : { type: 'add_negative_exact', scope: level, levels: [level], negative: SOURCE_WIRE, stopWaste, schedule, reason: 'Stop waste — search term negated (exact)' }],
    params,
  }
}
