/**
 * Meta step 19 — copy-meta-ads as a draft: copy a campaign, an ad set or an ad of the business's chosen ad account (with
 * its children, or alone; into another campaign or ad set of it; renamed; new times; a campaign with another budget; an
 * ad with its creative's name or URL tags changed), born PAUSED (status_option=PAUSED; ACTIVE only when the person asks:
 * SPENDS MONEY; the source's own status only when the source is paused). Master rows CMP-052–055, AS-037–039, AD-047,
 * AD-048, AD-054. ONE request. Meta has no check for a copy. Pure.
 *
 * Meta's rules it follows (checked 2026-10-21; developers.facebook.com/documentation/ads-commerce/…):
 *   - marketing-api/reference/ad-campaign-group/copies.md, …/ad-campaign/copies.md, graph-api/reference/adgroup/copies.md:
 *     deep_copy "the total number of children ads to copy should not exceed 3 for a synchronous call and 51 for an
 *     asynchronous call"; status_option default PAUSED; rename_options; a campaign's start_time / end_time "for deep copy"
 *     (its copied ad sets'; end_time=0 = ongoing with daily budgets); an ad set's campaign_id ("the copy inherits all
 *     campaign settings, such as budget"); "If you are copying an adset that already finished, the copy will be scheduled
 *     to start at the creation's time with the same duration"; an ad's adset_id and creative_parameters ("overwrites happen
 *     at the top level"; a NEW creative is made); EU ad sets need their payer / beneficiary set first (3858079 / 3858081);
 *     the answer: copied_<kind>_id with ad_object_ids (kept for undo). No execution_options: no check (facts F1 X2).
 *   - parameter_overrides ("Campaign spec", CMP-055 STILL-UNVERIFIED: no key list) — Nexus sends one budget override only
 *     (daily_budget or lifetime_budget of the same type as the source's campaign budget); Meta's answer decides
 *     (LIVE-PROBES CMP-055). migrate_to_advantage_plus is not usable in v26 (advantage-campaigns.md): never sent.
 *   - marketing-api/reference/ad-account/async_batch_requests.md (CMP-054): name + adbatch [{name, relative_url, body}] —
 *     a background copy of a campaign or ad set with more than 3 ads (Meta: up to 51). Not atomic; Meta answers a request
 *     set's id and makes the copies later: Nexus never has their ids, so that copy has no undo through Nexus.
 *   - marketing-api/reference/ad-account/asyncadcopies.md (AD-048): the edge exists but its "Creating" section is empty and
 *     Meta's SDK has no method for it — Nexus never sends it (its default status is unknown). Several ads are copied in the
 *     background as `<ad id>/copies` parts of the documented async batch instead, each with status_option said.
 *   - AD-054: Meta cannot move an ad ("adset_id … can not be updated", reference/adgroup.md): a copy into the other ad set
 *     is the way; the old ad stays (pause it with set-meta-status, or delete it with remove-meta-ads-items — step 22).
 *   - changelog 26.0 (from 2026-10-27, all versions): an ad set copy in a special-category campaign with constrained
 *     targeting must carry its Advantage+ audience choice; the copies edge documents no such key — said, Meta decides.
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { money } from './change-settings-common.js'
import { KIND_WORD, nothingMade, REMOVE_LATER, type MadeKind } from './change-create-common.js'
import { DSA_COUNTRIES, type CopyAdSetFacts, type CopySource, type DsaDefaults } from './live-create.js'
import { MAX_BACKGROUND_BODY, MAX_PART_BODY } from '../../gateway/meta-create-rules.js'
import type { LiveCampaign } from './live-settings.js'
import { budgetParam, metaUnitsToMinor, MetaUnitError, unixSecondsParam } from './settings-units.js'

/** Meta's limits on the ads one copy takes with it (copies references). */
export const SYNC_AD_LIMIT = 3
export const ASYNC_AD_LIMIT = 51
/** Nexus's own limit on the ads one asynchronous ad copy names: the gateway confirms each is the account's (a read each). */
export const MAX_AD_IDS = 20

