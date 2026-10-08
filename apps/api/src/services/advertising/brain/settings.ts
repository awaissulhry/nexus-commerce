/**
 * ONE BRAIN AB-1 — what the brain may do for one product in one market, and on one of its campaigns: the brain's
 * defaults (brain/levers.ts) with the Owner's overrides (AdsBrainOverride) over them. Owner 10-08: "I should be able to
 * control it individually as well". Pure: the database part reads the rows (brain/enrollment.ts brainSettings).
 *
 *   precedence  per setting: a CAMPAIGN override > a PRODUCT override > the brain default. Per lever, the most specific
 *               scope that says anything about the lever (its level or a lock of the whole lever) decides; inside one
 *               scope a lock beats a level. So a campaign set to AUTO runs under a product-wide lock, and a campaign
 *               lock holds under a product at AUTO.
 *   exclusion   an EXCLUDE (of the product, or of the campaign) wins over every lever: the brain leaves it completely
 *               and today's engines run it ("excluded by the Owner").
 *   effective   per lever: NOT ENROLLED, EXCLUDED and LOCKED write nothing (a locked lever only gets a recommendation);
 *               otherwise its level. `owned` = the brain is the lever's writer here (PROPOSE or AUTO).
 *   provenance  every resolved value names its source (default · product · campaign) and, for an override, who set it,
 *               when and why, so the map and the "why" can show it.
 *   fail closed a stored override that no longer validates (an unknown key, a value outside the bounds) is ignored and
 *               listed; the next level applies.
 */
import {
  BRAIN_LEVERS, BRAIN_SETTING_KEYS, DEFAULT_LEVEL, isLever, isLevel, isSetting, levelRefusal, lockRef, lockValueRefusal, ownsLever, settingDefaults,
  settingRefusal, type BrainLever, type BrainLevel, type BrainScope, type BrainSetting, type SettingValue,
} from './levers.js'

export const OVERRIDE_KINDS = ['LEVEL', 'LOCK', 'EXCLUDE', 'VALUE'] as const
export type OverrideKind = (typeof OVERRIDE_KINDS)[number]
export const EXCLUDE_KEY = '*'

/** One AdsBrainOverride row, as the resolver reads it. */
export interface OverrideRow {
  id: string
  productId: string
  marketplace: string
  scope: string
  campaignId: string | null
  kind: string
  key: string
  ref: string
  value: unknown
  by: string
  reason: string | null
  createdAt: Date | string
  endedAt: Date | string | null
}

/** An override a writer is asked for, before it is stored. */
export interface OverrideInput {
  scope: BrainScope
  campaignId?: string | null
  kind: OverrideKind
  key: string
  ref?: string | null
  value?: unknown
}

export interface OverrideIdentity { scope: BrainScope; campaignId: string | null; kind: OverrideKind; key: string; ref: string }

/** What an override sets (scope, campaign, kind, key, ref normalised), or why that is nothing the Owner can set. */
export function validateIdentity(input: Omit<OverrideInput, 'value'>): { identity: OverrideIdentity } | { refusal: string } {
  if (input.scope !== 'PRODUCT' && input.scope !== 'CAMPAIGN') return { refusal: `the scope is PRODUCT or CAMPAIGN, not ${String(input.scope)}` }
  const campaignId = typeof input.campaignId === 'string' && input.campaignId.trim() ? input.campaignId.trim() : null
  if (input.scope === 'CAMPAIGN' && !campaignId) return { refusal: 'a campaign override names its campaign (campaignId)' }
  if (input.scope === 'PRODUCT' && campaignId) return { refusal: 'a product override names no campaign' }
  if (campaignId && campaignId.length > 64) return { refusal: 'campaignId is a Nexus campaign id (at most 64 characters)' }
  const base = { scope: input.scope, campaignId }
  switch (input.kind) {
    case 'LEVEL':
      return isLever(input.key) ? { identity: { ...base, kind: 'LEVEL', key: input.key, ref: '' } } : { refusal: `${input.key} is not a lever of the brain (levers: ${BRAIN_LEVERS.join(', ')})` }
    case 'LOCK': {
      if (!isLever(input.key)) return { refusal: `${input.key} is not a lever of the brain (levers: ${BRAIN_LEVERS.join(', ')})` }
      const ref = lockRef(input.key, input.ref)
      return 'refusal' in ref ? ref : { identity: { ...base, kind: 'LOCK', key: input.key, ref: ref.ref } }
    }
    case 'EXCLUDE':
      return input.key === EXCLUDE_KEY || !input.key ? { identity: { ...base, kind: 'EXCLUDE', key: EXCLUDE_KEY, ref: '' } } : { refusal: `an exclusion takes key "${EXCLUDE_KEY}", not ${input.key}` }
    case 'VALUE':
      if (!isSetting(input.key)) return { refusal: `${input.key} is not a setting of the brain (settings: ${BRAIN_SETTING_KEYS.join(', ')})` }
      return { identity: { ...base, kind: 'VALUE', key: input.key, ref: '' } }
    default:
      return { refusal: `the kind is ${OVERRIDE_KINDS.join(', ')}, not ${String(input.kind)}` }
  }
}

