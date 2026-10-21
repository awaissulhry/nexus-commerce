/**
 * Meta step 20 — set-meta-account-controls as a draft (master TG-100, TG-101; facts F1 M4-20). Pure: the request and the
 * live controls (live-targeting-change.ts liveAccountControls) in, the draft (or a refusal in words) out.
 *
 * reference/ad-account/account_controls.md: POST /act_{id}/account_controls with audience_controls [required] {age_min,
 * geo_locations, excluded_geo_locations, exclusions} and placement_controls {placement_exclusions [AUDIENCE_NETWORK_CLASSIC,
 * AUDIENCE_NETWORK_REWARDED_VIDEO, AUDIENCE_NETWORK_INSTREAM_VIDEO, FACEBOOK_MARKETPLACE, FACEBOOK_RIGHT_HAND_COLUMN],
 * campaign_ids_to_set_ap}. Meta documents no update and no delete: a POST replaces the controls, so Nexus sends them WHOLE
 * — what Meta holds now with only the named parts changed — and its undo is a POST of the old whole controls. Account
 * controls hold employer exclusions only (error 1870219; too many: 1870220); restricted locations: 2641. Meta's page names
 * campaign_ids_to_set_ap with its type only (array<numeric string>), not what it does to those campaigns (LIVE-PROBES
 * TG-101); placement_controls_per_objective is SDK only: when the account holds it, Nexus changes nothing (posting the
 * controls without it could drop it).
 *
 * Spending: controls are guard-rails for every campaign of the account — a LOOSER control (a lower minimum age, more
 * places, fewer excluded places or employers, fewer excluded placements, campaigns named for Advantage+ placements) can
 * widen every ad set: SPENDS MONEY — with no campaign delivering now too, said as "nothing spends yet" (the controls hold
 * for every campaign switched on later). Stricter is safe. Meta documents no check (validate_only) for this edge.
 */
import { changeLines, type MetaChangeDraft } from './change-draft.js'
import {
  ACCOUNT_PLACEMENT_EXCLUSIONS, KEPT_PLACEMENT_EXCLUSIONS, audienceControlsProblem, geoReadsBackAsSent, isDefaultLocationTypes, placementControlsProblem, placementExclusionOf, sameTargeting,
  targetingView, unknownPlacementExclusion,
} from '../../gateway/meta-targeting-rules.js'
import { sameJson } from '../../gateway/meta-brand-safety-rules.js'
import { applyLocations, geoWider, geoWords, mayReach, type IdChange, type LocationChange } from './change-targeting.js'
import { NO_YOUTH_COUNTRIES } from './live-create.js'
import type { AccountControlsState } from './live-targeting-change.js'

type Row = Record<string, unknown>
const plainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (plainObject(x) ? String(x.id ?? '') : String(x))).filter(Boolean) : [])
const uniq = <T>(items: T[]): T[] => [...new Set(items)]

export type AccountPlacementExclusion = typeof ACCOUNT_PLACEMENT_EXCLUSIONS[number]
export interface AccountControlsAsk {
  ageMin?: number
  locations?: LocationChange
  excludedLocations?: LocationChange
  excludedEmployers?: IdChange
  /** The whole list of placements the account excludes ([] clears it). */
  placementExclusions?: AccountPlacementExclusion[]
  /** campaign_ids_to_set_ap — the whole list ([] clears it); Meta documents only its name. */
  campaignIdsForAdvantagePlacements?: string[]
  /** Undo: the whole controls as they were. */
  restore?: { audienceControls: Row; placementControls?: Row | null }
}

export interface AccountControlsRecord { exists: boolean; audience: unknown; placement: unknown }

const EXCLUSION_WORDS: Readonly<Record<AccountPlacementExclusion, string>> = {
  AUDIENCE_NETWORK_CLASSIC: 'Audience Network (native, banner, interstitial)', AUDIENCE_NETWORK_REWARDED_VIDEO: 'Audience Network rewarded videos',
  AUDIENCE_NETWORK_INSTREAM_VIDEO: 'Audience Network in-stream videos', FACEBOOK_MARKETPLACE: 'Facebook Marketplace', FACEBOOK_RIGHT_HAND_COLUMN: 'Facebook right column',
}

