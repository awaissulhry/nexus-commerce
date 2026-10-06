/**
 * CR rebuild 4 — the Limits tab's account brakes and server facts, in words. Pure: the tab renders these with the
 * design system, and the tests drive them directly.
 *
 * The account brakes are the anomaly breaker's two limits (POST /api/advertising/automation/thresholds): when rule
 * actions or ad spend in the last hour pass one of them, the breaker stops all ads automation, as Stop now does. An
 * empty field is NOT "no limit" — it is the code's default — so every sentence says the number in force.
 *
 * Saving asks first (ActionConfirm), old → new. A higher limit lets automation do more before it is stopped, so it is a
 * raise and needs the tick; a lower one tightens a Nexus setting: a plain question. Before, Save wrote at once (report 7
 * §2.5).
 *
 * CR review (code #2): only the fields the person EDITED are sent (the endpoint leaves a field it is not sent alone,
 * ads-automation-state.service.ts `parseGuardThresholds`), and the confirmation is built from a fresh read made just
 * before it asks. Before, Save sent both limits from the read made when the tab opened, so a limit changed elsewhere
 * since (an approved Claude request, another person) was silently put back.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'

/** GET /api/advertising/control-room/guardrails (ads-control-room.service.ts `getAccountGuardrails`). */
export interface Guardrails {
  actionsPerHour: { effective: number; set: number | null; default: number }
  spendPerHourCents: { effective: number; set: number | null; default: number }
  maxWriteValueCents: number
  campaigns: { total: number; managed: number; unmanaged: number }
  bounds: { withMinBid: number; withMaxBid: number }
  protectedTerms: number
  adsMode: string
  envKill: boolean
}

/** One engine's limits from GET /api/advertising/automation/state (ads-automation-state.service.ts `engineLimits`). */
export interface EngineLimit { key: string; label: string; perTick: number | null; perDay: number | null; breakerPerHour: number }

export const euros = (cents: number): string =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(cents / 100)

export type BrakeField = 'actions' | 'spend'
const FIELDS: readonly BrakeField[] = ['actions', 'spend']

/** What is SET for each brake (null = the default): what the page read, or what the person typed. */
export interface BrakeSet { actions: number | null; spend: number | null }

export const setOf = (g: Pick<Guardrails, 'actionsPerHour' | 'spendPerHourCents'>): BrakeSet =>
  ({ actions: g.actionsPerHour.set, spend: g.spendPerHourCents.set })

/** The fields the person changed from what the page last read. Only these are sent. */
export function editedFields(loaded: BrakeSet, typed: BrakeSet): BrakeField[] {
  return FIELDS.filter((f) => typed[f] !== loaded[f])
}

export const BRAKE_LABEL: Record<BrakeField, string> = {
  actions: 'Most rule actions per hour',
  spend: 'Most ad spend per hour, all markets',
}

const say = (field: BrakeField, value: number) => (field === 'actions' ? value.toLocaleString('en-GB') : euros(value))

/** What a field holds: the number set, or empty for the default. Cents for spend. */
export type BrakeParse = { ok: true; value: number | null } | { ok: false; error: string }

/** Read what the person typed: empty = the default; actions a whole number ≥ 1; spend in euros, more than €0. */
export function parseBrake(field: BrakeField, raw: string): BrakeParse {
  const t = raw.trim().replace(',', '.')
  if (t === '') return { ok: true, value: null }
  const n = Number(t)
  if (field === 'actions') {
    return Number.isInteger(n) && n >= 1
      ? { ok: true, value: n }
      : { ok: false, error: 'Write a whole number of at least 1, or leave it empty for the default.' }
  }
  const cents = Math.round(n * 100)
  return Number.isFinite(n) && cents >= 1
    ? { ok: true, value: cents }
    : { ok: false, error: 'Write an amount above €0, or leave it empty for the default.' }
}

/** The field's text from what is SET — never the default, which would turn the default into a choice nobody made. */
export function brakeText(field: BrakeField, set: number | null): string {
  if (set == null) return ''
  return field === 'actions' ? String(set) : String(Math.round(set) / 100)
}

/** "In force: 250 — the default." / "In force: €40." */
export function inForceWords(field: BrakeField, limit: { effective: number; set: number | null }): string {
  return `In force: ${say(field, limit.effective)}${limit.set == null ? ' — the default.' : '.'}`
}

export interface BrakeChange {
  field: BrakeField
  /** The number in force before and after (the default when the field is empty). */
  from: number
  to: number
  fromDefault: boolean
  toDefault: boolean
  /** A higher limit lets automation do more before it is stopped. */
  raise: boolean
}

/**
 * What a save would change, for the given fields only (all of them when none are named). A field whose set value does
 * not change is left out.
 */
export function brakeChanges(
  g: Pick<Guardrails, 'actionsPerHour' | 'spendPerHourCents'>,
  next: BrakeSet,
  fields: readonly BrakeField[] = FIELDS,
): BrakeChange[] {
  const one = (field: BrakeField, cur: { set: number | null; default: number }, set: number | null): BrakeChange | null => {
    if (set === cur.set) return null
    const from = cur.set ?? cur.default
    const to = set ?? cur.default
    return { field, from, to, fromDefault: cur.set == null, toDefault: set == null, raise: to > from }
  }
  return [
    fields.includes('actions') ? one('actions', g.actionsPerHour, next.actions) : null,
    fields.includes('spend') ? one('spend', g.spendPerHourCents, next.spend) : null,
  ].filter((c): c is BrakeChange => c !== null)
}