export interface CopyRequest {
  kind: MadeKind
  /** The campaign, ad set or ad copied (not with adIds). */
  sourceId?: string
  /** background ad copies: up to 20 ads in one background request (an async batch of `<ad id>/copies` parts). */
  adIds?: string[]
  /** A campaign's or ad set's ads too (Meta: at most 3 in one request; more → background). */
  deepCopy?: boolean
  /** An ad set copy: into this campaign (else its own). */
  targetCampaignId?: string
  /** An ad copy: into this ad set (else its own). */
  targetAdSetId?: string
  rename?: { strategy?: 'DEEP_RENAME' | 'ONLY_TOP_LEVEL_RENAME' | 'NO_RENAME'; prefix?: string; suffix?: string }
  startTime?: string
  /** null: no end (daily budgets). */
  endTime?: string | null
  /** A campaign copy with another campaign budget (parameter_overrides; CMP-055). */
  budgetOverride?: { dailyBudgetCents?: number; lifetimeBudgetCents?: number }
  /** An ad copy's new creative: its name and URL tags (the rest of the creative as the source's). */
  creative?: { name?: string; urlTags?: string }
  /** The source's own status (INHERITED_FROM_SOURCE): only when the source is paused. */
  keepSourceStatus?: boolean
  /** Copy in the background: a campaign or ad set with its ads (more than 3), or several ads (adIds). */
  background?: boolean
  activate?: boolean
}

export interface CopyLive {
  adAccountId: string
  currency: string | null
  /** The source (null with adIds). */
  source: CopySource | null
  /** The campaign budget of a campaign source (budget override). */
  sourceCampaign: LiveCampaign | null
  /** An ad set copy into another campaign: that campaign. */
  targetCampaign: LiveCampaign | null
  /** An ad copy into another ad set: that ad set. */
  targetAdSet: { facts: CopyAdSetFacts; status: string | null; campaignId: string | null; campaignStatus: string | null } | null
  dsaDefaults: DsaDefaults | null
}

/** Answers in words (AD-054, the creative, the Advantage+ migration flag). */
export const COPY_NOT_SENT = [
  'Moving an ad: Meta cannot change an ad\'s ad set — copy it into the other ad set here; the old one stays (pause it with set-meta-status, or delete it with remove-meta-ads-items, step 22).',
  'A copy with a whole new creative: create-meta-creative and set-meta-ad (a copy here changes only the creative\'s name and URL tags).',
  'migrate_to_advantage_plus on a copy: Meta blocks it in v26 — not sent.',
  'Meta\'s asyncadcopies edge: no documented parameters and no SDK method — never sent; several ads are copied in the background through Meta\'s documented async batch instead.',
]

const LEGACY = new Set(['AUTOMATED_SHOPPING_ADS', 'SMART_APP_PROMOTION'])
const named = (s: CopySource) => `${KIND_WORD[s.kind]} "${s.name ?? 'no name'}" (${s.id})`
/** An ad set that may reach the EU (an EU country, or not only countries) without its own payer and beneficiary. */
const euWithoutDsa = (a: CopyAdSetFacts) => (a.countries === null || a.countries.some((c) => DSA_COUNTRIES.has(c.toUpperCase()))) && !(a.dsaPayor && a.dsaBeneficiary)

export function copyDraft(request: CopyRequest, live: CopyLive, now: Date = new Date()): MetaChangeDraft | { refusal: string } {
  try {
    return draft(request, live, now)
  } catch (err) {
    if (err instanceof MetaUnitError) return { refusal: err.message }
    throw err
  }
}

function renameOf(r: CopyRequest['rename']): string | null {
  if (!r || (!r.strategy && r.prefix === undefined && r.suffix === undefined)) return null
  return JSON.stringify({ rename_strategy: r.strategy ?? 'ONLY_TOP_LEVEL_RENAME', ...(r.prefix !== undefined ? { rename_prefix: r.prefix } : {}), ...(r.suffix !== undefined ? { rename_suffix: r.suffix } : {}) })
}