/** The override as it will be stored (its identity, and its value checked for its kind), or why it cannot be set. */
export function validateOverride(input: OverrideInput): { override: OverrideIdentity & { value: unknown } } | { refusal: string } {
  const checked = validateIdentity(input)
  if ('refusal' in checked) return checked
  const id = checked.identity
  const value = input.value === undefined ? null : input.value
  let refusal: string | null = null
  if (id.kind === 'LEVEL') refusal = isLevel(value) ? levelRefusal(id.key as BrainLever, value) : `a level is OFF, OBSERVE, PROPOSE or AUTO, not ${JSON.stringify(value)}`
  else if (id.kind === 'LOCK') refusal = lockValueRefusal(id.key as BrainLever, id.ref, value, id.scope)
  else if (id.kind === 'EXCLUDE') refusal = value === null ? null : 'an exclusion takes no value'
  else refusal = settingRefusal(id.key, value, id.scope)
  return refusal ? { refusal } : { override: { ...id, value } }
}

/** Two overrides with the same identity set the same thing: the newer one replaces the older (the writer ends it). */
export const overrideIdentity = (o: Pick<OverrideRow, 'scope' | 'campaignId' | 'kind' | 'key' | 'ref'>): string =>
  JSON.stringify([o.scope, o.scope === 'CAMPAIGN' ? o.campaignId : null, o.kind, o.key, o.ref ?? ''])

export type SettingSource = 'default' | 'product' | 'campaign'

/** Where a resolved value comes from. */
export interface Provenance { source: SettingSource; overrideId: string | null; by: string | null; at: string | null; reason: string | null }
export type Resolved<T> = { value: T } & Provenance

export interface LeverSettings {
  /** The level, by precedence (campaign > product > default), whatever a lock or an exclusion says. */
  level: Resolved<BrainLevel>
  /** The lock of the whole lever that decides here (the Owner's own value; null value = as it is now), or null. */
  lock: Resolved<unknown> | null
  /** Locks of one thing inside the lever (product-wide and this campaign's): the lever's writer leaves each. */
  locks: Array<Resolved<unknown> & { ref: string }>
  /** What the brain does with the lever here. */
  effective: BrainLevel | 'LOCKED' | 'EXCLUDED' | 'NOT_ENROLLED'
  /** The brain is the lever's writer here (PROPOSE or AUTO, enrolled, not excluded, not locked). */
  owned: boolean
  why: string
}

export interface BrainSettings {
  productId: string
  market: string
  campaignId: string | null
  enrolled: boolean
  excluded: Resolved<boolean>
  levers: Record<BrainLever, LeverSettings>
  values: Record<BrainSetting, Resolved<SettingValue>>
  /** Stored overrides that no longer validate: ignored (the next level applies). */
  ignored: Array<{ overrideId: string; why: string }>
}

const DEFAULT: Provenance = { source: 'default', overrideId: null, by: null, at: null, reason: null }
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d))
const provenanceOf = (o: OverrideRow): Provenance => ({ source: o.scope === 'CAMPAIGN' ? 'campaign' : 'product', overrideId: o.id, by: o.by, at: iso(o.createdAt), reason: o.reason })
/** "the Owner's campaign override (user:x, 2026-10-08)" — who set a resolved value, and when. */
export const describeProvenance = (p: Provenance): string =>
  p.source === 'default' ? 'the brain\'s default' : `the Owner's ${p.source} override${p.by ? ` (${p.by}${p.at ? `, ${p.at.slice(0, 10)}` : ''})` : ''}`
const who = describeProvenance

/**
 * Resolve the brain's settings for a product in a market, and for one campaign when given. `overrides` may hold any
 * rows: only the open ones of this product × market (PRODUCT) and of this campaign (CAMPAIGN) count. A campaign
 * override belongs to its campaign: it applies whichever product the campaign is resolved under.
 */
