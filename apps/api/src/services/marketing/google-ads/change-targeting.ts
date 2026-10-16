/**
 * Google Ads changes, PR 2 (2026-10-15) — a campaign's targeting: locations (targeted or excluded), languages, the ad
 * schedule (replaced as a whole: Google's schedule criteria cannot be updated, only removed and made again — checked
 * 2026-10-15, AdScheduleInfo "required for CREATE operations and is prohibited on UPDATE operations") and audiences, which
 * Nexus adds in OBSERVATION only (TargetRestriction AUDIENCE bid_only true: they set bids, they never narrow who sees the
 * ads). The location option (presence only) is a campaign setting: set-google-campaign.
 *
 * Programme 2 G2 (2026-10-15) adds, checked with curl in the v25 reference (rpc/v25 CampaignCriterion, AdGroupBidModifier,
 * AdGroupBidModifierOperation, DeviceInfo, ProximityInfo, GeoPointInfo, AddressInfo, ProximityRadiusUnits, Device; the
 * criteria guide docs/targeting/criteria; the bid modifiers guide docs/targeting/bid-modifiers; CriterionError):
 * - Devices: a campaign's device criterion (DEVICE, positive only) carries the bid_modifier, 0.1–10, or 0 to opt out of the
 *   device. Google never lets a device criterion be removed (CriterionError.CANNOT_REMOVE_CRITERION), so "no adjustment"
 *   is ×1. An ad group's own device adjustment is an AdGroupBidModifier (device; 0 opts out too); removing it lets the
 *   campaign's apply again. An ad group's adjustment replaces the campaign's for that device, and is not used while the
 *   campaign opts out of the device (Google Ads Help 2732132; CANNOT_BID_MODIFY_CRITERION_CAMPAIGN_OPTED_OUT).
 * - A targeted location's (or radius's) bid adjustment is an UPDATE of its criterion (bid_modifier is not immutable; the
 *   location itself is).
 * - Radius (proximity) targeting: campaign level, positive only (Google cannot exclude a radius: location guide), a geo
 *   point (micro degrees) or an address Google geocodes, a radius and KILOMETERS or MILES (default KILOMETERS).
 *
 * Interests (addAudiences / removeAudiences) are a shorthand for targeted interest segments the campaign OBSERVES: they
 * change no one's reach. Exclusions, segments that narrow (TARGETING, said or Google's default), segments with a bid
 * adjustment and anything at the ad groups are set-google-audiences', whose undo and money lines cover them. Adding the
 * first interest sets the campaign's audience setting to OBSERVATION only when no segment narrows anywhere in the
 * campaign (else that would widen who sees the ads); undo takes that setting off again (clearAudienceSetting).
 *
 * Money: what lets the ads show to more people is in `spendsMoney` — a new targeted location, radius or language, an
 * exclusion removed, more hours in the schedule, a device shown again, any bid adjustment raised, and above all removing
 * the LAST targeted location or language (then the ads can show everywhere / in every language).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { scheduleCriteria, type ScheduleCriterion, type ScheduleSlot } from './change-campaigns.js'
import type { LiveCampaignDetail, LiveCriterion } from './live.js'
import {
  adjustmentWords, AUDIENCE_KINDS, smartBiddingWords,
  type AdGroupDeviceModifier, type AdGroupTargetingCriterion, type Device, type SegmentName, type TargetingAdGroup, type TargetingCriterion,
} from './live-targeting.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

/** A radius around a point (latitude / longitude in degrees) or around an address Google geocodes. */
export interface RadiusSpec {
  latitude?: number
  longitude?: number
  address?: { street?: string; city?: string; postalCode?: string; countryCode: string }
  radius: number
  units?: 'KILOMETERS' | 'MILES'
  bidModifier?: number
}

export interface TargetingRequest {
  /** `bidModifier`: a targeted location's bid adjustment (undo puts a removed location back with its own). */
  addLocations?: Array<{ id: string; exclude?: boolean; bidModifier?: number }>
  removeLocations?: Array<{ id: string; exclude?: boolean }>
  addLanguages?: string[]
  removeLanguages?: string[]
  /** The whole week's schedule from now (replaces what is there). */
  schedule?: ScheduleSlot[]
  /** All day, every day (removes the schedule). */
  clearSchedule?: boolean
  addAudiences?: string[]
  removeAudiences?: string[]
  /**
   * Device bid adjustments: 0 = never on that device (−100 %), 0.1–10 a factor, null = none (the campaign: ×1; an ad
   * group: its own removed, the campaign's applies).
   */
  devices?: Array<{ device: Device; bidModifier: number | null; adGroupId?: string }>
  /** The bid adjustment of a location (`id`, a geo target) or radius (`radiusId`, its criterion) the campaign targets. */
  locationBids?: Array<{ id?: string; radiusId?: string; bidModifier: number | null }>
  addRadius?: RadiusSpec[]
  /** Radius criteria to remove, by criterion id. */
  removeRadius?: string[]
  /** What undo uses: take off the campaign's audience setting (OBSERVATION) that adding the first interest put there. */
  clearAudienceSetting?: boolean
}

