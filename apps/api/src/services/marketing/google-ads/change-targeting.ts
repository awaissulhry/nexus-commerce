/**
 * Google Ads changes, PR 2 (2026-10-15) — a campaign's targeting: locations (targeted or excluded), languages, the ad
 * schedule (replaced as a whole: Google's schedule criteria cannot be updated, only removed and made again — checked
 * 2026-10-15, AdScheduleInfo "required for CREATE operations and is prohibited on UPDATE operations") and audiences, which
 * Nexus adds in OBSERVATION only (TargetRestriction AUDIENCE bid_only true: they set bids, they never narrow who sees the
 * ads). The location option (presence only) is a campaign setting: set-google-campaign.
 *
 * Money: what lets the ads show to more people is in `spendsMoney` — a new targeted location or language, an exclusion
 * removed, more hours in the schedule, and above all removing the LAST targeted location or language (then the ads can
 * show everywhere / in every language).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { scheduleCriteria, type ScheduleCriterion, type ScheduleSlot } from './change-campaigns.js'
import type { LiveCampaignDetail, LiveCriterion } from './live.js'
import type { GoogleMutateOperation } from './write-client.js'

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
}

export interface TargetingRecord { campaignId: string; undo: TargetingRequest }

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

export function targetingDraft(
  customer: string,
  campaignId: string,
  ask: TargetingRequest,
  live: { campaign: LiveCampaignDetail['campaign'] | null; criteria: LiveCriterion[] },
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
  const locations = live.criteria.filter((k) => k.type === 'LOCATION')
  const languages = live.criteria.filter((k) => k.type === 'LANGUAGE')
  const audiences = live.criteria.filter((k) => k.type === 'USER_INTEREST')

  // Locations
  const addedLoc: Array<{ id: string; exclude?: boolean }> = []
  for (const l of ask.addLocations ?? []) {
    if (locations.some((k) => geoId(k) === l.id && k.negative === !!l.exclude)) { skipped.push(`Location ${l.id} is already ${l.exclude ? 'excluded' : 'targeted'}.`); continue }
    if (locations.some((k) => geoId(k) === l.id && k.negative !== !!l.exclude)) return { refusal: `Location ${l.id} is already ${l.exclude ? 'targeted' : 'excluded'}: remove it first (removeLocations), in the same request.`.replace(', in the same request', '') }
    if (l.bidModifier !== undefined && (l.exclude || !(l.bidModifier >= 0.1 && l.bidModifier <= 10))) return { refusal: `Location ${l.id}: a bid adjustment is for a targeted location, between 0.1 and 10.` }
    ops.push({ campaignCriterionOperation: { create: { campaign: res, ...(l.exclude ? { negative: true } : {}), location: { geoTargetConstant: `geoTargetConstants/${l.id}` }, ...(l.bidModifier !== undefined && l.bidModifier !== 1 ? { bidModifier: l.bidModifier } : {}) } } })
    addedLoc.push({ id: l.id, ...(l.exclude ? { exclude: true } : {}) })
  }
  const removedLoc: Array<{ id: string; exclude?: boolean }> = []
  for (const l of ask.removeLocations ?? []) {
    const found = locations.find((k) => geoId(k) === l.id && k.negative === !!l.exclude)
    if (!found) { skipped.push(`Location ${l.id} is not ${l.exclude ? 'excluded' : 'targeted'} in "${c.name}".`); continue }
    ops.push({ campaignCriterionOperation: { remove: crit(found.criterionId) } })
    removedLoc.push({ id: l.id, ...(l.exclude ? { exclude: true } : {}), ...(found.bidModifier !== null && found.bidModifier !== 1 ? { bidModifier: found.bidModifier } : {}) })
  }
  const targetedBefore = locations.filter((k) => !k.negative).length
  const targetedAfter = targetedBefore + addedLoc.filter((l) => !l.exclude).length - removedLoc.filter((l) => !l.exclude).length
  if (addedLoc.length || removedLoc.length) {
    lines.push(['locations', `${targetedBefore} targeted, ${locations.length - targetedBefore} excluded`, `${targetedAfter} targeted, ${locations.length - targetedBefore + addedLoc.filter((l) => l.exclude).length - removedLoc.filter((l) => l.exclude).length} excluded`])
    if (addedLoc.some((l) => !l.exclude) && targetedBefore > 0) spends.push(`Targets ${plural(addedLoc.filter((l) => !l.exclude).length, 'more location')}: the ads can reach more people${note}.`)
    if (removedLoc.some((l) => l.exclude)) spends.push(`Removes ${plural(removedLoc.filter((l) => l.exclude).length, 'excluded location')}: the ads can show there again${note}.`)
    if (targetedBefore > 0 && targetedAfter === 0) spends.push(`Removes the LAST targeted location: the ads can show in EVERY country${note}.`)
    if (targetedBefore === 0 && addedLoc.some((l) => !l.exclude)) warnings.push('The campaign targeted every country before: it now targets only the locations asked.')
    if (addedLoc.length) undo.removeLocations = addedLoc
    if (removedLoc.length) undo.addLocations = removedLoc
  }

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

  // Audiences (observation only)
  const addedAud: string[] = []
  for (const id of [...new Set(ask.addAudiences ?? [])]) {
    if (audiences.some((k) => audienceId(k) === id)) { skipped.push(`Audience ${id} is already on "${c.name}".`); continue }
    ops.push({ campaignCriterionOperation: { create: { campaign: res, userInterest: { userInterestCategory: `${customer}/userInterests/${id}` } } } })
    addedAud.push(id)
  }
  const removedAud: string[] = []
  for (const id of [...new Set(ask.removeAudiences ?? [])]) {
    const found = audiences.find((k) => audienceId(k) === id)
    if (!found) { skipped.push(`Audience ${id} is not on "${c.name}".`); continue }
    ops.push({ campaignCriterionOperation: { remove: crit(found.criterionId) } })
    removedAud.push(id)
  }
  if (addedAud.length) {
    const audienceMode = c.audienceMode.find((t) => t.dimension === 'AUDIENCE')
    // Nexus adds audiences in observation only, and never turns targeting into observation by itself (that widens who
    // sees the ads, and an undo could not put the narrowing back).
    if (audienceMode && !audienceMode.observationOnly) {
      return { refusal: `"${c.name}" sets its audiences to TARGETING (they narrow who sees the ads). Nexus adds audiences in observation only: change the audience setting in Google Ads first, or leave the audiences as they are.` }
    }
    if (!audienceMode) {
      const others = c.audienceMode.map((t) => ({ targetingDimension: t.dimension, bidOnly: t.observationOnly }))
      ops.unshift({ campaignOperation: { update: { resourceName: res, targetingSetting: { targetRestrictions: [...others, { targetingDimension: 'AUDIENCE', bidOnly: true }] } }, updateMask: 'targeting_setting.target_restrictions' } })
    }
    undo.removeAudiences = addedAud
  }
  if (removedAud.length) undo.addAudiences = removedAud
  if (addedAud.length || removedAud.length) lines.push(['audiences (observation)', audiences.length, audiences.length + addedAud.length - removedAud.length])

  if (!ops.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes } = changeLines(lines)
  return {
    summary: `Google Ads campaign "${c.name}": change its targeting (${lines.map((l) => l[0]).join(', ')}).`,
    changes,
    totals: { operations: ops.length, locationsAdded: addedLoc.length, locationsRemoved: removedLoc.length, languagesAdded: addedLang.length, languagesRemoved: removedLang.length, audiencesAdded: addedAud.length, audiencesRemoved: removedAud.length },
    warnings,
    spendsMoney: spends,
    skipped,
    operations: ops,
    stands: {
      campaignId: c.campaignId,
      status: c.status,
      criteria: live.criteria.filter((k) => ['LOCATION', 'LANGUAGE', 'AD_SCHEDULE', 'USER_INTEREST'].includes(k.type ?? ''))
        .map((k) => `${k.type}:${k.negative ? '-' : ''}${geoId(k) || languageId(k) || audienceId(k) || JSON.stringify(k.schedule)}`).sort(),
      audienceMode: c.audienceMode,
    },
    before: null,
    after: { campaignId: c.campaignId, undo } satisfies TargetingRecord,
  }
}