/** A limit the person left alone that changed on the server since the page read it: the save keeps it as it is now. */
export interface ElsewhereChange { field: BrakeField; from: number; to: number; toDefault: boolean }

export function changedElsewhere(
  loaded: Pick<Guardrails, 'actionsPerHour' | 'spendPerHourCents'>,
  fresh: Pick<Guardrails, 'actionsPerHour' | 'spendPerHourCents'>,
  edited: readonly BrakeField[],
): ElsewhereChange[] {
  const pick = (field: BrakeField, g: Pick<Guardrails, 'actionsPerHour' | 'spendPerHourCents'>) => (field === 'actions' ? g.actionsPerHour : g.spendPerHourCents)
  return FIELDS.filter((f) => !edited.includes(f) && pick(f, loaded).set !== pick(f, fresh).set).map((f) => ({
    field: f,
    from: pick(f, loaded).effective,
    to: pick(f, fresh).effective,
    toDefault: pick(f, fresh).set == null,
  }))
}

const side = (field: BrakeField, value: number, isDefault: boolean) => `${say(field, value)}${isDefault ? ' (the default)' : ''}`

/**
 * The confirmation before the brakes are saved, or null when nothing changes. It lists exactly what is sent, and — when
 * a limit the person left alone changed elsewhere since the page read it — says that the save keeps that one as it is.
 * A lower limit tightens a setting in Nexus (reach local, no tick, a normal button); a higher one lets automation do
 * more before it is stopped (the tick).
 */
export function brakeImpact(changes: readonly BrakeChange[], elsewhere: readonly ElsewhereChange[] = []): ActionImpact | null {
  if (changes.length === 0) return null
  const raise = changes.some((c) => c.raise)
  const lower = changes.some((c) => !c.raise && c.to < c.from)
  const consequences = [
    ...changes.map((c) => `${BRAKE_LABEL[c.field]}: ${side(c.field, c.from, c.fromDefault)} → ${side(c.field, c.to, c.toDefault)}.`),
    ...elsewhere.map((e) => `${BRAKE_LABEL[e.field]} changed since you opened this page: it is now ${side(e.field, e.to, e.toDefault)}. This save keeps it.`),
    'When automation passes either limit within one hour, Nexus stops all ads automation, as Stop now does.',
  ]
  const back = 'Set the old numbers again here'
  return raise
    ? {
      level: 'confirm',
      title: lower ? 'Change the account brakes?' : 'Raise the account brakes?',
      confirmLabel: lower ? 'Save the brakes' : 'Raise the brakes',
      consequences,
      reach: 'channel',
      reversal: { verb: back, fidelity: 'lossy' },
      acknowledge: 'I understand automation may do more, or spend more, each hour before it is stopped.',
    }
    : {
      level: 'confirm',
      // Same number in force (the default typed in, or cleared to an equal default): a save, not a tighten.
      title: lower ? 'Tighten the account brakes?' : 'Save the account brakes?',
      confirmLabel: lower ? 'Tighten the brakes' : 'Save the brakes',
      consequences,
      reach: 'local',
      reversal: { verb: back, fidelity: 'exact' },
    }
}

/** The body the thresholds endpoint takes: only the edited fields; null = back to the default. */
export function brakeBody(next: BrakeSet, fields: readonly BrakeField[] = FIELDS) {
  return {
    ...(fields.includes('actions') ? { maxActionsPerHour: next.actions } : {}),
    ...(fields.includes('spend') ? { maxHourlySpendCentsEur: next.spend } : {}),
  }
}

// ── what only a deploy changes ───────────────────────────────────────────────────────────────────────────────

export interface ServerFact { label: string; value: string; hint: string; technical: string }

/** The facts the server sets, in plain words; each keeps its technical name for whoever changes it. */
export function serverFacts(g: Pick<Guardrails, 'envKill' | 'adsMode' | 'maxWriteValueCents'>): ServerFact[] {
  return [
    {
      label: 'Emergency switch',
      value: g.envKill ? 'On — all ads automation is stopped' : 'Off',
      hint: g.envKill ? 'Nothing changes your ads by itself until a deploy turns it off.' : 'When it is on, all ads automation stops.',
      technical: 'NEXUS_ADS_AUTOMATION_KILL',
    },
    {
      label: 'Where changes go',
      value: g.adsMode === 'live' ? 'Your Amazon account' : 'Amazon’s test account — not your ads',
      hint: g.adsMode === 'live' ? 'Changes reach your real campaigns.' : 'Changes go to Amazon’s sandbox. Your real campaigns do not change.',
      technical: `NEXUS_AMAZON_ADS_MODE = ${g.adsMode}`,
    },
    {
      label: 'Largest single change',
      value: euros(g.maxWriteValueCents),
      hint: 'A single change worth more than this is refused.',
      technical: 'NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS',
    },
  ]
}
