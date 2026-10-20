/**
 * Meta step 17 — set-meta-status as a draft: pause, switch on or archive campaigns, ad sets and ads of the chosen ad
 * account (master rows CMP-047–049, AS-033–035, AD-039–041). Pure: the request and the live state (live-status.ts) in,
 * the draft (or a refusal in words) out.
 *
 * Meta's rules it follows (checked 2026-10-21, developers.facebook.com/documentation/ads-commerce/marketing-api/):
 *   - best-practices/manage-your-ad-object-status.md — live (ACTIVE / PAUSED) can go to any status; ARCHIVED only to
 *     DELETED (and only name and status are editable); DELETED cannot change. A campaign's PAUSED / ARCHIVED / DELETED is
 *     inherited by everything below it; a child's status never changes its parent. So an archive is for good (no undo).
 *   - reference/ad-campaign-group.md — `status` on update; PAUSED gives the campaign's active children effective_status
 *     CAMPAIGN_PAUSED while their own status stays (undo of a parent's pause = set the parent back only).
 *   - reference/ad-campaign.md — an archived ad set can only be deleted.
 *   - error-reference.md 1487007 — "You can't edit this ad because it's part of a scheduled ad set that has reached its end
 *     date": no status change of such an AD (review fix B2). Switching on an ad set past its own end time is refused too —
 *     UNVERIFIED (no Meta page says so; it would not deliver anyway until its end time moves).
 *   - reference/adgroup.md — ads in an ad set with creative_sequence "cannot be changed to PAUSED, ARCHIVED, or DELETED";
 *     error-reference.md 2490427 / 2490468 — a rejected ad "is currently disabled … you will need to make updates to it and
 *     create a new ad": a status change alone does not switch it on.
 *   - best-practices.md "Ad changes triggering ad reviews" — creative, targeting, optimization goal and billing event; Meta
 *     does not list a status change among its ad review triggers.
 * Spending: switching anything on is the person's decision and always a spendsMoney line; the line says when a parent is
 * paused, so nothing spends yet. Pausing is a safe step. Order (review fix B5): pauses and archives first, then
 * activations; inside each, ads before ad sets before campaigns (an archived parent archives its children, which then
 * cannot be archived themselves; a switch-on half done leaves the campaign off). A switch-on is never sent after a request
 * of the same change that did not happen (review fix A1, meta-ads-kit.ts).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { metaCheckAllowed } from '../../gateway/meta-calls.js'
import { itemKey, KIND_WORD, type MetaParentState, type MetaStatusKind, type MetaStatusObject } from './live-status.js'

export type MetaStatusValue = 'ACTIVE' | 'PAUSED' | 'ARCHIVED'

export interface StatusRequest {
  items: Array<{ kind: MetaStatusKind; id: string; status?: MetaStatusValue }>
  status?: MetaStatusValue
}

/** One object of a status change as recorded (AgentChange before / after; undo reads them). */
export interface StatusRecordItem { kind: MetaStatusKind; id: string; status: string | null; name?: string | null }
export interface StatusRecord { items: StatusRecordItem[] }

const VERB: Readonly<Record<MetaStatusValue, string>> = { ACTIVE: 'Switch on', PAUSED: 'Pause', ARCHIVED: 'Archive' }
const ORDER: Readonly<Record<MetaStatusKind, number>> = { ad: 0, adset: 1, campaign: 2 }

const named = (o: { kind: MetaStatusKind; id: string; name: string | null }) => `${KIND_WORD[o.kind]} "${o.name ?? 'no name'}" (${o.id})`
const parentWords = (kind: string, p: MetaParentState) => `${kind} "${p.name ?? 'no name'}" (${p.id})`
const ended = (iso: string | null, now: Date) => !!iso && Number.isFinite(Date.parse(iso)) && Date.parse(iso) <= now.getTime()

