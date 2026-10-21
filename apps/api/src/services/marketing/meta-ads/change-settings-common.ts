/**
 * Meta step 18 — what the three settings drafts share (change-campaign-settings.ts, change-ad-set-settings.ts,
 * change-budget-schedule.ts): the record a settings change keeps for undo, the one way a Meta field is VIEWED (so what a
 * change wrote, read back, and what undo reads later compare as the same string), and the sentences about spending.
 * Pure: no reads.
 *
 * The record: `after.fields` is each field the change wrote, as Meta READ IT BACK (or, where Meta cannot be asked it
 * back, as sent — `unread`); undo's `current` reads the same fields live and views them the same way, so a field that
 * moved since is seen (change-record.service.ts compares the two). `before.undo` holds the arguments of the SAME tool
 * that put back what the change replaced — computed from the live state it replaced — or null with the reasons in
 * `before.noUndo` (Meta has no way back: budget sharing off, a ROAS goal under campaign budget, a catalog added, …).
 */
import { META_NO_CAP, metaSettingsCheckAllowed } from '../../gateway/meta-settings-rules.js'
import { currencyExponent } from './money.js'

/** What a settings change records, before and after (AgentChange; undo reads them). */
export interface SettingsRecord {
  kind: 'campaign' | 'adset' | 'highdemandperiod'
  id: string
  /** A budget schedule's campaign or ad set. */
  parent?: { kind: 'campaign' | 'adset'; id: string } | null
  /** field → its value as viewed (settingsView). */
  fields: Record<string, string | null>
  /** Fields Meta cannot be asked back (SDK only): recorded as sent, and undo cannot see whether they moved. */
  unread?: string[]
  /** before only: the arguments of the same tool that put back what the change replaced (null: none). */
  undo?: Record<string, unknown> | null
  /** before only: what the change did that has no way back, in words. */
  noUndo?: string[]
}

/** Fields whose value is a time: viewed as UTC Unix seconds (Meta reads them back as ISO, Nexus writes Unix seconds). */
const TIME_FIELDS = new Set(['start_time', 'end_time', 'time_start', 'time_end'])
/** Amount fields where Meta's "nothing" is 0, absent or its no-cap value. */
const CAP_FIELDS = new Set(['spend_cap', 'daily_spend_cap', 'lifetime_spend_cap'])
const AMOUNT_FIELDS = new Set(['daily_budget', 'lifetime_budget', 'daily_min_spend_target', 'lifetime_min_spend_target', 'bid_amount'])

/** Keys sorted at every depth, so two spellings of one JSON value view the same. */
function sortedJson(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x)
  return JSON.stringify(sort(v))
}

/** ONE view of a Meta field's value — as sent (a form string) or as Meta reads it back (a JSON value). */
export function settingsView(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return CAP_FIELDS.has(field) ? 'none' : null
  if (TIME_FIELDS.has(field)) {
    const text = String(value)
    if (text === '0') return 'none'
    if (/^\d{9,11}$/.test(text)) return text
    const ms = Date.parse(text)
    return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : text
  }
  if (CAP_FIELDS.has(field)) return String(value) === META_NO_CAP || String(value) === '0' ? 'none' : String(value)
  if (AMOUNT_FIELDS.has(field) && String(value) === '0') return null
  if (typeof value === 'string') {
    // A form value that is JSON (sent) and Meta's JSON value (read back) view the same.
    if (/^[[{]/.test(value)) { try { return sortedJson(JSON.parse(value)) } catch { return value } }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return sortedJson(value)
}

/** The view of every field a change wrote, from what Meta read back (a field not read back: as sent, listed unread). */
export function viewedFields(fields: readonly string[], node: Record<string, unknown> | null, sent: Record<string, string>): { fields: Record<string, string | null>; unread: string[] } {
  const out: Record<string, string | null> = {}
  const unread: string[] = []
  for (const field of fields) {
    if (node && field in node) out[field] = settingsView(field, node[field])
    else if (node && !(field in node) && !(field in sent)) out[field] = settingsView(field, null)
    else { out[field] = settingsView(field, sent[field] ?? null); unread.push(field) }
  }
  return { fields: out, unread }
}

/**
 * Meta's check of a campaign settings change: Meta documents validate_only on campaign updates (reference/
 * ad-campaign-group.md "Updating") but Nexus uses it only once LIVE-PROBE ST18-03 proved Meta honours it on a SETTINGS
 * update (meta-settings-rules.ts META_SETTINGS_CHECK_PROVEN, flipped by the leader — not step 17's status flag, review A5);
 * an ad set update and a budget schedule have none.
 */
export const campaignSettingsCheck = (proven: boolean = metaSettingsCheckAllowed()): 'meta' | 'not-yet' => (proven ? 'meta' : 'not-yet')

/** A Meta money amount (minor units) in words: "12.34 EUR". */
export function money(cents: number | null, currency: string | null): string {
  if (cents === null) return 'none'
  const exponent = currencyExponent(currency)
  return `${(cents / 10 ** exponent).toFixed(exponent)} ${currency ?? ''}`.trim()
}

/** "while it is on it spends more from now" / "nothing spends yet: it is paused" — about an object's delivery now. */
export function spendingNow(objectWord: string, on: boolean): string {
  return on ? `${objectWord} is on, so it can spend more from now` : `nothing spends yet: ${objectWord} is not on (it spends once switched on)`
}

/** Is an object delivering (its own status ACTIVE and every parent's too)? */
export const isOn = (...statuses: Array<string | null | undefined>) => statuses.every((s) => s === 'ACTIVE')
