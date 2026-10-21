/**
 * Meta step 21 — create-meta-reach-frequency as a draft: reach & frequency ("Reservation") buying on the chosen ad account
 * (AS-081–084, reference/ad-account/reachfrequencypredictions.md, marketing-api/reservation.md). Pure: the live state comes
 * in (live-labels-rules.ts, live-settings.ts), the requests and the record go out.
 *
 *   predict  POST /act_<id>/reachfrequencypredictions — a PREDICTION (a quote): Meta works out the reach for a budget, or the
 *            budget for a reach, for one country, dates (start in the future, stop at most 8 weeks ahead, at most 90 days),
 *            a frequency cap (or a target frequency) and placements. It books nothing and spends nothing (a read-like create;
 *            Meta has no delete for it: it expires). Meta answers PENDING first; the reserve preview reads its result.
 *   reserve  the same edge, action=reserve + rf_prediction_id (+ a point of its curve; a reservation it releases): BOOKING —
 *            "agreeing to pay the proposed costs for the advertising inventory you reserve" (reservation.md). SPENDS MONEY:
 *            the person's decision; the preview names the amount and the dates. Meta holds the inventory about an hour for an
 *            ad set to take it (attach). Undo: cancel, while it does not run.
 *   cancel   the same edge, action=cancel + rf_prediction_id: frees the inventory. Once a reservation runs it cannot be
 *            cancelled this way (Meta: delete its campaign to stop it, and pay for what was delivered).
 *   attach   POST /<ad set> rf_prediction_id — the ad set (in a RESERVED campaign, with an ad, not active) takes a
 *            reservation; undo: detach. SPENDS MONEY once the ad set is on and its time comes.
 *   detach   POST /<ad set> rf_prediction_id=0 (reservation.md "Detach predictions") — only before the ad set is active.
 * Meta grants reservation buying per ad account (CAN_USE_REACH_AND_FREQUENCY): without it the preview says so, and if Nexus
 * could not read the grant, Meta's refusal answers in its words. Meta has no check (validate_only) for any of these.
 * The error codes named below (1487581, 1487583, 1487671, 1487680) are on marketing-api/reservation.md "Error codes"
 * (checked 2026-10-21): an active ad set's reservation cannot change; an ad set with no ads cannot take one; no direct move
 * from one reservation to another; no permission for reservation ad sets.
 */
import type { MetaChangeDraft } from './change-draft.js'
import type { LivePrediction, RulesAdSet } from './live-labels-rules.js'
import { budgetParam, metaUnitsToMinor, MetaUnitError, unixSecondsParam } from './settings-units.js'
import { money } from './change-settings-common.js'
import { RF_DEVICE_PLATFORMS, RF_FACEBOOK_POSITIONS, RF_INSTAGRAM_POSITIONS, RF_INSTREAM_PACKAGES, RF_MAX_DAYS, RF_OBJECTIVES, RF_PRODUCT_TYPES, RF_PUBLISHER_PLATFORMS } from '../../gateway/meta-labels-rules.js'

export const RF_ACTIONS = ['predict', 'reserve', 'cancel', 'attach', 'detach'] as const
export type ReachFrequencyAction = typeof RF_ACTIONS[number]
/** Meta: a prediction's stop time is at most 8 weeks ahead (reachfrequencypredictions.md `stop_time`). */
export const RF_MAX_AHEAD_DAYS = 56
/** The ad account capability Meta grants for reservation buying (reservation.md "Restrictions"). */
export const RF_CAPABILITY = 'CAN_USE_REACH_AND_FREQUENCY'
export const RF_VIDEO_ADS = { none: 0, video: 128, canvas: 256, 'video-and-canvas': 384 } as const