/**
 * What a targeting change did: `undo` puts it back; `set` is what it wrote where a value changed in place (devices,
 * location bid adjustments), so undo can tell whether it still stands; `radiusOps` are the operations that made a radius
 * (their ids are known only after the run: targetingRecordAfterRun).
 */
export interface TargetingRecord {
  campaignId: string
  undo: TargetingRequest
  set?: {
    devices?: Array<{ device: string; adGroupId?: string; bidModifier: number | null }>
    locationBids?: Array<{ id?: string; radiusId?: string; bidModifier: number }>
    /** The campaign's audience setting it wrote (adding the first interest, or undo taking it off). */
    audienceSetting?: 'OBSERVATION' | 'NONE'
  }
  radiusOps?: number[]
}

/**
 * The live state a targeting change stands on: ad groups and their device adjustments when an ad group's device is
 * named; ad groups and their audience criteria when interests change; the names of the interests added.
 */
export interface TargetingLive {
  campaign: LiveCampaignDetail['campaign'] | null
  criteria: Array<LiveCriterion | TargetingCriterion>
  adGroups?: TargetingAdGroup[]
  adGroupDevices?: AdGroupDeviceModifier[]
  adGroupCriteria?: AdGroupTargetingCriterion[]
  segmentNames?: Record<string, SegmentName>
}

const geoId = (c: LiveCriterion) => (c.location ?? '').split('/').pop() ?? ''
const languageId = (c: LiveCriterion) => (c.language ?? '').split('/').pop() ?? ''
const audienceId = (c: LiveCriterion) => (c.audience ?? '').split('/').pop() ?? ''
const MINUTES: Record<string, number> = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 }

/** The schedule criteria now, as slots (one per day and time span), with their bid adjustments. */
export function scheduleNow(criteria: LiveCriterion[]): ScheduleSlot[] {
  return criteria.filter((c) => c.type === 'AD_SCHEDULE' && c.schedule).map((c) => ({
    days: [c.schedule!.day ?? ''], from: c.schedule!.from, to: c.schedule!.to,
    ...(c.bidModifier !== null && c.bidModifier !== 1 ? { bidModifier: c.bidModifier } : {}),
  }))
}

/** Minutes a week the ads may show: a week (10,080) when there is no schedule. */
function weeklyMinutes(rows: ScheduleCriterion[]): number {
  if (!rows.length) return 7 * 24 * 60
  return rows.reduce((sum, { adSchedule: r }) => sum + (r.endHour * 60 + MINUTES[r.endMinute]) - (r.startHour * 60 + MINUTES[r.startMinute]), 0)
}
const slotKey = ({ adSchedule: r }: ScheduleCriterion) => `${r.dayOfWeek}@${r.startHour}:${r.startMinute}-${r.endHour}:${r.endMinute}`
const scheduleKey = (row: ScheduleCriterion) => `${slotKey(row)}x${row.bidModifier ?? 1}`

const proximityKey = (p: NonNullable<TargetingCriterion['proximity']>) => `${p.latitudeMicro}/${p.longitudeMicro}/${p.radius}${p.units}`
const micro = (degrees: number) => Math.round(degrees * 1_000_000)
const DEVICE_WORDS: Record<string, string> = { MOBILE: 'mobile phones', DESKTOP: 'computers', TABLET: 'tablets', CONNECTED_TV: 'TV screens' }
const deviceWords = (d: string) => DEVICE_WORDS[d] ?? d

/** A radius as Google's ProximityInfo JSON: a geo point in micro degrees, or an address Google geocodes. */
export function proximityOf(r: RadiusSpec): { proximity: Record<string, unknown> } | { refusal: string } {
  const point = r.latitude !== undefined || r.longitude !== undefined
  if (point === !!r.address) return { refusal: 'A radius takes a point (latitude and longitude) or an address, one of them.' }
  if (point && (r.latitude === undefined || r.longitude === undefined)) return { refusal: 'A radius point needs both latitude and longitude.' }
  return { proximity: {
    ...(point ? { geoPoint: { latitudeInMicroDegrees: micro(r.latitude!), longitudeInMicroDegrees: micro(r.longitude!) } } : {}),
    ...(r.address ? {
      address: {
        ...(r.address.street ? { streetAddress: r.address.street } : {}),
        ...(r.address.city ? { cityName: r.address.city } : {}),
        ...(r.address.postalCode ? { postalCode: r.address.postalCode } : {}),
        countryCode: r.address.countryCode.toUpperCase(),
      },
    } : {}),
    radius: r.radius,
    radiusUnits: r.units ?? 'KILOMETERS',
  } }
}