function draft(r: CopyRequest, live: CopyLive, nowDate: Date): MetaChangeDraft | { refusal: string } {
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  if (r.activate && r.keepSourceStatus) return { refusal: 'Name one: activate (the copy is switched on) or keepSourceStatus (it takes the paused source\'s status).' }
  const statusOption = r.activate ? 'ACTIVE' : r.keepSourceStatus ? 'INHERITED_FROM_SOURCE' : 'PAUSED'
  const rename = renameOf(r.rename)

  // ── background ad copies (AD-048 answered): the documented async batch, one `<ad id>/copies` part per ad ──
  if (r.kind === 'ad' && r.background) {
    const ids = [...new Set(r.adIds ?? (r.sourceId ? [r.sourceId] : []))]
    if (!ids.length) return { refusal: 'Name the ads to copy in the background (adIds).' }
    if (ids.length > MAX_AD_IDS) return { refusal: `At most ${MAX_AD_IDS} ads in one background copy (Nexus confirms each is this account's first).` }
    if (r.keepSourceStatus) return { refusal: 'A background copy of several ads takes PAUSED or ACTIVE (keepSourceStatus is for one paused source).' }
    if (r.creative) return { refusal: 'A background copy of ads keeps each ad\'s creative: change a creative\'s name or URL tags on a copy of one ad (background off).' }
    const body: Record<string, string> = { status_option: statusOption }
    if (r.targetAdSetId) body.adset_id = r.targetAdSetId
    if (rename) body.rename_options = rename
    const parts = ids.map((id, i) => ({ name: `ad_copy_${i + 1}`, relative_url: `${id}/copies`, body: new URLSearchParams(Object.entries(body)).toString() }))
    lines.push(['Copy in the background', null, `${plural(ids.length, 'ad')}${r.targetAdSetId ? ` into ad set ${r.targetAdSetId}` : ' (each in its own ad set)'}, ${statusOption} (status_option sent explicitly for each)`])
    warnings.push('Meta\'s asyncadcopies edge documents no parameters (and its SDK has no method for it), so Nexus never sends it: the ads go as parts of Meta\'s documented async batch, each a copy of one ad with its status_option said.')
    warnings.push(`A background copy is made by Meta later (not all or nothing) and Nexus never has the copies' ids: it has no undo through Nexus — ${REMOVE_LATER}.`)
    if (r.activate) spendsMoney.push(`The copied ads are made ACTIVE: each spends once Meta approves it and its ad set and campaign are on${r.targetAdSetId && live.targetAdSet && !(live.targetAdSet.status === 'ACTIVE' && live.targetAdSet.campaignStatus === 'ACTIVE') ? ' — the target ad set or its campaign is not on, so nothing spends yet' : ''}.`)
    const params = { name: `Nexus copy of ${plural(ids.length, 'ad')}`, adbatch: JSON.stringify(parts) }
    const tooLong = backgroundTooLong(parts, params)
    if (tooLong) return { refusal: tooLong }
    return finish({
      step: 1, label: `Copy ${plural(ids.length, 'ad')} in the background (${statusOption})`, kind: 'ad', objectKind: 'adaccount', objectId: `act_${live.adAccountId}`,
      edge: 'async_batch_requests', params, check: 'none',
      raisesSpend: r.activate === true, readBackInPost: false, budget: false, undoable: false, operation: 'copy.background', readBackFields: 'id',
    }, lines, warnings, spendsMoney, live, 'background-copy')
  }

  const s = live.source
  if (!s) return { refusal: 'Name what to copy (sourceId).' }
  if (r.adIds?.length) return { refusal: 'adIds are for a background copy of several ads (kind ad, background: true).' }
  const who = named(s)
  if (s.status === 'DELETED') return { refusal: `${who} is deleted: Meta copies nothing of it.` }
  if (s.smartPromotionType && LEGACY.has(s.smartPromotionType)) return { refusal: `${who} is (in) a legacy Advantage+ shopping or app campaign: Meta blocks copies of these since v25.` }
  if (r.keepSourceStatus && s.status !== 'PAUSED') return { refusal: `keepSourceStatus copies the source's status, and ${who} is ${s.status ?? 'not paused'}: Nexus takes it only from a paused source (the copy is PAUSED unless you ask activate).` }
  const params: Record<string, string> = { status_option: statusOption }
  lines.push(['Copy of', null, who])
  lines.push(['Status of the copy', null, r.activate ? 'ACTIVE (your decision)' : r.keepSourceStatus ? 'the source\'s: PAUSED (INHERITED_FROM_SOURCE)' : 'PAUSED (status_option sent explicitly)'])
  if (rename) { params.rename_options = rename; lines.push(['Names', null, rename]) } else lines.push(['Names', null, 'Meta\'s default: the copy\'s name + a localised " - Copy"'])

  // ── what goes with it, Meta's 3 / 51 ads limit, the background path (CMP-054) ──
  const deep = r.kind !== 'ad' && r.deepCopy === true
  if (r.kind === 'ad' && r.deepCopy) return { refusal: 'An ad has nothing under it: deepCopy is for a campaign or an ad set.' }
  if (r.kind !== 'ad') {
    params.deep_copy = String(deep)
    lines.push(['With its children', null, deep ? `yes: its ${r.kind === 'campaign' ? 'ad sets and ' : ''}ads (${plural(s.adCount ?? 0, 'ad')})` : 'no: the object alone'])
    if (deep && (s.adCount ?? 0) > ASYNC_AD_LIMIT) return { refusal: `${who} has ${s.adCount} ads: Meta copies at most ${ASYNC_AD_LIMIT} ads in one copy, even in the background. Copy its ad sets one by one.` }
    if (deep && (s.adCount ?? 0) > SYNC_AD_LIMIT && !r.background) return { refusal: `${who} has ${s.adCount} ads: Meta copies at most ${SYNC_AD_LIMIT} ads in one request. Ask again with background: true (Meta copies up to ${ASYNC_AD_LIMIT} in the background, but then Nexus gets no ids back for an undo).` }
    if (r.background && !deep) return { refusal: 'A background copy is for a campaign or ad set WITH its ads (deepCopy: true); the object alone is copied at once.' }
    if (deep) warnings.push('Meta does not make a copy with its children all or nothing: should it fail half way, part of the copy may exist — meta-campaigns view copies shows the source\'s copies.')
  }

  // ── where it lands: another campaign (ad set copy), another ad set (ad copy) ──
  let parentOn: boolean | null = null
  let parentWords = ''
  if (r.kind === 'campaign') {
    if (r.targetCampaignId || r.targetAdSetId) return { refusal: 'A campaign copy lands in the ad account itself: no target.' }
    parentOn = true
  }
  if (r.kind === 'adset') {
    if (r.targetAdSetId) return { refusal: 'An ad set copy lands in a campaign (targetCampaignId), not an ad set.' }
    const target = r.targetCampaignId && r.targetCampaignId !== s.campaignId ? live.targetCampaign : null
    if (r.targetCampaignId && r.targetCampaignId !== s.campaignId) {
      if (!target) return { refusal: `Nexus could not read campaign ${r.targetCampaignId} of this ad account.` }
      if (target.status === 'DELETED' || target.status === 'ARCHIVED') return { refusal: `Campaign ${target.id} is ${target.status.toLowerCase()}: Meta takes no copy there.` }
      if (target.smartPromotionType && LEGACY.has(target.smartPromotionType)) return { refusal: `Campaign ${target.id} is a legacy Advantage+ shopping or app campaign: Meta blocks copies into it.` }
      params.campaign_id = target.id
      lines.push(['Into campaign', null, `"${target.name ?? 'no name'}" (${target.id})`])
      warnings.push(`The copy takes campaign ${target.id}'s settings, such as its budget (Meta)${target.dailyBudget || target.lifetimeBudget ? ': under its campaign budget the ad set\'s own budget is not used' : ''}. A copy into another market is a person's decision, never a rule's.`)
      if (target.objective && s.objective && target.objective !== s.objective) warnings.push(`Campaign ${target.id}'s objective (${target.objective}) is not the source's (${s.objective}): Meta may refuse goals that do not fit it.`)
    }
    parentOn = (target ? target.status : s.campaignStatus) === 'ACTIVE'
    parentWords = `its campaign (${target ? target.id : s.campaignId}) is on (it is ${(target ? target.status : s.campaignStatus) ?? 'not on'} now)`
    if ((s.specialAdCategories ?? []).some((x) => x !== 'NONE')) warnings.push('In a special ad category campaign Meta (v26, from 2026-10-27) asks an ad set copy with narrowed targeting to carry its Advantage+ audience choice; its copies edge documents no such key, so Meta\'s answer decides.')
  }
  if (r.kind === 'ad') {
    if (r.targetCampaignId) return { refusal: 'An ad copy lands in an ad set (targetAdSetId), not a campaign.' }
    if (r.targetAdSetId && r.targetAdSetId !== s.adSetId) {
      const target = live.targetAdSet
      if (!target) return { refusal: `Nexus could not read ad set ${r.targetAdSetId} of this ad account.` }
      if (target.status === 'DELETED' || target.status === 'ARCHIVED') return { refusal: `Ad set ${target.facts.id} is ${target.status.toLowerCase()}: Meta takes no copy there.` }
      params.adset_id = target.facts.id
      lines.push(['Into ad set', null, `"${target.facts.name ?? 'no name'}" (${target.facts.id})`])
      warnings.push(COPY_NOT_SENT[0])
      parentOn = target.status === 'ACTIVE' && target.campaignStatus === 'ACTIVE'
      parentWords = `its ad set (${target.facts.id}) or that ad set's campaign is not on`
    } else {
      parentOn = s.adSetStatus === 'ACTIVE' && s.campaignStatus === 'ACTIVE'
      parentWords = `its ad set (${s.adSetId}) or campaign (${s.campaignId}) is not on`
    }
    if (r.creative) {
      const creative: Record<string, string> = {}
      if (r.creative.name !== undefined) creative.name = r.creative.name
      if (r.creative.urlTags !== undefined) creative.url_tags = r.creative.urlTags
      if (!Object.keys(creative).length) return { refusal: 'Name the creative\'s new name or URL tags, or leave creative out.' }
      params.creative_parameters = JSON.stringify(creative)
      lines.push(['Its creative', null, `a new creative like the source's, with ${Object.keys(creative).map((k) => (k === 'url_tags' ? `URL tags ${creative.url_tags}` : `name "${creative.name}"`)).join(' and ')}`])
      warnings.push('Meta makes a NEW creative for the copy (overwriting only the keys named at the top level); a new ad goes to Meta\'s review before it delivers.')
    } else warnings.push('A copied ad goes to Meta\'s review before it delivers (a paused one stays paused after it).')
  }

  // ── times (an ad set's; a campaign's copied ad sets' with a deep copy) ──
  if (r.startTime !== undefined || r.endTime !== undefined) {
    if (r.kind === 'ad') return { refusal: 'An ad has no times of its own: its ad set\'s start and end apply.' }
    if (r.kind === 'campaign' && !deep) return { refusal: 'A campaign copy\'s start and end are its copied ad sets\': with deepCopy only.' }
    const now = Math.floor(nowDate.getTime() / 1000)
    if (r.startTime !== undefined) { params.start_time = unixSecondsParam(r.startTime); lines.push(['Starts', null, r.startTime]) }
    if (r.endTime !== undefined) {
      const end = r.endTime === null ? 0 : Number(unixSecondsParam(r.endTime))
      if (end && end <= now) return { refusal: `The end time ${r.endTime} has passed: Meta refuses an end in the past.` }
      if (end && params.start_time && end <= Number(params.start_time)) return { refusal: 'The end time comes after the start time.' }
      params.end_time = String(end)
      lines.push(['Ends', null, end ? r.endTime : 'no end (runs on; daily budgets only)'])
    }
  } else if (r.kind === 'adset') warnings.push('Without new times the copy keeps the source\'s; a copy of an ad set that has ended is scheduled by Meta to start now with the same duration.')

  // ── a campaign copy with another budget (CMP-055: parameter_overrides, keys undocumented) ──
  if (r.budgetOverride) {
    if (r.kind !== 'campaign') return { refusal: 'A budget override is for a campaign copy (an ad set copy takes its own, or its campaign\'s).' }
    const c = live.sourceCampaign
    const daily = r.budgetOverride.dailyBudgetCents
    const lifetime = r.budgetOverride.lifetimeBudgetCents
    if ((daily === undefined) === (lifetime === undefined)) return { refusal: 'Name the copy\'s campaign budget: dailyBudgetCents or lifetimeBudgetCents, one of the two.' }
    if (!c || !(c.dailyBudget || c.lifetimeBudget)) return { refusal: `${who} has no campaign budget: an override would turn one on for the copy, which Meta does not document. Copy it, then set-meta-campaign.` }
    const type = daily !== undefined ? 'daily' : 'lifetime'
    if ((type === 'daily') !== !!c.dailyBudget) return { refusal: `${who} has a ${c.dailyBudget ? 'daily' : 'lifetime'} campaign budget: the copy's override is of the same kind.` }
    const cents = (daily ?? lifetime)!
    const old = metaUnitsToMinor(type === 'daily' ? c.dailyBudget : c.lifetimeBudget, live.currency)
    params.parameter_overrides = JSON.stringify({ [`${type}_budget`]: Number(budgetParam(cents, live.currency)) })
    lines.push([`The copy's campaign budget (${type})`, old === null ? 'the source\'s' : money(old, live.currency), money(cents, live.currency)])
    warnings.push('Meta documents parameter_overrides on a campaign copy without its keys: Nexus sends the budget alone, and Meta\'s answer decides (LIVE-PROBE CMP-055). Should Meta ignore it, the copy keeps the source\'s budget: set-meta-campaign changes it after.')
    if (r.activate && old !== null && cents > old) spendsMoney.push(`The copy is switched on with a ${type} budget of ${money(cents, live.currency)}, above the source's ${money(old, live.currency)}.`)
  }

  // ── the EU payer and beneficiary (DSA): Meta refuses a copy of an EU ad set without them ──
  const euAdSets = r.kind === 'campaign' ? (deep ? s.adSets : []) : r.kind === 'adset' ? s.adSets : r.targetAdSetId && live.targetAdSet ? [live.targetAdSet.facts] : s.adSets
  const missing = euAdSets.filter(euWithoutDsa)
  if (missing.length && !live.dsaDefaults) {
    return { refusal: `${missing.slice(0, 5).map((a) => `Ad set "${a.name ?? 'no name'}" (${a.id})`).join(', ')}${missing.length > 5 ? ' and more' : ''} may reach people in the EU and ${missing.length === 1 ? 'has' : 'have'} no payer and beneficiary, and the ad account has no saved default: Meta refuses such a copy (3858079 / 3858081). Set them first (set-meta-ad-set dsa).` }
  }
  if (missing.length) lines.push(['EU payer / beneficiary', null, `the ad account's saved defaults for ${plural(missing.length, 'ad set')} without their own (Meta fills them in)`])
  if (r.kind === 'campaign' && deep && s.adSetsMore) warnings.push('The campaign has more ad sets than Nexus reads at once: Meta checks the EU payer and beneficiary of the rest itself.')

  // ── spending: a copy is PAUSED unless the person asks ──
  if (r.activate) {
    if (r.kind === 'campaign') {
      spendsMoney.push(deep
        ? `The copy of ${who} is switched on with its ad sets and ads as the source has them: those that are on spend at once (new ads after Meta's review).`
        : `The copy of ${who} is switched on, but it holds no ad set: nothing spends until one with an ad is made and switched on.`)
    } else if (r.kind === 'adset') {
      spendsMoney.push(parentOn
        ? `The copy of ${who} is switched on in an active campaign: ${deep ? 'its copied ads that are on spend at once (after Meta\'s review)' : 'it spends once an ad under it is on'}.`
        : `The copy of ${who} is switched on, but nothing spends until ${parentWords}.`)
    } else {
      spendsMoney.push(parentOn ? `The copy of ${who} is switched on in an active ad set and campaign: it spends once Meta approves it.` : `The copy of ${who} is switched on, but nothing spends while ${parentWords}.`)
    }
  }

  // ── the background path for a campaign or ad set with more than 3 ads (CMP-054) ──
  if (r.background) {
    const part = { name: `${r.kind}_copy_1`, relative_url: `${s.id}/copies`, body: new URLSearchParams(Object.entries(params)).toString() }
    warnings.push(`A background copy is made by Meta later (Meta's async batch; not all or nothing): Nexus gets the request's id, not the copies' ids, so it has no undo through Nexus — meta-campaigns view copies shows the copies; ${REMOVE_LATER}.`)
    const batch = { name: `Nexus copy of ${KIND_WORD[r.kind]} ${s.id}`, adbatch: JSON.stringify([part]) }
    const tooLong = backgroundTooLong([part], batch)
    if (tooLong) return { refusal: tooLong }
    return finish({
      step: 1, label: `Copy ${who} with its ads in the background (${statusOption})`, kind: r.kind, objectKind: 'adaccount', objectId: `act_${live.adAccountId}`,
      edge: 'async_batch_requests', params: batch,
      check: 'none', raisesSpend: r.activate === true, readBackInPost: false, budget: false, undoable: false, operation: 'copy.background', readBackFields: 'id',
    }, lines, warnings, spendsMoney, live, 'background-copy')
  }

  return finish({
    step: 1, label: `Copy ${who}${deep ? ' with its children' : ''} (${statusOption})`, kind: r.kind, objectId: s.id, edge: 'copies', params,
    // Meta documents no check (validate_only) for copies.
    check: 'none', raisesSpend: r.activate === true, readBackInPost: false, budget: false, undoable: false, operation: `${r.kind}.copy`,
    // Review A5 — INHERITED_FROM_SOURCE only from a paused source: the copy must read back PAUSED too.
    expect: { status: statusOption === 'INHERITED_FROM_SOURCE' ? 'PAUSED' : statusOption },
    readBackFields: 'id,name,status,effective_status',
    recordEvenIfNotAsAsked: true,
  }, lines, warnings, spendsMoney, live, 'copy')
}