export function resolveBrainSettings(input: { productId: string; market: string; campaignId?: string | null; enrolled: boolean; overrides: readonly OverrideRow[] }): BrainSettings {
  const campaignId = input.campaignId ?? null
  const ignored: Array<{ overrideId: string; why: string }> = []
  // The open overrides that apply here, validated again (a row a later code change no longer accepts is ignored).
  const live = new Map<string, OverrideRow>()
  for (const o of [...input.overrides].sort((a, b) => iso(a.createdAt).localeCompare(iso(b.createdAt)))) {
    if (o.endedAt) continue
    const applies = o.scope === 'PRODUCT'
      ? o.productId === input.productId && o.marketplace === input.market && !o.campaignId
      : o.scope === 'CAMPAIGN' && !!campaignId && o.campaignId === campaignId
    if (!applies) continue
    const checked = validateOverride({ scope: o.scope as BrainScope, campaignId: o.campaignId, kind: o.kind as OverrideKind, key: o.key, ref: o.ref, value: o.value })
    if ('refusal' in checked) { ignored.push({ overrideId: o.id, why: checked.refusal }); continue }
    live.set(overrideIdentity(o), { ...o, ref: checked.override.ref }) // the newest of one identity wins
  }
  const find = (scope: BrainScope, kind: OverrideKind, key: string, ref = '') => live.get(overrideIdentity({ scope, campaignId, kind, key, ref }))

  const exclusion = find('CAMPAIGN', 'EXCLUDE', EXCLUDE_KEY) ?? find('PRODUCT', 'EXCLUDE', EXCLUDE_KEY)
  const excluded: Resolved<boolean> = exclusion ? { value: true, ...provenanceOf(exclusion) } : { value: false, ...DEFAULT }

  const levers = {} as Record<BrainLever, LeverSettings>
  for (const lever of BRAIN_LEVERS) {
    const campaignLevel = find('CAMPAIGN', 'LEVEL', lever)
    const productLevel = find('PRODUCT', 'LEVEL', lever)
    const campaignLock = find('CAMPAIGN', 'LOCK', lever)
    const productLock = find('PRODUCT', 'LOCK', lever)
    const levelRow = campaignLevel ?? productLevel
    const level: Resolved<BrainLevel> = levelRow ? { value: levelRow.value as BrainLevel, ...provenanceOf(levelRow) } : { value: DEFAULT_LEVEL, ...DEFAULT }
    // The most specific scope that says anything about the lever decides; inside it, a lock beats a level.
    const lockRow = campaignLock ?? (campaignLevel ? undefined : productLock)
    const lock = lockRow ? { value: lockRow.value ?? null, ...provenanceOf(lockRow) } : null
    const locks = [...live.values()]
      .filter((o) => o.kind === 'LOCK' && o.key === lever && o.ref)
      .map((o) => ({ value: o.value ?? null, ref: o.ref, ...provenanceOf(o) }))
      .sort((a, b) => a.ref.localeCompare(b.ref) || a.source.localeCompare(b.source))
    let effective: LeverSettings['effective']
    let why: string
    if (!input.enrolled) { effective = 'NOT_ENROLLED'; why = 'the product is not enrolled in the brain: today\'s engines run it' }
    else if (excluded.value) { effective = 'EXCLUDED'; why = `excluded by ${who(excluded)}: today's engines run it` }
    else if (lock) { effective = 'LOCKED'; why = `locked at the Owner's own value by ${who(lock)}: the brain writes nothing and only recommends` }
    else { effective = level.value; why = `${level.value} by ${who(level)}` }
    levers[lever] = { level, lock, locks, effective, owned: isLevel(effective) && ownsLever(effective), why }
  }

  const defaults = settingDefaults()
  const values = {} as Record<BrainSetting, Resolved<SettingValue>>
  for (const key of BRAIN_SETTING_KEYS) {
    const row = find('CAMPAIGN', 'VALUE', key) ?? find('PRODUCT', 'VALUE', key)
    values[key] = row ? { value: row.value as SettingValue, ...provenanceOf(row) } : { value: defaults[key], ...DEFAULT }
  }
  return { productId: input.productId, market: input.market, campaignId, enrolled: input.enrolled, excluded, levers, values, ignored }
}

/**
 * Why the Owner keeps the bid brain off this campaign (its exclusion, or a lock of its whole bids lever), naming the
 * override, who set it, when and why; null when nothing does. What set-bid-brain-enrollment refuses op live and release by.
 */
export function ownerBrakeOf(s: Pick<BrainSettings, 'excluded' | 'levers'>): string | null {
  const reason = (p: Provenance) => (p.reason ? `: "${p.reason}"` : '')
  if (s.excluded.value) return `it is excluded from the brain by ${describeProvenance(s.excluded)}${reason(s.excluded)}`
  const lock = s.levers.bids.lock
  if (lock) return `its bids are locked at the Owner's own value by ${describeProvenance(lock)}${reason(lock)}`
  return null
}

/** Two settings checked against each other: the warning level never above the maximum (where each comes from named). */
export function settingsPairRefusal(values: Pick<BrainSettings['values'], 'negativesPerEntityWarn' | 'negativesPerEntityMax'>, where = ''): string | null {
  const warn = values.negativesPerEntityWarn
  const max = values.negativesPerEntityMax
  if (Number(warn.value) <= Number(max.value)) return null
  return `negativesPerEntityWarn (${warn.value}, ${describeProvenance(warn)}) would be above negativesPerEntityMax (${max.value}, ${describeProvenance(max)})${where}: the warning must come before the maximum`
}