export interface ReachFrequencyRequest {
  action: ReachFrequencyAction
  mode?: 'reach-from-budget' | 'budget-from-reach'
  budgetCents?: number
  reach?: number
  startTime?: string
  stopTime?: string
  frequencyCap?: number
  frequencyCapDays?: number
  targetFrequency?: number
  targetFrequencyDays?: number
  targeting?: {
    country: string
    ageMin?: number
    ageMax?: number
    genders?: Array<'male' | 'female'>
    platforms?: Array<typeof RF_PUBLISHER_PLATFORMS[number]>
    facebookPositions?: Array<typeof RF_FACEBOOK_POSITIONS[number]>
    instagramPositions?: Array<typeof RF_INSTAGRAM_POSITIONS[number]>
    devices?: Array<typeof RF_DEVICE_PLATFORMS[number]>
  }
  destinations?: Array<'page' | 'instagram'>
  objective?: typeof RF_OBJECTIVES[number]
  optimizationGoal?: string
  dayParting?: { startMinute: number; endMinute: number; days: number[]; timezone?: 'USER' | 'ADVERTISER' }
  curvePoints?: number
  videoAds?: keyof typeof RF_VIDEO_ADS
  campaignId?: string
  shareAudienceOf?: string
  existingAdSetId?: string
  productType?: typeof RF_PRODUCT_TYPES[number]
  instreamPackages?: Array<typeof RF_INSTREAM_PACKAGES[number]>
  predictionId?: string
  point?: { reach: number; budgetCents: number; impressions: number }
  releasePredictionId?: string
  adSetId?: string
}

export interface ReachFrequencyLive {
  adAccountId: string
  currency: string | null
  now: Date
  /** The ad account's capabilities (null: Nexus could not read them). */
  capabilities: string[] | null
  pageId: string | null
  instagramId: string | null
  /** reserve, cancel, attach: the prediction or reservation named, now. */
  prediction?: LivePrediction | null
  /** reserve with releasePredictionId: the reservation it releases, now. */
  released?: LivePrediction | null
  /** attach, detach: the ad set, now (and whether it has an ad). */
  adSet?: RulesAdSet | null
  adSetHasAds?: boolean
  /** predict with campaignId: that campaign's buying type. */
  campaignBuyingType?: string | null
}

export interface ReachFrequencyRecord {
  op: ReachFrequencyAction
  /** The prediction asked about (reserve, cancel), or the one made (predict). */
  predictionId?: string | null
  /** reserve: the reservation Meta made (its undo cancels it). */
  reservationId?: string | null
  adSetId?: string | null
  /** attach, detach: the reservation the ad set had before / has after. */
  adSetPrediction?: string | null
  noUndo?: string[]
}

/** A prediction's lifetime budget, in Meta's unit ("in cents" of the account currency) — the ONE helper for it. */
export const rfBudgetParam = (cents: number, currency: string | null): string => budgetParam(cents, currency)
/** A prediction's predicted budget as Meta reads it (external_budget) → minor units of the account currency. */
export const rfBudgetCents = (value: unknown, currency: string | null): number | null => metaUnitsToMinor(value, currency)
/** A frequency cap's reset period: whole days → hours (Meta: "In hours. Expressed as multiples of 24"). */
export const rfResetHours = (days: number): string => String(Math.round(days) * 24)