export function targetingDraft(
  customer: string,
  campaignId: string,
  ask: TargetingRequest,
  live: TargetingLive,
): GoogleChangeDraft | { refusal: string } {
  const c = live.campaign
  if (!c) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed).` }
  if (c.type !== 'SEARCH' && c.type !== 'SHOPPING') return { refusal: `"${c.name}" is a ${c.type ?? 'campaign'} campaign: Nexus changes the targeting of Search and Standard Shopping campaigns.` }
  if ((ask.addLanguages?.length || ask.removeLanguages?.length) && c.type === 'SHOPPING') return { refusal: 'A Standard Shopping campaign has no languages: its products come from the feed.' }
  if (ask.schedule && ask.clearSchedule) return { refusal: 'Give schedule (the whole week) or clearSchedule, not both.' }
  const res = `${customer}/campaigns/${c.campaignId}`
  const crit = (id: string) => `${customer}/campaignCriteria/${c.campaignId}~${id}`
  const note = c.status === 'ENABLED' ? '' : ' (the campaign is paused: nothing spends until it is enabled)'
  const ops: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const undo: TargetingRequest = {}
  const set: NonNullable<TargetingRecord['set']> = {}
  /** The operations that make a radius (their ids come back from Google: targetingRecordAfterRun). */
  const radiusCreates: GoogleMutateOperation[] = []
  const criteria = live.criteria as TargetingCriterion[]
  const locations = criteria.filter((k) => k.type === 'LOCATION')
  const radii = criteria.filter((k) => k.type === 'PROXIMITY' && k.proximity)
  const languages = criteria.filter((k) => k.type === 'LANGUAGE')
  const audiences = criteria.filter((k) => k.type === 'USER_INTEREST')
  let adjustedDevice = false
  let adjustedPlace = false

  // Locations
  const addedLoc: Array<{ id: string; exclude?: boolean }> = []
  for (const l of ask.addLocations ?? []) {
    if (locations.some((k) => geoId(k) === l.id && k.negative === !!l.exclude)) { skipped.push(`Location ${l.id} is already ${l.exclude ? 'excluded' : 'targeted'}.`); continue }
    if (locations.some((k) => geoId(k) === l.id && k.negative !== !!l.exclude)) return { refusal: `Location ${l.id} is already ${l.exclude ? 'targeted' : 'excluded'}: remove it first (removeLocations), in the same request.`.replace(', in the same request', '') }
    if (l.bidModifier !== undefined && (l.exclude || !(l.bidModifier >= 0.1 && l.bidModifier <= 10))) return { refusal: `Location ${l.id}: a bid adjustment is for a targeted location, between 0.1 and 10.` }
    ops.push({ campaignCriterionOperation: { create: { campaign: res, ...(l.exclude ? { negative: true } : {}), location: { geoTargetConstant: `geoTargetConstants/${l.id}` }, ...(l.bidModifier !== undefined && l.bidModifier !== 1 ? { bidModifier: l.bidModifier } : {}) } } })
    addedLoc.push({ id: l.id, ...(l.exclude ? { exclude: true } : {}) })
    if (l.bidModifier !== undefined && l.bidModifier > 1) spends.push(`Bids ${adjustmentWords(l.bidModifier)} in location ${l.id}${note}.`)
  }
  const removedLoc: Array<{ id: string; exclude?: boolean }> = []
  for (const l of ask.removeLocations ?? []) {
    const found = locations.find((k) => geoId(k) === l.id && k.negative === !!l.exclude)
    if (!found) { skipped.push(`Location ${l.id} is not ${l.exclude ? 'excluded' : 'targeted'} in "${c.name}".`); continue }
    ops.push({ campaignCriterionOperation: { remove: crit(found.criterionId) } })
    removedLoc.push({ id: l.id, ...(l.exclude ? { exclude: true } : {}), ...(found.bidModifier !== null && found.bidModifier !== 1 ? { bidModifier: found.bidModifier } : {}) })
  }
  // Radius targeting (proximity): a targeted area like a location; Google cannot exclude one.
  const addedRadius: RadiusSpec[] = []
  for (const r of ask.addRadius ?? []) {
    const made = proximityOf(r)
    if ('refusal' in made) return made
    const { proximity } = made
    if (r.bidModifier !== undefined && !(r.bidModifier >= 0.1 && r.bidModifier <= 10)) return { refusal: 'A radius\'s bid adjustment is between 0.1 and 10.' }
    const units = r.units ?? 'KILOMETERS'
    if (r.latitude !== undefined && radii.some((k) => proximityKey(k.proximity!) === `${micro(r.latitude!)}/${micro(r.longitude!)}/${r.radius}${units}`)) {
      skipped.push(`A ${r.radius} ${units.toLowerCase()} radius around ${r.latitude}, ${r.longitude} is already targeted.`)
      continue
    }
    const op = { campaignCriterionOperation: { create: { campaign: res, proximity, ...(r.bidModifier !== undefined && r.bidModifier !== 1 ? { bidModifier: r.bidModifier } : {}) } } }
    ops.push(op)
    radiusCreates.push(op)
    addedRadius.push(r)
    if (r.bidModifier !== undefined && r.bidModifier > 1) spends.push(`Bids ${adjustmentWords(r.bidModifier)} in the new ${r.radius} ${units.toLowerCase()} radius${note}.`)
  }
  const removedRadius: RadiusSpec[] = []
  for (const id of [...new Set(ask.removeRadius ?? [])]) {
    const found = radii.find((k) => k.criterionId === id)
    if (!found) { skipped.push(`Radius ${id} is not targeted in "${c.name}".`); continue }
    const p = found.proximity!
    if (p.latitudeMicro === null || p.longitudeMicro === null || p.radius === null) return { refusal: `Radius ${id}: Google did not give back its point and radius, so undo could not put it back. Change it in Google Ads.` }
    ops.push({ campaignCriterionOperation: { remove: crit(id) } })
    removedRadius.push({
      latitude: p.latitudeMicro / 1_000_000, longitude: p.longitudeMicro / 1_000_000, radius: p.radius, units: p.units === 'MILES' ? 'MILES' : 'KILOMETERS',
      ...(found.bidModifier !== null && found.bidModifier !== 1 ? { bidModifier: found.bidModifier } : {}),
    })
  }
  // Places: targeted locations and radii (none = every country).
  const targetedBefore = locations.filter((k) => !k.negative).length + radii.length
  const targetedAfter = targetedBefore + addedLoc.filter((l) => !l.exclude).length - removedLoc.filter((l) => !l.exclude).length + addedRadius.length - removedRadius.length
  const excludedBefore = locations.filter((k) => k.negative).length
  if (addedLoc.length || removedLoc.length || addedRadius.length || removedRadius.length) {
    lines.push(['locations', `${targetedBefore} targeted, ${excludedBefore} excluded`, `${targetedAfter} targeted, ${excludedBefore + addedLoc.filter((l) => l.exclude).length - removedLoc.filter((l) => l.exclude).length} excluded`])
    if (radii.length || addedRadius.length) lines.push(['radius targets', radii.length, radii.length + addedRadius.length - removedRadius.length])
    const more = addedLoc.filter((l) => !l.exclude).length + addedRadius.length
    if (more && targetedBefore > 0) spends.push(`Targets ${plural(more, 'more location')}: the ads can reach more people${note}.`)
    if (removedLoc.some((l) => l.exclude)) spends.push(`Removes ${plural(removedLoc.filter((l) => l.exclude).length, 'excluded location')}: the ads can show there again${note}.`)
    if (targetedBefore > 0 && targetedAfter === 0) spends.push(`Removes the LAST targeted location: the ads can show in EVERY country${note}.`)
    if (targetedBefore === 0 && more) warnings.push('The campaign targeted every country before: it now targets only the locations asked.')
    if (addedLoc.length) undo.removeLocations = addedLoc
    if (removedLoc.length) undo.addLocations = removedLoc
    if (removedRadius.length) undo.addRadius = removedRadius
  }

  // Bid adjustments of locations and radii the campaign targets (an update: the location itself stays).
  const seenBid = new Set<string>()
  for (const b of ask.locationBids ?? []) {
    if (!b.id === !b.radiusId) return { refusal: 'A location bid adjustment names a location (id) or a radius (radiusId), one of them.' }
    const key = b.id ? `loc:${b.id}` : `radius:${b.radiusId}`
    if (seenBid.has(key)) return { refusal: `${b.id ? `Location ${b.id}` : `Radius ${b.radiusId}`} is named twice in locationBids.` }
    seenBid.add(key)
    if (b.id && removedLoc.some((l) => l.id === b.id && !l.exclude)) return { refusal: `Location ${b.id} is removed in this request: it has no bid adjustment to change.` }
    if (b.radiusId && removedRadius.length && (ask.removeRadius ?? []).includes(b.radiusId)) return { refusal: `Radius ${b.radiusId} is removed in this request: it has no bid adjustment to change.` }
    const found = b.id ? locations.find((k) => geoId(k) === b.id && !k.negative) : radii.find((k) => k.criterionId === b.radiusId)
    if (!found) {
      if (b.id && locations.some((k) => geoId(k) === b.id && k.negative)) return { refusal: `Location ${b.id} is excluded: an excluded location has no bid adjustment.` }
      skipped.push(`${b.id ? `Location ${b.id}` : `Radius ${b.radiusId}`} is not targeted in "${c.name}" (a new one takes its bidModifier where it is added).`)
      continue
    }
    const from = found.bidModifier ?? 1
    const to = b.bidModifier ?? 1
    if (from === to) { skipped.push(`${b.id ? `Location ${b.id}` : `Radius ${b.radiusId}`} already has this bid adjustment (${adjustmentWords(to)}).`); continue }
    ops.push({ campaignCriterionOperation: { update: { resourceName: crit(found.criterionId), bidModifier: to }, updateMask: 'bid_modifier' } })
    lines.push([`bid adjustment ${found.name ?? (b.id ? `location ${b.id}` : `radius ${b.radiusId}`)}`, adjustmentWords(from), adjustmentWords(to)])
    if (to > from) spends.push(`Raises the bid adjustment of ${found.name ?? (b.id ? `location ${b.id}` : `radius ${b.radiusId}`)} (${adjustmentWords(from)} → ${adjustmentWords(to)})${note}.`)
    ;(undo.locationBids ??= []).push({ ...(b.id ? { id: b.id } : { radiusId: b.radiusId }), bidModifier: found.bidModifier === 1 ? null : found.bidModifier })
    ;(set.locationBids ??= []).push({ ...(b.id ? { id: b.id } : { radiusId: b.radiusId }), bidModifier: to })
    adjustedPlace = true
  }

  // Devices: the campaign's device criteria (never removed; ×1 = no adjustment), an ad group's own adjustment.
  const campaignDevice = new Map(criteria.filter((k) => k.type === 'DEVICE' && k.device).map((k) => [k.device!, k]))
  const deviceBefore = (d: string) => campaignDevice.get(d)?.bidModifier ?? 1
  const deviceAfter = new Map<string, number>()
  const seenDevice = new Set<string>()
  for (const d of ask.devices ?? []) {
    const key = `${d.device}@${d.adGroupId ?? ''}`
    if (seenDevice.has(key)) return { refusal: `${deviceWords(d.device)} ${d.adGroupId ? `in ad group ${d.adGroupId}` : ''} is named twice in devices.`.replace('  ', ' ') }
    seenDevice.add(key)
    if (d.bidModifier !== null && d.bidModifier !== 0 && !(d.bidModifier >= 0.1 && d.bidModifier <= 10)) return { refusal: `A device bid adjustment is 0 (never on ${deviceWords(d.device)}) or between 0.1 and 10.` }
    if (!d.adGroupId) deviceAfter.set(d.device, d.bidModifier ?? 1)
  }
  const nowhere = ['DESKTOP', 'MOBILE', 'TABLET'].every((d) => (deviceAfter.get(d) ?? deviceBefore(d)) === 0)
  if (nowhere && [...deviceAfter.values()].some((v) => v === 0)) return { refusal: `That opts "${c.name}" out of computers, mobile phones and tablets: its ads could show nowhere. Keep at least one.` }
  for (const d of (ask.devices ?? []).filter((x) => !x.adGroupId)) {
    const k = campaignDevice.get(d.device)
    const from = deviceBefore(d.device)
    const to = d.bidModifier ?? 1
    if (from === to) { skipped.push(`"${c.name}" already has ${adjustmentWords(to) === 'none' ? 'no adjustment' : adjustmentWords(to)} for ${deviceWords(d.device)}.`); continue }
    ops.push(k
      ? { campaignCriterionOperation: { update: { resourceName: crit(k.criterionId), bidModifier: to }, updateMask: 'bid_modifier' } }
      : { campaignCriterionOperation: { create: { campaign: res, device: { type: d.device }, bidModifier: to } } })
    lines.push([`${deviceWords(d.device)}`, adjustmentWords(from), adjustmentWords(to)])
    if (to > from) spends.push(from === 0 ? `Shows the ads on ${deviceWords(d.device)} again (they were excluded)${note}.` : `Raises the ${deviceWords(d.device)} bid adjustment (${adjustmentWords(from)} → ${adjustmentWords(to)})${note}.`)
    ;(undo.devices ??= []).push({ device: d.device, bidModifier: k?.bidModifier === undefined || k.bidModifier === 1 ? null : k.bidModifier })
    ;(set.devices ??= []).push({ device: d.device, bidModifier: to })
    if (to !== 0) adjustedDevice = true
  }
  const groupDevices = (ask.devices ?? []).filter((x) => x.adGroupId)
  if (groupDevices.length) {
    const adGroups = live.adGroups ?? []
    const mods = live.adGroupDevices ?? []
    for (const d of groupDevices) {
      const ag = adGroups.find((a) => a.adGroupId === d.adGroupId)
      if (!ag) return { refusal: `Ad group ${d.adGroupId} is not in "${c.name}" (or it is removed).` }
      const campaignTo = deviceAfter.get(d.device) ?? deviceBefore(d.device)
      if (campaignTo === 0 && d.bidModifier !== null) return { refusal: `"${c.name}" opts out of ${deviceWords(d.device)} (−100 %): Google does not use an ad group's adjustment for it then. Change the campaign's first.` }
      const m = mods.find((x) => x.adGroupId === d.adGroupId && x.device === d.device)
      const from = m ? m.bidModifier : null
      const to = d.bidModifier
      if (from === to || (!m && to === null)) { skipped.push(`Ad group "${ag.name}" already has ${to === null ? 'no adjustment of its own' : adjustmentWords(to)} for ${deviceWords(d.device)}.`); continue }
      const resource = m ? `${customer}/adGroupBidModifiers/${ag.adGroupId}~${m.criterionId}` : null
      if (resource && to === null) ops.push({ adGroupBidModifierOperation: { remove: resource } })
      else if (resource) ops.push({ adGroupBidModifierOperation: { update: { resourceName: resource, bidModifier: to }, updateMask: 'bid_modifier' } })
      else ops.push({ adGroupBidModifierOperation: { create: { adGroup: `${customer}/adGroups/${ag.adGroupId}`, device: { type: d.device }, bidModifier: to } } })
      // An ad group's own adjustment replaces the campaign's for that device (Google Ads Help 2732132).
      const effectiveFrom = from ?? deviceBefore(d.device)
      const effectiveTo = to ?? campaignTo
      lines.push([`${deviceWords(d.device)}, ad group "${ag.name}"`, from === null ? `the campaign's (${adjustmentWords(deviceBefore(d.device))})` : adjustmentWords(from), to === null ? `the campaign's (${adjustmentWords(campaignTo)})` : adjustmentWords(to)])
      const agNote = ag.status === 'ENABLED' ? note : ' (the ad group is paused: nothing spends until it is enabled)'
      if (effectiveTo > effectiveFrom) spends.push(effectiveFrom === 0 ? `Shows the ads of ad group "${ag.name}" on ${deviceWords(d.device)} again${agNote}.` : `Raises the ${deviceWords(d.device)} bid adjustment of ad group "${ag.name}" (${adjustmentWords(effectiveFrom)} → ${adjustmentWords(effectiveTo)})${agNote}.`)
      ;(undo.devices ??= []).push({ device: d.device, adGroupId: ag.adGroupId, bidModifier: from })
      ;(set.devices ??= []).push({ device: d.device, adGroupId: ag.adGroupId, bidModifier: to })
      if (to !== null && to !== 0) adjustedDevice = true
    }
  }
  // Smart Bidding (Google Ads Help 2732132): a device adjustment is −100 % only, or changes the CPA target; location
  // and radius adjustments are not used.
  const adjustedNewPlace = (ask.addLocations ?? []).some((l) => !l.exclude && l.bidModifier !== undefined && l.bidModifier !== 1) || (ask.addRadius ?? []).some((r) => r.bidModifier !== undefined && r.bidModifier !== 1)
  const smartDevice = adjustedDevice ? smartBiddingWords(c, 'device') : null
  const placeWords = adjustedPlace || adjustedNewPlace ? smartBiddingWords(c, 'other') : null
  if (smartDevice) warnings.push(smartDevice)
  if (placeWords) warnings.push(placeWords.replace('these bid adjustments', 'location and radius bid adjustments'))

  // Languages
  const addedLang: string[] = []
  for (const id of [...new Set(ask.addLanguages ?? [])]) {
    if (languages.some((k) => languageId(k) === id)) { skipped.push(`Language ${id} is already targeted.`); continue }
    ops.push({ campaignCriterionOperation: { create: { campaign: res, language: { languageConstant: `languageConstants/${id}` } } } })
    addedLang.push(id)
  }
  const removedLang: string[] = []
  for (const id of [...new Set(ask.removeLanguages ?? [])]) {
    const found = languages.find((k) => languageId(k) === id)
    if (!found) { skipped.push(`Language ${id} is not targeted in "${c.name}".`); continue }
    ops.push({ campaignCriterionOperation: { remove: crit(found.criterionId) } })
    removedLang.push(id)
  }
  if (addedLang.length || removedLang.length) {
    const after = languages.length + addedLang.length - removedLang.length
    lines.push(['languages', languages.length ? languages.map((k) => k.name ?? languageId(k)).join(', ') : 'all', `${after ? `${after} language${after === 1 ? '' : 's'}` : 'all'}`])
    if (addedLang.length && languages.length > 0) spends.push(`Targets ${plural(addedLang.length, 'more language')}: more searches can show the ads${note}.`)
    if (languages.length > 0 && after === 0) spends.push(`Removes the LAST language: the ads can show to people of EVERY language${note}.`)
    if (addedLang.length) undo.removeLanguages = addedLang
    if (removedLang.length) undo.addLanguages = removedLang
  }

  // Schedule
  if (ask.schedule || ask.clearSchedule) {
    const nowRows = live.criteria.filter((k) => k.type === 'AD_SCHEDULE' && k.schedule)
    const nowSlots = scheduleNow(live.criteria)
    const nowCriteria = scheduleCriteria(nowSlots)
    const wanted = ask.clearSchedule ? [] : scheduleCriteria(ask.schedule!)
    if ('refusal' in wanted) return wanted
    if ('refusal' in nowCriteria) return { refusal: 'The campaign\'s schedule now holds times Nexus cannot read back. Change it in Google Ads.' }
    const same = nowCriteria.length === wanted.length && nowCriteria.map(scheduleKey).sort().join('|') === wanted.map(scheduleKey).sort().join('|')
    if (same) skipped.push(`"${c.name}" already has this schedule.`)
    else {
      for (const k of nowRows) ops.push({ campaignCriterionOperation: { remove: crit(k.criterionId) } })
      for (const s of wanted) ops.push({ campaignCriterionOperation: { create: { campaign: res, ...s } } })
      const before = weeklyMinutes(nowCriteria)
      const after = weeklyMinutes(wanted)
      // A slot that stays with a higher bid adjustment (or loses a lowering one) bids more at the same hours.
      const oldModifier = new Map(nowCriteria.map((r) => [slotKey(r), r.bidModifier ?? 1]))
      const raised = wanted.filter((r) => oldModifier.has(slotKey(r)) && (r.bidModifier ?? 1) > oldModifier.get(slotKey(r))!).length
      if (raised) spends.push(`Raises the bid adjustment of ${plural(raised, 'schedule slot')}${note}.`)
      lines.push(['ad schedule', nowCriteria.length ? `${nowCriteria.length} slots, ${Math.round(before / 60)} h a week` : 'all day, every day', wanted.length ? `${wanted.length} slots, ${Math.round(after / 60)} h a week` : 'all day, every day'])
      if (after > before) spends.push(`The ads may show ${Math.round((after - before) / 60)} more hours a week${note}.`)
      if (nowCriteria.length) undo.schedule = nowSlots
      else undo.clearSchedule = true
    }
  }

  // Interests (observation only): set-google-targeting adds and removes targeted interest segments the campaign OBSERVES —
  // nothing that changes who sees the ads. The rest is set-google-audiences.
  const campaignAudience = c.audienceMode.find((t) => t.dimension === 'AUDIENCE')
  const observes = campaignAudience?.observationOnly === true
  const toAudiences = 'use set-google-audiences, which names the mode and keeps the money lines and undo exact'
  const addedAud: string[] = []
  for (const id of [...new Set(ask.addAudiences ?? [])]) {
    if (audiences.some((k) => audienceId(k) === id && k.negative)) return { refusal: `Interest ${id} is excluded from "${c.name}": ${toAudiences}.` }
    if (audiences.some((k) => audienceId(k) === id)) { skipped.push(`Interest ${id} is already on "${c.name}".`); continue }
    if (live.segmentNames && !live.segmentNames[`USER_INTEREST|${id}`]) return { refusal: `Interest ${id} is not one of Google's interest segments (google-ads-live view lookup, lookup audiences, finds them).` }
    ops.push({ campaignCriterionOperation: { create: { campaign: res, userInterest: { userInterestCategory: `${customer}/userInterests/${id}` } } } })
    addedAud.push(id)
    lines.push([`interest "${live.segmentNames?.[`USER_INTEREST|${id}`]?.name ?? id}" (${id})`, '—', 'observed'])
  }
  const removedAud: string[] = []
  for (const id of [...new Set(ask.removeAudiences ?? [])]) {
    const found = audiences.find((k) => audienceId(k) === id && !k.negative)
    if (!found) {
      if (audiences.some((k) => audienceId(k) === id && k.negative)) return { refusal: `Interest ${id} is an exclusion of "${c.name}": removing it lets more people see the ads — ${toAudiences}.` }
      skipped.push(`Interest ${id} is not on "${c.name}".`)
      continue
    }
    if (!observes) return { refusal: `"${c.name}" uses its audiences as TARGETING (they narrow who sees the ads), so removing interest ${id} changes who sees them: ${toAudiences}.` }
    if (found.bidModifier !== null && found.bidModifier !== 1) return { refusal: `Interest ${id} has a bid adjustment (${adjustmentWords(found.bidModifier)}): ${toAudiences}, whose undo puts it back with it.` }
    ops.push({ campaignCriterionOperation: { remove: crit(found.criterionId) } })
    removedAud.push(id)
  }
  if (addedAud.length && !observes) {
    // Adding interests in observation means the campaign's audience setting becomes OBSERVATION. Where segments narrow
    // now (TARGETING said, or no setting with segments at the campaign or an ad group: Google's default is TARGETING),
    // that widens who sees the ads: never by itself.
    if (campaignAudience) return { refusal: `"${c.name}" sets its audiences to TARGETING (they narrow who sees the ads). set-google-targeting adds interests in observation only: ${toAudiences}.` }
    const narrowing = criteria.some((k) => (AUDIENCE_KINDS as readonly string[]).includes(k.type ?? '') && !k.negative)
      || (live.adGroupCriteria ?? []).some((k) => k.segment && !k.negative)
    if (narrowing) return { refusal: `"${c.name}" has audience segments (at the campaign or its ad groups) and no audience setting, so Google uses them as TARGETING (they narrow who sees the ads); setting the campaign to observation would widen that. ${toAudiences[0].toUpperCase()}${toAudiences.slice(1)}.` }
    const own = (live.adGroups ?? []).filter((a) => a.audienceMode.length)
    if (!c.audienceMode.length && own.length) return { refusal: `Ad groups of "${c.name}" (${own.slice(0, 3).map((a) => `"${a.name}"`).join(', ')}) hold their own audience setting, and Google keeps it on the campaign or its ad groups, not both: ${toAudiences}.` }
    const others = c.audienceMode.map((t) => ({ targetingDimension: t.dimension, bidOnly: t.observationOnly }))
    ops.unshift({ campaignOperation: { update: { resourceName: res, targetingSetting: { targetRestrictions: [...others, { targetingDimension: 'AUDIENCE', bidOnly: true }] } }, updateMask: 'targeting_setting.target_restrictions' } })
    lines.push(['audience setting', 'none (Google: targeting)', 'observation (bids only)'])
    set.audienceSetting = 'OBSERVATION'
    undo.clearAudienceSetting = true
  }
  if (ask.clearAudienceSetting) {
    // Undo of the above: no segment may be left that would then narrow (the setting is Google's TARGETING without it).
    if (!campaignAudience) skipped.push(`"${c.name}" has no audience setting.`)
    else {
      const left = criteria.filter((k) => (AUDIENCE_KINDS as readonly string[]).includes(k.type ?? '') && !k.negative && !removedAud.includes(audienceId(k))).length
        + addedAud.length + (live.adGroupCriteria ?? []).filter((k) => k.segment && !k.negative).length
      if (left) return { refusal: `"${c.name}" still has ${plural(left, 'audience segment')}: without its setting Google would use them as TARGETING (they would narrow who sees the ads). ${toAudiences[0].toUpperCase()}${toAudiences.slice(1)}.` }
      const others = c.audienceMode.filter((t) => t.dimension !== 'AUDIENCE').map((t) => ({ targetingDimension: t.dimension, bidOnly: t.observationOnly }))
      ops.push({ campaignOperation: { update: { resourceName: res, targetingSetting: { targetRestrictions: others } }, updateMask: 'targeting_setting.target_restrictions' } })
      lines.push(['audience setting', campaignAudience.observationOnly ? 'observation (bids only)' : 'targeting (narrows who sees the ads)', 'none (Google: targeting)'])
      set.audienceSetting = 'NONE'
    }
  }
  if (addedAud.length) undo.removeAudiences = addedAud
  if (removedAud.length) undo.addAudiences = removedAud
  if (addedAud.length || removedAud.length) lines.push(['interests (observation)', audiences.filter((k) => !k.negative).length, audiences.filter((k) => !k.negative).length + addedAud.length - removedAud.length])

  if (!ops.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes } = changeLines(lines)
  const record: TargetingRecord = { campaignId: c.campaignId, undo }
  if (Object.keys(set).length) record.set = set
  if (radiusCreates.length) record.radiusOps = radiusCreates.map((op) => ops.indexOf(op))
  return {
    summary: `Google Ads campaign "${c.name}": change its targeting (${[...new Set(lines.map((l) => l[0].replace(/^bid adjustment .*/, 'bid adjustments')))].join(', ')}).`,
    changes,
    totals: {
      operations: ops.length, locationsAdded: addedLoc.length, locationsRemoved: removedLoc.length, languagesAdded: addedLang.length, languagesRemoved: removedLang.length,
      audiencesAdded: addedAud.length, audiencesRemoved: removedAud.length, radiusAdded: addedRadius.length, radiusRemoved: removedRadius.length,
      locationBidsChanged: set.locationBids?.length ?? 0, devicesChanged: set.devices?.length ?? 0,
    },
    warnings,
    spendsMoney: spends,
    skipped,
    operations: ops,
    stands: {
      campaignId: c.campaignId,
      status: c.status,
      bidding: c.bidding,
      criteria: criteria.filter((k) => STANDS_TYPES.has(k.type ?? '')).map(standKey).sort(),
      audienceMode: c.audienceMode,
      ...(live.adGroupDevices ? { adGroupDevices: live.adGroupDevices.map((m) => `${m.adGroupId}:${m.device}x${m.bidModifier}`).sort() } : {}),
      ...(live.adGroups ? { adGroups: live.adGroups.map((a) => `${a.adGroupId}:${a.status}`).sort() } : {}),
    },
    before: null,
    after: record,
  }
}