/**
 * Review round 2 — the gateway's own size limits, judged in the PREVIEW so a background copy too long to send is refused
 * before anyone approves it: each part's form body at most MAX_PART_BODY characters, the whole request (form-encoded, as
 * sent) at most MAX_BACKGROUND_BODY (meta-create-rules.ts copy.background).
 */
function backgroundTooLong(parts: Array<{ body: string }>, params: Record<string, string>): string | null {
  const longest = Math.max(...parts.map((p) => p.body.length))
  if (longest > MAX_PART_BODY) return `One copy of this background request is ${longest} characters long; Nexus sends at most ${MAX_PART_BODY} per copy — use a shorter rename prefix or suffix.`
  const total = new URLSearchParams(params).toString().length
  return total > MAX_BACKGROUND_BODY ? `This background request is ${total} characters long once encoded; Nexus sends at most ${MAX_BACKGROUND_BODY} — copy fewer ads at once, or use a shorter rename prefix or suffix.` : null
}

function finish(request: MetaChangeRequest, lines: Array<[string, unknown, unknown]>, warnings: string[], spendsMoney: string[], live: CopyLive, op: 'copy' | 'background-copy'): MetaChangeDraft {
  const { changes, more } = changeLines(lines)
  return {
    summary: `Meta: ${request.label}.`,
    changes,
    totals: { requests: 1, ...(more ? { moreLines: more } : {}) },
    warnings: [
      ...warnings,
      'Meta has no check for a copy (validate_only is documented on creates and campaign updates only): the run reads the source again first and sends nothing if it moved.',
      ...(op === 'copy' ? ['Its undo deletes the copy (its copied children go with it) while nothing else hangs under it and it has spent nothing (read live first).'] : []),
    ],
    spendsMoney,
    skipped: [],
    requests: [request],
    stands: {
      source: live.source ? { ...live.source, effectiveStatus: undefined } : null,
      sourceCampaign: live.sourceCampaign ? { id: live.sourceCampaign.id, dailyBudget: live.sourceCampaign.dailyBudget, lifetimeBudget: live.sourceCampaign.lifetimeBudget } : null,
      targetCampaign: live.targetCampaign ? { id: live.targetCampaign.id, status: live.targetCampaign.status } : null,
      targetAdSet: live.targetAdSet, dsaDefaults: live.dsaDefaults,
    },
    before: nothingMade(op),
    after: nothingMade(op),
  }
}