/** reservation.md "Response status codes", in short words. */
const STATUS_WORDS: Readonly<Record<number, string>> = {
  1: 'ready (success)', 2: 'still being worked out by Meta (pending)', 3: 'failed: the audience cannot be reached (reach or budget too high)', 4: 'failed: the settings are not valid (e.g. the dates)',
  5: 'failed: the targeting is not valid', 6: 'failed: the budget is too low for the reach', 7: 'failed: too short', 8: 'failed: too long', 9: 'failed: it ends too far ahead',
  10: 'failed: no frequency cap', 11: 'failed: the placements cannot be mixed', 12: 'failed: the start or end time is not valid', 13: 'failed: the country is not supported yet',
  14: 'failed: the dates include blackout days', 15: 'failed: not enough inventory to reserve', 16: 'failed: below the account\'s minimum reach', 17: 'failed: below the country\'s minimum reach',
  18: 'failed: the day parting is not valid', 19: 'failed: the target CPM cannot be reached', 21: 'failed: inventory moved too much — predict again', 26: 'failed: the audience is empty',
}
export const rfStatusWords = (status: number | null): string => (status === null ? 'unknown (Meta did not say)' : STATUS_WORDS[status] ?? (status >= 100 ? `failed on Meta's side (${status}): predict again` : `failed (Meta's status ${status})`))
const RESERVATION_WORDS: Readonly<Record<number, string>> = { 0: 'cancelled (or never reserved)', 1: 'reserved', 2: 'attached to an ad set' }
const day = (unix: number | null) => (unix ? new Date(unix * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'not said')
const isOn = (s: string | null, c: string | null) => s === 'ACTIVE' && c === 'ACTIVE'

/** What a prediction or reservation books, in words (amounts in the account currency). */
function planWords(p: LivePrediction, currency: string | null, point?: ReachFrequencyRequest['point']): string {
  const budget = point ? point.budgetCents : rfBudgetCents(p.budgetCents, currency)
  const reach = point ? point.reach : p.reach
  return `${budget !== null ? `about ${money(budget, currency)}` : 'the budget it was predicted for'} for ${reach !== null ? `about ${reach.toLocaleString('en')} people` : 'its predicted reach'}${p.frequencyCap ? `, at most ${p.frequencyCap} times each` : ''}, ${day(p.start)} → ${day(p.stop)}`
}

const base = { kind: 'ad' as const, check: 'none' as const, readBackInPost: false, budget: false }

/** create-meta-reach-frequency's draft, or why not. */
export function reachFrequencyDraft(request: ReachFrequencyRequest, live: ReachFrequencyLive): MetaChangeDraft | { refusal: string } {
  const act = `act_${live.adAccountId}`
  const granted = live.capabilities === null ? null : live.capabilities.includes(RF_CAPABILITY)
  const grantWords = 'Meta has not granted reach and frequency (reservation) buying to this ad account (its capabilities lack CAN_USE_REACH_AND_FREQUENCY): Meta switches it on per account (ask a Meta sales representative).'
  const grantUnknown = granted === null ? ['Nexus could not read whether Meta granted reservation buying to this account: if not, Meta refuses in its own words (reservation.md error 1487680: no permission to use reservation ad sets).'] : []
  const noCheck = 'Meta has no check for reach and frequency changes: the run reads the live state again first and sends nothing if it moved.'

  if (request.action === 'predict') {
    if (granted === false) return { refusal: grantWords }
    const mode = request.mode
    if (!mode) return { refusal: 'A prediction names its mode: reach-from-budget (with budgetCents) or budget-from-reach (with reach).' }
    if (mode === 'reach-from-budget' ? request.budgetCents === undefined || request.reach !== undefined : request.reach === undefined || request.budgetCents !== undefined) {
      return { refusal: 'reach-from-budget names budgetCents (the lifetime budget) and no reach; budget-from-reach names reach and no budget.' }
    }
    if (!request.startTime || !request.stopTime || !request.targeting) return { refusal: 'A prediction names its start, its stop and its targeting (one country).' }
    let start: string, stop: string, budget: string | null = null
    try {
      start = unixSecondsParam(request.startTime)
      stop = unixSecondsParam(request.stopTime)
      if (request.budgetCents !== undefined) budget = rfBudgetParam(request.budgetCents, live.currency)
    } catch (err) {
      if (err instanceof MetaUnitError) return { refusal: err.message }
      throw err
    }
    const nowSec = Math.floor(live.now.getTime() / 1000)
    if (Number(start) <= nowSec) return { refusal: 'A reach and frequency plan starts in the future (Meta: status 35).' }
    if (Number(stop) <= Number(start)) return { refusal: 'Its stop is after its start.' }
    if (Number(stop) - Number(start) > RF_MAX_DAYS * 86_400) return { refusal: `A reach and frequency plan runs at most ${RF_MAX_DAYS} days (Meta).` }
    if (Number(stop) > nowSec + RF_MAX_AHEAD_DAYS * 86_400) return { refusal: `Meta predicts only for a stop at most 8 weeks ahead (${RF_MAX_AHEAD_DAYS} days).` }
    if ((request.frequencyCap === undefined) === (request.targetFrequency === undefined)) return { refusal: 'A prediction names a frequency cap (frequencyCap, optionally over frequencyCapDays) or a target frequency (targetFrequency), one of the two (Meta fails one with neither: status 10).' }
    if (request.frequencyCapDays !== undefined && request.frequencyCap === undefined) return { refusal: 'frequencyCapDays goes with frequencyCap.' }
    if (request.targetFrequencyDays !== undefined && request.targetFrequency === undefined) return { refusal: 'targetFrequencyDays goes with targetFrequency.' }
    const t = request.targeting
    if (t.ageMin !== undefined && t.ageMax !== undefined && t.ageMax < t.ageMin) return { refusal: 'ageMax is not below ageMin.' }
    const destinations = [...new Set(request.destinations ?? ['page'])]
    const destinationIds: string[] = []
    for (const d of destinations) {
      const id = d === 'page' ? live.pageId : live.instagramId
      if (!id) return { refusal: d === 'page' ? 'No Facebook Page is chosen for this business (Settings › Channels › Meta): a prediction names the Page its ads come from.' : 'No Instagram account is chosen for this business: leave instagram out of destinations, or choose one first (set-meta-connection).' }
      destinationIds.push(id)
    }
    // Review B5 — placements left out: Facebook only, or Facebook and Instagram when the chosen Instagram account is a
    // destination (Meta: "include the Instagram account ID if instagramstream placement is used").
    const platforms = t.platforms?.length ? [...new Set(t.platforms)] : destinations.includes('instagram') ? ['facebook', 'instagram'] : ['facebook']
    if (platforms.includes('instagram') && !destinations.includes('instagram')) return { refusal: 'Instagram placements need the chosen Instagram account among the destinations (Meta: destination_ids with the Instagram account).' }
    const target = {
      geo_locations: { countries: [t.country] },
      ...(t.ageMin !== undefined ? { age_min: t.ageMin } : {}),
      ...(t.ageMax !== undefined ? { age_max: t.ageMax } : {}),
      ...(t.genders?.length ? { genders: [...new Set(t.genders)].map((g) => (g === 'male' ? 1 : 2)) } : {}),
      publisher_platforms: platforms,
      ...(t.facebookPositions?.length ? { facebook_positions: [...new Set(t.facebookPositions)] } : {}),
      ...(t.instagramPositions?.length ? { instagram_positions: [...new Set(t.instagramPositions)] } : {}),
      ...(t.devices?.length ? { device_platforms: [...new Set(t.devices)] } : {}),
    }
    const params: Record<string, string> = {
      prediction_mode: mode === 'reach-from-budget' ? '1' : '0',
      start_time: start,
      stop_time: stop,
      target_spec: JSON.stringify(target),
      destination_ids: JSON.stringify(destinationIds),
      ...(budget !== null ? { budget } : {}),
      ...(request.reach !== undefined ? { reach: String(request.reach) } : {}),
      ...(request.frequencyCap !== undefined ? { frequency_cap: String(request.frequencyCap) } : {}),
      ...(request.frequencyCapDays !== undefined ? { interval_frequency_cap_reset_period: rfResetHours(request.frequencyCapDays) } : {}),
      ...(request.targetFrequency !== undefined ? { target_frequency: String(request.targetFrequency), is_balanced_frequency: 'true' } : {}),
      ...(request.targetFrequencyDays !== undefined ? { target_frequency_reset_period: rfResetHours(request.targetFrequencyDays) } : {}),
      ...(request.objective ? { objective: request.objective } : {}),
      ...(request.optimizationGoal ? { optimization_goal: request.optimizationGoal } : {}),
      ...(request.dayParting ? { day_parting_schedule: JSON.stringify([{ start_minute: request.dayParting.startMinute, end_minute: request.dayParting.endMinute, days: [...new Set(request.dayParting.days)].sort(), ...(request.dayParting.timezone ? { timezone_type: request.dayParting.timezone } : {}) }]) } : {}),
      ...(request.curvePoints !== undefined ? { num_curve_points: String(request.curvePoints) } : {}),
      // Review B5 — always sent (Meta requires it when every mobile device is targeted): 0 unless video or canvas ads are named.
      story_event_type: String(RF_VIDEO_ADS[request.videoAds ?? 'none']),
      ...(request.campaignId ? { campaign_group_id: request.campaignId } : {}),
      ...(request.shareAudienceOf ? { rf_prediction_id_to_share: request.shareAudienceOf } : {}),
      ...(request.existingAdSetId ? { existing_campaign_id: request.existingAdSetId } : {}),
      ...(request.productType ? { product_type: request.productType } : {}),
      ...(request.instreamPackages?.length ? { instream_packages: JSON.stringify([...new Set(request.instreamPackages)]) } : {}),
    }
    const sdkOnly = ['target_frequency', 'existing_campaign_id', 'product_type'].filter((k) => k in params)
    return {
      summary: `Meta: predict reach and frequency in ${t.country} from ${day(Number(start))} to ${day(Number(stop))} — ${mode === 'reach-from-budget' ? `the reach for ${money(request.budgetCents!, live.currency)}` : `the budget for ${request.reach!.toLocaleString('en')} people`} (a quote: it books and spends nothing).`,
      changes: { 'Reach and frequency prediction': { from: 'none', to: `${mode === 'reach-from-budget' ? `budget ${money(request.budgetCents!, live.currency)}` : `reach ${request.reach!.toLocaleString('en')}`}, ${t.country}, ${day(Number(start))} → ${day(Number(stop))}${request.frequencyCap ? `, at most ${request.frequencyCap} times${request.frequencyCapDays ? ` every ${request.frequencyCapDays} days` : ''}` : `, target frequency ${request.targetFrequency}`}` } },
      totals: { predictions: 1 },
      warnings: [
        'A prediction is a quote: Meta books nothing and nothing spends. Meta works it out over a few moments (status pending): ask a reserve of it to see the result in its preview before anything is booked.',
        ...(live.campaignBuyingType && live.campaignBuyingType !== 'RESERVED' ? [`Campaign ${request.campaignId} buys by ${live.campaignBuyingType}: reach and frequency needs a campaign made with buyingType RESERVED (create-meta-campaign).`] : []),
        ...(sdkOnly.length ? [`${sdkOnly.join(', ')} ${sdkOnly.length === 1 ? 'is' : 'are'} in Meta's SDK only (no reference page): Meta's answer decides.`] : []),
        ...grantUnknown, noCheck,
      ],
      spendsMoney: [],
      skipped: [],
      requests: [{
        ...base, step: 1, label: `Ask Meta for a reach and frequency prediction (${t.country}, ${day(Number(start))} → ${day(Number(stop))})`, objectKind: 'adaccount', objectId: act, edge: 'reachfrequencypredictions',
        params, operation: 'rf.predict', raisesSpend: false, undoable: false, readBackFields: 'id,status,prediction_mode,prediction_progress',
      }],
      stands: { destinations: destinationIds, granted, campaignBuyingType: live.campaignBuyingType ?? null },
      before: { op: 'predict', predictionId: null } satisfies ReachFrequencyRecord,
      after: { op: 'predict', predictionId: null, noUndo: ['A prediction books nothing and spends nothing; Meta has no delete for it (it expires).'] } satisfies ReachFrequencyRecord,
    }
  }

  if (request.action === 'reserve' || request.action === 'cancel') {
    const p = live.prediction
    if (!request.predictionId || !p) return { refusal: `A ${request.action} names the prediction${request.action === 'cancel' ? ' (the reservation)' : ''} (predictionId).` }
    const state = `status: ${rfStatusWords(p.status)}; reservation: ${p.reservationStatus === null ? 'none' : RESERVATION_WORDS[p.reservationStatus] ?? String(p.reservationStatus)}`
    const nowSec = Math.floor(live.now.getTime() / 1000)
    if (request.action === 'reserve') {
      if (granted === false) return { refusal: grantWords }
      if (p.status !== 1) return { refusal: `Prediction ${p.id} is not ready to book — ${state}.` }
      if (p.reservationStatus === 2) return { refusal: `Prediction ${p.id} is attached to ad set ${p.adSetId ?? '(not said)'} already: nothing to book.` }
      // Review A4 — a reservation already booked is not booked twice.
      if (p.reservationStatus === 1) return { refusal: `${p.id} is already booked (reserved): nothing to book again. Give it to an ad set (action attach), or cancel it.` }
      if (p.expiration && p.expiration <= nowSec) return { refusal: `Prediction ${p.id} expired at ${day(p.expiration)}: predict again.` }
      const point = request.point
      // Review A5 — the spending line names the amount: Meta's predicted budget, or the point of its curve named.
      if (!point && rfBudgetCents(p.budgetCents, live.currency) === null) return { refusal: `Meta did not answer an amount for prediction ${p.id} (external_budget): name the point of its curve to book (point: reach, budgetCents, impressions) so the booking names what it costs.` }
      // Review A3 — a reservation this booking releases: read now, never one an ad set holds; it does not come back by undo.
      const released = request.releasePredictionId ? live.released ?? null : null
      if (request.releasePredictionId && !released) return { refusal: `Nexus could not read reservation ${request.releasePredictionId} that this booking would release.` }
      if (released && (released.adSetId || released.reservationStatus === 2)) return { refusal: `Reservation ${released.id} is attached to ad set ${released.adSetId ?? '(not said)'}: Nexus releases only a reservation no ad set holds (detach it first).` }
      if (released && released.reservationStatus !== 1) return { refusal: `${released.id} is not a booked reservation (${released.reservationStatus === null ? 'no reservation state' : RESERVATION_WORDS[released.reservationStatus] ?? `reservation status ${released.reservationStatus}`}): there is nothing to release.` }
      let pointBudget: string | null = null
      try { if (point) pointBudget = rfBudgetParam(point.budgetCents, live.currency) } catch (err) { if (err instanceof MetaUnitError) return { refusal: err.message }; throw err }
      const plan = planWords(p, live.currency, point)
      const spends = [`Booking reach and frequency prediction ${p.id} is agreeing to pay Meta's proposed costs: ${plan}. Meta holds the inventory about an hour for an ad set to take it (action attach) and charges for the impressions delivered once that ad set runs; nothing spends before an ad set with it is on and its start comes.`]
      return {
        summary: `Meta: BOOK reach and frequency prediction ${p.id} — ${plan}.`,
        changes: { [`Prediction ${p.id}`]: { from: state, to: `reserved: ${plan}` } },
        totals: { reservations: 1 },
        warnings: [
          'Only book what you intend to run: Meta reserves real inventory. Once the campaign runs it cannot be paused or cancelled this way (delete its campaign to stop it; delivered impressions are charged). Undo cancels the reservation while it does not run.',
          ...(released ? [`It RELEASES reservation ${released.id} (${planWords(released, live.currency)}): its audience is reused for this one, and undo of this booking does not bring it back.`] : []),
          ...grantUnknown, noCheck,
        ],
        spendsMoney: spends,
        skipped: [],
        requests: [{
          ...base, step: 1, label: `Book (reserve) reach and frequency prediction ${p.id}`, objectKind: 'adaccount', objectId: act, edge: 'reachfrequencypredictions',
          params: {
            action: 'reserve', rf_prediction_id: p.id,
            ...(point ? { reach: String(point.reach), budget: pointBudget!, impression: String(point.impressions) } : {}),
            ...(request.releasePredictionId ? { rf_prediction_id_to_release: request.releasePredictionId } : {}),
          },
          operation: 'rf.reserve', raisesSpend: true, undoable: false, readBackFields: 'id,status,reservation_status',
        }],
        stands: { prediction: p, released },
        before: { op: 'reserve', predictionId: p.id, reservationId: null, ...(released ? { noUndo: [`Reservation ${released.id} released by this booking does not come back by undo: book it again (a new reservation).`] } : {}) } satisfies ReachFrequencyRecord,
        after: { op: 'reserve', predictionId: p.id, reservationId: null } satisfies ReachFrequencyRecord,
      }
    }
    // cancel
    if (p.reservationStatus === 0) return { refusal: `Nothing to cancel: reservation ${p.id} is ${RESERVATION_WORDS[0]}.` }
    if (p.adSetId && p.start && p.start <= nowSec) {
      return { refusal: `Reservation ${p.id} runs (ad set ${p.adSetId}, since ${day(p.start)}): Meta cannot cancel a running reservation this way. Delete its campaign to stop it (remove-meta-ads-items, on the person's explicit ask) — Meta charges for what was delivered.` }
    }
    return {
      summary: `Meta: cancel reservation ${p.id} (Meta frees the inventory).`,
      changes: { [`Reservation ${p.id}`]: { from: state, to: 'cancelled' } },
      totals: { reservations: 1 },
      warnings: [
        'A cancel frees the inventory for other advertisers and has no undo: booking again is a new reservation at the price Meta quotes then.',
        ...(p.adSetId ? [`It is attached to ad set ${p.adSetId}: that ad set loses it (it does not start as planned).`] : []),
        noCheck,
      ],
      spendsMoney: [],
      skipped: [],
      requests: [{ ...base, step: 1, label: `Cancel reservation ${p.id}`, objectKind: 'adaccount', objectId: act, edge: 'reachfrequencypredictions', params: { action: 'cancel', rf_prediction_id: p.id }, operation: 'rf.cancel', raisesSpend: false, undoable: false, readBackFields: 'id,status,reservation_status' }],
      stands: { prediction: p },
      before: { op: 'cancel', predictionId: p.id } satisfies ReachFrequencyRecord,
      after: { op: 'cancel', predictionId: p.id, noUndo: ['A cancelled reservation\'s inventory is free for others: booking again is a new reservation (action reserve on a prediction — Meta may quote another price).'] } satisfies ReachFrequencyRecord,
    }
  }

  // attach, detach: one ad set.
  const a = live.adSet
  if (!request.adSetId || !a) return { refusal: `An ${request.action} names the ad set (adSetId).` }
  const who = `ad set ${a.name ? `"${a.name}" ` : ''}(${a.id})`
  if (a.effectiveStatus === 'ACTIVE') return { refusal: `${who} is active: Meta never changes the reservation of an active ad set (reservation.md, error 1487581) — pause it first (set-meta-status) and ask again.` }
  if (request.action === 'detach') {
    if (!a.rfPredictionId) return { refusal: `Nothing to change: ${who} has no reservation.` }
    return {
      summary: `Meta: ${who} lets reservation ${a.rfPredictionId} go (the reservation stays booked until cancelled).`,
      changes: { [`Reservation of ${who}`]: { from: a.rfPredictionId, to: 'none' } },
      totals: { adSets: 1 },
      warnings: ['The reservation itself stays booked (Meta holds it only about an hour unattached): cancel it (action cancel) if it is not wanted, or attach it again (undo).', noCheck],
      spendsMoney: [],
      skipped: [],
      requests: [{ ...base, kind: 'adset', step: 1, label: `${who} lets reservation ${a.rfPredictionId} go`, objectId: a.id, params: { rf_prediction_id: '0' }, operation: 'adset.rf.detach', raisesSpend: false, undoable: true, readBackFields: 'id,rf_prediction_id' }],
      stands: { adSet: [a.id, a.status, a.effectiveStatus, a.rfPredictionId] },
      before: { op: 'detach', adSetId: a.id, adSetPrediction: a.rfPredictionId } satisfies ReachFrequencyRecord,
      after: { op: 'detach', adSetId: a.id, adSetPrediction: null } satisfies ReachFrequencyRecord,
    }
  }
  // attach
  const p = live.prediction
  if (!request.predictionId || !p) return { refusal: 'An attach names the reservation (predictionId: the id Meta answered for a reserve).' }
  if (granted === false) return { refusal: grantWords }
  if (a.campaign.buyingType !== 'RESERVED') return { refusal: `${who} is in a campaign that buys by ${a.campaign.buyingType ?? 'auction'}: a reservation goes only to an ad set of a campaign made with buyingType RESERVED (create-meta-campaign).` }
  if (a.rfPredictionId) return { refusal: `${who} has reservation ${a.rfPredictionId} already: Meta never moves an ad set from one to another directly (reservation.md, error 1487671) — detach it first (action detach).` }
  if (live.adSetHasAds === false) return { refusal: `${who} has no ad: Meta gives a reservation only to an ad set with an ad (reservation.md, error 1487583). Add one first.` }
  // Review B4 — only a booking Meta finished (status 1): 2 is still pending, 15 found not enough inventory.
  if (p.status !== 1) return { refusal: `${p.id} is not a finished booking — status: ${rfStatusWords(p.status)}. Attach it once it reads ready (ask again).` }
  if (p.reservationStatus !== null && p.reservationStatus !== 1) return { refusal: `${p.id} is not a booked reservation free to take (${RESERVATION_WORDS[p.reservationStatus] ?? `reservation status ${p.reservationStatus}`}): book a prediction first (action reserve).` }
  const nowSec = Math.floor(live.now.getTime() / 1000)
  if (p.expiration && p.expiration <= nowSec) return { refusal: `Reservation ${p.id} expired at ${day(p.expiration)}: Meta holds inventory about an hour. Predict and book again.` }
  const on = isOn(a.status, a.campaign.status)
  const plan = planWords(p, live.currency)
  const spends = [`${who} takes reservation ${p.id} (${plan}): Meta delivers the booked plan and charges for the impressions from its start — ${on ? `${who} is on, so it spends once its start comes` : `nothing spends yet: ${who} is not on (it spends once switched on and its start comes)`}.`]
  return {
    summary: `Meta: ${who} takes reservation ${p.id} — ${plan}.`,
    changes: { [`Reservation of ${who}`]: { from: 'none', to: `${p.id}: ${plan}` } },
    totals: { adSets: 1 },
    warnings: [
      'Meta takes the ad set\'s start, end, targeting, bid and budget from the reservation; while attached, an ad set\'s settings mostly cannot change (Meta: detach first). Undo detaches it while the ad set is not active.',
      ...(p.reservationStatus === null ? ['Meta did not say whether the reservation is free to take: its answer decides.'] : []),
      ...grantUnknown, noCheck,
    ],
    spendsMoney: spends,
    skipped: [],
    requests: [{
      ...base, kind: 'adset', step: 1, label: `${who} takes reservation ${p.id}`, objectId: a.id, params: { rf_prediction_id: p.id }, operation: 'adset.rf.attach',
      raisesSpend: true, undoable: true, expect: { rf_prediction_id: p.id }, readBackFields: 'id,rf_prediction_id',
    }],
    stands: { adSet: [a.id, a.status, a.effectiveStatus, a.campaign.status, a.campaign.buyingType, a.rfPredictionId, live.adSetHasAds], prediction: p },
    before: { op: 'attach', adSetId: a.id, predictionId: p.id, adSetPrediction: null } satisfies ReachFrequencyRecord,
    after: { op: 'attach', adSetId: a.id, predictionId: p.id, adSetPrediction: p.id } satisfies ReachFrequencyRecord,
  }
}

/**
 * Review A1 — why a booking's undo (a cancel) can no longer run, or null while it can: the reservation still reads reserved
 * (reservation_status 1), attached to no ad set, not expired and not running.
 */
export function reservationUndoState(p: Pick<LivePrediction, 'reservationStatus' | 'adSetId' | 'expiration' | 'start'>, nowSec: number): string | null {
  if (p.adSetId || p.reservationStatus === 2) {
    return p.start && p.start <= nowSec
      ? `it runs (ad set ${p.adSetId ?? '?'}, since ${day(p.start)}): Meta cannot cancel a running reservation — delete its campaign to stop it`
      : `it is attached to ad set ${p.adSetId ?? '?'}: let it go first (undo of that attach), then cancel it`
  }
  if (p.reservationStatus !== 1) return `it reads ${p.reservationStatus === null ? 'no reservation state' : RESERVATION_WORDS[p.reservationStatus] ?? `reservation status ${p.reservationStatus}`}, not reserved`
  if (p.expiration && p.expiration <= nowSec) return `it expired at ${day(p.expiration)}`
  return null
}

/** A prediction's or reservation's state in words, for an answer. */
export function predictionWords(p: Pick<LivePrediction, 'id' | 'status' | 'reservationStatus'>): string {
  return `${p.id}: ${rfStatusWords(p.status)}${p.reservationStatus !== null ? `; reservation ${RESERVATION_WORDS[p.reservationStatus] ?? p.reservationStatus}` : ''}`
}