const STANDS_TYPES = new Set(['LOCATION', 'PROXIMITY', 'LANGUAGE', 'AD_SCHEDULE', 'DEVICE', ...AUDIENCE_KINDS])
/** One criterion as the facts a targeting change stands on: what it is and its bid adjustment. */
function standKey(k: TargetingCriterion): string {
  const what = geoId(k) || languageId(k) || k.device || (k.proximity ? proximityKey(k.proximity) : '') || (k.segment ? `${k.segment.kind}:${k.segment.id}` : '') || audienceId(k) || JSON.stringify(k.schedule ?? null)
  return `${k.type}:${k.negative ? '-' : ''}${what}x${k.bidModifier ?? 1}`
}

/** After the run: the ids Google gave the radii the change made, so undo can remove exactly them. */
export function targetingRecordAfterRun(record: TargetingRecord, responses: GoogleMutateResponse[]): TargetingRecord {
  const { radiusOps, ...rest } = structuredClone(record)
  if (!radiusOps?.length) return rest
  const ids = radiusOps
    .map((i) => responses[i]?.campaignCriterionResult?.resourceName ?? '')
    .map((name) => name.slice(name.lastIndexOf('~') + 1))
    .filter((id) => /^\d+$/.test(id))
  if (ids.length) rest.undo.removeRadius = [...(rest.undo.removeRadius ?? []), ...ids]
  return rest
}