/** Review B1 — the placement controls with every exclusion in its one spelling (placementExclusionOf: read → enum). */
export function normalPlacement(p: Row | null): Row | null {
  if (!plainObject(p)) return null
  return Array.isArray(p.placement_exclusions) ? { ...p, placement_exclusions: uniq((p.placement_exclusions as unknown[]).filter((x): x is string => typeof x === 'string').map(placementExclusionOf)) } : { ...p }
}

/** How the account's controls loosen, in words (empty: they only narrow or stay). */
export function controlsWider(before: { audience: Row; placement: Row | null }, after: { audience: Row; placement: Row | null }): string[] {
  const out: string[] = []
  const minB = typeof before.audience.age_min === 'number' ? before.audience.age_min : null
  const minA = typeof after.audience.age_min === 'number' ? after.audience.age_min : null
  if (minB !== null && (minA === null || minA < minB)) out.push(`a lower minimum age (${minB} → ${minA ?? 'none'})`)
  out.push(...geoWider(before.audience.geo_locations, after.audience.geo_locations, false).filter(() => plainObject(before.audience.geo_locations)))
  if (plainObject(before.audience.geo_locations) && !plainObject(after.audience.geo_locations)) out.push('no allowed locations any more (every location)')
  // Review A3 — location_types other than Meta's only option, dropped: people recently in the places come in too.
  const lt = (r: Row) => (plainObject(r.geo_locations) ? r.geo_locations.location_types : undefined)
  if (lt(before.audience) !== undefined && !isDefaultLocationTypes(lt(before.audience)) && !sameJson(targetingView(lt(before.audience)), targetingView(lt(after.audience) ?? null))) {
    out.push(`allowed locations' types ${JSON.stringify(lt(before.audience))} → Meta's only option, people living in OR recently in them (1870199)`)
  }
  out.push(...geoWider(before.audience.excluded_geo_locations, after.audience.excluded_geo_locations, true))
  const emp = (r: Row) => ids(plainObject(r.exclusions) ? r.exclusions.work_employers : null)
  const lostEmp = emp(before.audience).filter((x) => !emp(after.audience).includes(x))
  if (lostEmp.length) out.push(`employers no longer excluded (${lostEmp.join(', ')})`)
  const exc = (r: Row | null) => { const n = normalPlacement(r); return n && Array.isArray(n.placement_exclusions) ? n.placement_exclusions as string[] : [] }
  const lostExc = exc(before.placement).filter((x) => !exc(after.placement).includes(x))
  if (lostExc.length) out.push(`placements no longer excluded (${lostExc.map((x) => EXCLUSION_WORDS[x as AccountPlacementExclusion] ?? x).join(', ')})`)
  const ap = (r: Row | null) => (plainObject(r) && Array.isArray(r.campaign_ids_to_set_ap) ? r.campaign_ids_to_set_ap as string[] : [])
  if (!sameJson([...ap(before.placement)].sort(), [...ap(after.placement)].sort())) out.push('the campaigns named for Advantage+ placements changed (Meta documents only the field, so Nexus counts it as possibly wider)')
  return out
}

/**
 * The read-back judge: the controls Meta reads now are the ones sent — locations as a superset of what was sent (review B2),
 * placement exclusions in their one spelling whichever way Meta writes them back (review B1).
 */
export function controlsJudge(audience: Row, placement: Row | null) {
  return (node: Record<string, unknown>) => {
    const row = Array.isArray(node.data) && plainObject(node.data[0]) ? node.data[0] as Row : plainObject(node.audience_controls) ? node : null
    if (!row) return { moved: ['audience_controls'], reads: 'no controls' }
    const moved: string[] = []
    const got = plainObject(row.audience_controls) ? row.audience_controls : {}
    const audienceMoved = [...new Set([...Object.keys(audience), ...Object.keys(got)])].some((k) => (k === 'geo_locations' || k === 'excluded_geo_locations'
      ? !(audience[k] === undefined && got[k] === undefined) && !geoReadsBackAsSent(audience[k] ?? null, got[k] ?? null)
      : !sameTargeting(audience[k] ?? null, got[k] ?? null)))
    if (audienceMoved) moved.push('audience_controls')
    const p = normalPlacement(plainObject(row.placement_controls) ? row.placement_controls : null)
    if (placement && !sameTargeting(p ?? { placement_exclusions: [] }, normalPlacement(placement))) moved.push('placement_controls')
    return { moved, reads: `audience_controls ${JSON.stringify(targetingView(row.audience_controls ?? null)).slice(0, 200)}, placement_controls ${JSON.stringify(targetingView(p)).slice(0, 120)}` }
  }
}