export function statusDraft(request: StatusRequest, live: { objects: Map<string, MetaStatusObject>; problems: string[] }, now: Date = new Date()): MetaChangeDraft | { refusal: string } {
  if (!request.items.length) return { refusal: 'Name at least one campaign, ad set or ad.' }
  const seen = new Set<string>()
  for (const item of request.items) {
    const key = itemKey(item.kind, item.id)
    if (seen.has(key)) return { refusal: `${KIND_WORD[item.kind]} ${item.id} is named twice: name each item once.` }
    seen.add(key)
    if (!(item.status ?? request.status)) return { refusal: `Say the status for ${KIND_WORD[item.kind]} ${item.id} (PAUSED, ACTIVE or ARCHIVED), or one status for every item.` }
  }
  if (live.problems.length) return { refusal: `Nothing was asked of Meta: ${live.problems.join(' ')}` }
  const missing = request.items.filter((item) => !live.objects.has(itemKey(item.kind, item.id)))
  if (missing.length) return { refusal: `Nexus could not read ${missing.map((m) => `${KIND_WORD[m.kind]} ${m.id}`).join(', ')} from Meta; nothing was asked of Meta. Try again in a few minutes.` }

  const wanted = new Map(request.items.map((item) => [itemKey(item.kind, item.id), (item.status ?? request.status)!]))
  // A parent switched on in this same request counts as on for its children's spending.
  const willBeOn = (kind: MetaStatusKind, parent: MetaParentState | null) => !!parent && (wanted.get(itemKey(kind, parent.id)) === 'ACTIVE' || (parent.status === 'ACTIVE' && wanted.get(itemKey(kind, parent.id)) === undefined))

  const refusals: string[] = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const skipped: string[] = []
  const changing: Array<{ object: MetaStatusObject; to: MetaStatusValue }> = []
  for (const item of request.items) {
    const object = live.objects.get(itemKey(item.kind, item.id))!
    const to = wanted.get(itemKey(item.kind, item.id))!
    const who = named(object)
    if (object.status === 'DELETED') { refusals.push(`${who} is deleted on Meta: Meta lets nothing of a deleted item change any more.`); continue }
    if (object.status === 'ARCHIVED' && to !== 'ARCHIVED') { refusals.push(`${who} is archived: Meta lets an archived item only be deleted, never paused or switched on again.`); continue }
    if (object.status === to) { skipped.push(`${who} is already ${to}.`); continue }
    if (to === 'ACTIVE') {
      if (object.kind === 'ad' && object.effectiveStatus === 'DISAPPROVED') { refusals.push(`${who} was rejected in Meta's review: Meta does not switch a rejected ad on by a status change alone (it asks for a new ad; 2490427).`); continue }
      // UNVERIFIED (see the header): an ended ad set would not deliver anyway.
      if (object.kind === 'adset' && ended(object.endTime, now)) { refusals.push(`${who} ended on ${object.endTime!.slice(0, 10)}: switched on it would not deliver until its end time is moved later, and Meta may refuse it.`); continue }
    }
    if (object.kind === 'ad' && object.adSet && ended(object.adSet.endTime, now)) {
      refusals.push(`${who} is in ${parentWords('ad set', object.adSet)}, which ended on ${object.adSet.endTime!.slice(0, 10)}: Meta refuses any edit of such an ad until the ad set's end date moves (1487007).`)
      continue
    }
    if (to !== 'ACTIVE' && object.kind === 'ad' && object.adSet?.creativeSequence) {
      refusals.push(`${who} is in an ad set that shows its ads in a sequence: Meta refuses to pause or archive such an ad (pause the ad set instead).`)
      continue
    }
    changing.push({ object, to })
  }
  if (refusals.length) return { refusal: `Nothing was asked of Meta: ${refusals.join(' ')}` }
  if (!changing.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }

  // Pauses and archives first (safe), then activations; inside each, ads before ad sets before campaigns (stable).
  const order = [...changing].sort((a, b) => {
    const on = (x: typeof a) => (x.to === 'ACTIVE' ? 1 : 0)
    if (on(a) !== on(b)) return on(a) - on(b)
    return ORDER[a.object.kind] - ORDER[b.object.kind]
  })
  for (const { object, to } of order) {
    const who = named(object)
    if (object.kind === 'campaign' && object.smartPromotionType === 'AUTOMATED_SHOPPING_ADS') {
      warnings.push(`${who} is a legacy Advantage+ shopping campaign: Meta may refuse any change of it through its API since v25 (its check answers first).`)
    }
    if (to === 'PAUSED' && object.kind !== 'ad') {
      warnings.push(`Pausing ${who} stops every ${object.kind === 'campaign' ? 'ad set and ad' : 'ad'} in it (Meta shows them ${object.kind === 'campaign' ? 'CAMPAIGN_PAUSED' : 'ADSET_PAUSED'}; their own status stays, so switching it on again brings back the ones that were on).`)
    }
    if (to === 'ARCHIVED') {
      warnings.push(`Archiving ${who} is for good: Meta lets an archived item only be deleted afterwards, never switched on again${object.kind === 'campaign' ? '; its ad sets and ads are archived with it' : object.kind === 'adset' ? '; its ads are archived with it' : ''}. This part cannot be undone.`)
    }
    if (to === 'ACTIVE') {
      if (object.kind === 'campaign') {
        spendsMoney.push(`Switching on ${who}: its ad sets and ads that are on and approved start delivering and spending at once.`)
      } else if (object.kind === 'adset') {
        const campaignOn = willBeOn('campaign', object.campaign)
        spendsMoney.push(campaignOn
          ? `Switching on ${who}: its ads that are on and approved start delivering and spending${object.campaign ? ` (its ${parentWords('campaign', object.campaign)} is on)` : ''}.`
          : `Switching on ${who}: nothing spends yet — its ${object.campaign ? parentWords('campaign', object.campaign) : 'campaign'} is not on; it spends once that is switched on.`)
      } else {
        const off = [
          ...(!willBeOn('adset', object.adSet) ? [object.adSet ? parentWords('ad set', object.adSet) : 'ad set'] : []),
          ...(!willBeOn('campaign', object.campaign) ? [object.campaign ? parentWords('campaign', object.campaign) : 'campaign'] : []),
        ]
        spendsMoney.push(off.length === 0
          ? `Switching on ${who}: once approved it delivers and spends (its ad set and campaign are on).`
          : `Switching on ${who}: nothing spends yet — its ${off.join(' and its ')} ${off.length > 1 ? 'are' : 'is'} not on; it spends once ${off.length > 1 ? 'they are' : 'that is'} switched on.`)
      }
    }
  }

  const requests: MetaChangeRequest[] = order.map(({ object, to }, i) => ({
    step: i + 1,
    label: `${VERB[to]} ${named(object)}`,
    kind: object.kind,
    objectId: object.id,
    params: { status: to },
    // Meta documents validate_only on a campaign update only (reference/ad-campaign-group.md "Updating"); the ad set and
    // ad update tables are missing from Meta's reference (LIVE-PROBES ST17-02). Until ST17-01, only a pause is checked.
    check: object.kind !== 'campaign' ? 'none' : metaCheckAllowed(to) ? 'meta' : 'not-yet',
    budget: false,
    undoable: to !== 'ARCHIVED',
    raisesSpend: to === 'ACTIVE',
    readBackInPost: object.kind === 'campaign',
  }))
  const { changes, more } = changeLines(order.map(({ object, to }) => [named(object), object.status, to]))
  const count = (status: MetaStatusValue) => changing.filter((c) => c.to === status).length
  const totals: Record<string, number> = {
    pause: count('PAUSED'), switchOn: count('ACTIVE'), archive: count('ARCHIVED'), requests: requests.length,
    ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}),
  }
  const summary = requests.length <= 3
    ? `Meta: ${requests.map((r) => r.label).join('; ')}.`
    : `Meta: ${[count('PAUSED') && `pause ${count('PAUSED')}`, count('ACTIVE') && `switch on ${count('ACTIVE')}`, count('ARCHIVED') && `archive ${count('ARCHIVED')}`].filter(Boolean).join(', ')} — ${plural(requests.length, 'request')}, one per object.`

  // What the change stands on: each object's own status and, where its spending sentence reads them, its parents'; and the
  // facts a refusal reads (end time passed, a sequence, a rejection). Effective statuses move on their own (review), so
  // they are not part of it.
  const stands = order.map(({ object }) => ({
    kind: object.kind, id: object.id, status: object.status,
    campaign: object.campaign?.status ?? null, adSet: object.adSet?.status ?? null,
    ended: object.kind === 'adset' ? ended(object.endTime, now) : object.kind === 'ad' ? ended(object.adSet?.endTime ?? null, now) : false,
    sequence: object.adSet?.creativeSequence ?? false,
    rejected: object.kind === 'ad' && object.effectiveStatus === 'DISAPPROVED',
  }))
  const before: StatusRecord = { items: order.map(({ object }) => ({ kind: object.kind, id: object.id, name: object.name, status: object.status })) }
  const after: StatusRecord = { items: order.map(({ object, to }) => ({ kind: object.kind, id: object.id, status: to })) }
  return { summary, changes, totals, warnings, spendsMoney, skipped, requests, stands, before, after }
}