export function accountControlsDraft(ask: AccountControlsAsk, live: { adAccountId: string; controls: AccountControlsState; delivering: boolean | null }): MetaChangeDraft | { refusal: string } {
  const c = live.controls
  const asked = ['ageMin', 'locations', 'excludedLocations', 'excludedEmployers', 'placementExclusions', 'campaignIdsForAdvantagePlacements', 'restore'].filter((k) => ask[k as keyof AccountControlsAsk] !== undefined)
  if (!asked.length) return { refusal: 'Say what to change in the ad account\'s controls (ageMin, locations, excludedLocations, excludedEmployers, placementExclusions).' }
  if (ask.restore && asked.length > 1) return { refusal: 'A restore of the controls goes alone.' }
  if (c.perObjective && !(plainObject(c.perObjective) && 'unread' in c.perObjective)) {
    return { refusal: 'The ad account\'s controls also hold per-objective placement controls (placement_controls_per_objective, Meta\'s SDK only), which Nexus does not send: a new POST replaces the controls whole and could drop them. A person changes the controls in Ads Manager › Advertising settings.' }
  }
  const audienceNow: Row = plainObject(c.audience) ? c.audience : {}
  // Review B1 — exclusions in their one spelling (Meta may read them back as lower-case platform_position strings).
  const placementNow: Row | null = normalPlacement(plainObject(c.placement) ? c.placement : null)
  if (placementNow && Object.keys(placementNow).some((k) => k !== 'placement_exclusions' && k !== 'campaign_ids_to_set_ap')) {
    return { refusal: `The ad account's placement controls hold ${Object.keys(placementNow).filter((k) => k !== 'placement_exclusions' && k !== 'campaign_ids_to_set_ap').join(', ')}, which Meta does not document: Nexus does not post them back (a person changes them in Ads Manager).` }
  }
  const heldExclusions = placementNow && Array.isArray(placementNow.placement_exclusions) ? placementNow.placement_exclusions as string[] : []
  const unknown = heldExclusions.filter(unknownPlacementExclusion)
  if (unknown.length) {
    return { refusal: `The ad account's controls exclude ${unknown.join(', ')}, a placement Meta documents nowhere and Nexus does not know how to post back: Nexus changes nothing (a person changes the controls in Ads Manager › Advertising settings).` }
  }
  const kept = heldExclusions.filter((x) => (KEPT_PLACEMENT_EXCLUSIONS as readonly string[]).includes(x))
  const undocumented = [...kept, ...(audienceNow.is_gender_exclusion_enabled !== undefined ? [`is_gender_exclusion_enabled ${String(audienceNow.is_gender_exclusion_enabled)}`] : [])]
  const problems: string[] = []
  const notes: string[] = []
  let audience: Row
  let placement: Row | null
  if (ask.restore) {
    audience = { ...ask.restore.audienceControls }
    // None before: an empty exclusion list is sent (a POST without placement_controls may keep today's).
    placement = ask.restore.placementControls ?? (placementNow ? { placement_exclusions: [] } : null)
  } else {
    audience = { ...audienceNow }
    placement = placementNow ? { ...placementNow } : null
    if (ask.ageMin !== undefined) audience.age_min = ask.ageMin
    for (const [arg, key] of [['locations', 'geo_locations'], ['excludedLocations', 'excluded_geo_locations']] as const) {
      const change = ask[arg]
      if (!change) continue
      const r = applyLocations(audienceNow[key], change, `the account's ${arg === 'locations' ? 'allowed' : 'excluded'} locations`)
      problems.push(...r.problems); notes.push(...r.notes)
      if (Object.keys(r.geo).length) audience[key] = r.geo
      else delete audience[key]
    }
    if (ask.excludedEmployers) {
      const now = ids(plainObject(audienceNow.exclusions) ? audienceNow.exclusions.work_employers : null)
      for (const id of ask.excludedEmployers.remove ?? []) if (!now.includes(id)) problems.push(`The account's controls exclude no employer ${id} to remove.`)
      const keptRows = (plainObject(audienceNow.exclusions) && Array.isArray(audienceNow.exclusions.work_employers) ? audienceNow.exclusions.work_employers : [])
        .filter((x) => !(ask.excludedEmployers!.remove ?? []).includes(plainObject(x) ? String(x.id) : String(x)))
      const added = uniq(ask.excludedEmployers.add ?? []).filter((id) => !now.includes(id)).map((id) => ({ id }))
      const next = [...keptRows, ...added]
      if (next.length) audience.exclusions = { work_employers: next }
      else delete audience.exclusions
    }
    if (ask.placementExclusions !== undefined || ask.campaignIdsForAdvantagePlacements !== undefined) {
      placement = { ...(placement ?? {}) }
      // The whole list asked, plus what Meta holds that it documents nowhere (kept exactly as Meta holds it).
      if (ask.placementExclusions !== undefined) placement.placement_exclusions = uniq([...ask.placementExclusions, ...kept])
      if (ask.campaignIdsForAdvantagePlacements !== undefined) {
        if (ask.campaignIdsForAdvantagePlacements.length) placement.campaign_ids_to_set_ap = uniq(ask.campaignIdsForAdvantagePlacements)
        else delete placement.campaign_ids_to_set_ap
      }
    }
  }
  // 1870199 (review A3) — location_types left out silently only when it is Meta's only option (home AND recent); another
  // value stays unless the change rewrites those places (then its widening is said: controlsWider).
  for (const key of ['geo_locations', 'excluded_geo_locations']) {
    if (plainObject(audience[key]) && isDefaultLocationTypes((audience[key] as Row).location_types)) audience[key] = Object.fromEntries(Object.entries(audience[key] as Row).filter(([k]) => k !== 'location_types'))
  }
  const excludedTypes = plainObject(audienceNow.excluded_geo_locations) ? audienceNow.excluded_geo_locations.location_types : undefined
  if (ask.excludedLocations && excludedTypes !== undefined && !isDefaultLocationTypes(excludedTypes)) notes.push(`The account's excluded places lose location_types ${JSON.stringify(excludedTypes)} (Meta asks for it to go, 1870199): Meta then excludes people living in or recently in them — more people excluded.`)
  if (problems.length) return { refusal: `Nothing was asked of Meta: ${problems.join(' ')}` }
  const audienceProblem = audienceControlsProblem(audience)
  if (audienceProblem) return { refusal: `Nothing was asked of Meta: ${audienceProblem}.` }
  if (placement) { const p = placementControlsProblem(placement); if (p) return { refusal: `Nothing was asked of Meta: ${p}.` } }
  if (typeof audience.age_min === 'number' && audience.age_min < 18) {
    const youth = mayReach(audience.geo_locations, NO_YOUTH_COUNTRIES, audienceNow.geo_locations)
    if (youth.reaches) return { refusal: `Nothing was asked of Meta: a minimum age under 18 would let campaigns reach people under 18 in the EU, the EEA or Switzerland (${youth.why ?? 'the controls allow every location'}), which Meta does not allow.` }
  }
  const sameAudience = sameTargeting(audienceNow, audience)
  const samePlacement = sameTargeting(placementNow ?? { placement_exclusions: [] }, placement ?? { placement_exclusions: [] })
  if (sameAudience && samePlacement) return { refusal: 'Nothing to change: the ad account\'s controls already read so.' }
  const wider = controlsWider({ audience: audienceNow, placement: placementNow }, { audience, placement })
  const lines: Array<[string, unknown, unknown]> = []
  if (!sameJson(audienceNow.age_min ?? null, audience.age_min ?? null)) lines.push(['minimum age (every campaign)', audienceNow.age_min ?? 'none', audience.age_min ?? 'none'])
  if (!sameTargeting(audienceNow.geo_locations ?? null, audience.geo_locations ?? null)) lines.push(['allowed locations', geoWords(audienceNow.geo_locations), geoWords(audience.geo_locations)])
  if (!sameTargeting(audienceNow.excluded_geo_locations ?? null, audience.excluded_geo_locations ?? null)) lines.push(['excluded locations', geoWords(audienceNow.excluded_geo_locations), geoWords(audience.excluded_geo_locations)])
  if (!sameTargeting(audienceNow.exclusions ?? null, audience.exclusions ?? null)) lines.push(['excluded employers', ids(plainObject(audienceNow.exclusions) ? audienceNow.exclusions.work_employers : null).join(', ') || 'none', ids(plainObject(audience.exclusions) ? audience.exclusions.work_employers : null).join(', ') || 'none'])
  if (!samePlacement) lines.push(['placement controls', JSON.stringify(placementNow ?? {}), JSON.stringify(placement ?? {})])
  // Review A5 (d) — looser controls are SPENDS MONEY even with no campaign delivering now (they hold for every campaign
  // switched on later): the line then says nothing spends yet.
  const spendsMoney = wider.length
    ? [`Loosening the ad account's controls (${wider.join('; ')}) widens what EVERY campaign of the account may reach${live.delivering === null ? ' (Nexus could not read whether a campaign delivers now)' : live.delivering ? ' — campaigns of this account deliver now' : ' — nothing spends yet: no campaign of the account delivers now; it spends once one is switched on'}.`]
    : []
  const warnings = [
    'Account controls apply to every campaign of the ad account (Meta applies them to the campaigns they fit; the controls\' status says when some conflict).',
    'Meta has no update or delete for the controls: Nexus posts them whole — what Meta holds now with only these parts changed — and undo posts the old ones back.',
    ...(undocumented.length ? [`The controls also hold ${undocumented.join(', ')}, which Meta documents nowhere: Nexus posts ${undocumented.length === 1 ? 'it' : 'them'} back exactly as Meta holds ${undocumented.length === 1 ? 'it' : 'them'} and never sets ${undocumented.length === 1 ? 'it' : 'them'}.`] : []),
    ...(placement && Array.isArray(placement.campaign_ids_to_set_ap) && placement.campaign_ids_to_set_ap.length ? ['Meta documents campaign_ids_to_set_ap only by its name and type (campaign ids): what it does to those campaigns is not documented; if Meta refuses, its own words say why.'] : []),
    ...(plainObject(c.perObjective) && 'unread' in c.perObjective ? [`Meta did not let Nexus read the per-objective placement controls (${String(c.perObjective.unread)}): if the account holds any, Meta decides whether this POST keeps them.`] : []),
    ...(!c.exists ? ['The ad account has no controls yet: undo cannot remove them again (Meta has no delete) — it would post the loosest values instead, which a person then sets in Ads Manager.'] : []),
    'Meta refuses an exclusion other than employers (1870219), too many employers (1870220) and restricted locations (2641) in its own words.',
    ...notes,
  ]
  const act = `act_${live.adAccountId}`
  const { changes } = changeLines(lines)
  return {
    summary: 'Meta: set the ad account\'s controls (every campaign of the account).',
    changes, totals: { requests: 1 }, warnings, spendsMoney, skipped: [],
    requests: [{
      step: 1,
      label: 'Set the ad account\'s controls',
      objectKind: 'adaccount',
      objectId: act,
      params: { audience_controls: JSON.stringify(audience), ...(placement ? { placement_controls: JSON.stringify(placement) } : {}) },
      check: 'none',
      raisesSpend: wider.length > 0,
      readBackInPost: false,
      budget: false,
      undoable: c.exists,
      operation: 'adaccount.accountControls',
      edge: 'account_controls',
      readBackOf: `${act}/account_controls`,
      readBackFields: 'audience_controls,placement_controls,status',
      judge: controlsJudge(audience, placement),
    }],
    stands: { controls: targetingView({ audience: audienceNow, placement: placementNow }), exists: c.exists, delivering: wider.length ? live.delivering : 'not read' },
    before: { exists: c.exists, audience: audienceNow, placement: placementNow } satisfies AccountControlsRecord,
    after: { exists: true, audience: targetingView(audience), placement: targetingView(placement) } satisfies AccountControlsRecord,
  }
}
