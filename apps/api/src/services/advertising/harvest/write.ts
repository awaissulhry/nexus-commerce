/**
 * HARVEST ENGINE (Keyword Harvest page rebuild, 2026-10-10) — the ONE harvest writer, for every actor (the brain, a person
 * on the page, Claude, a rule). Generalised from the brain's pair writer (brain/harvest-write.ts, AB-11), which now calls
 * it: the brain's harvests keep their behaviour word for word, the page's and Claude's add the funnel blocks and PHRASE.
 *
 * Every write goes through Nexus's existing paths, which ask the write gate and send through the channel gateway (hard
 * rule 4): the keyword through the ad group's own create (ads-create.service.ts createKeywordLocal / createTargetLocal,
 * `requireAmazon`: nothing is written unless Amazon took it), a paused copy enabled through the mutation layer, each
 * negative through the one negative write service (ads-negative-kw.service.ts), an undo through the mutation layer and
 * the negative retire service.
 *
 *   one change set  the keyword in the destination AND the negative in every source AND the funnel blocks: every half is
 *                   asked of the write gate first (as the writer it runs as) — any refusal, and nothing is written; then the
 *                   keyword; a source or funnel block is written only once the keyword stands (the term is never left
 *                   without a home). A negative that still fails leaves it HALF_DONE: the keyword stands, the failed
 *                   negatives are named (a refusal is the gate's or the Owner's word: named, not retried by the brain).
 *   landing         the ONE landing check is harvest-landing-guard.ts (B1 + B10, HFIX), asked again here before anything
 *                   is written: an archived keyword of the term or a negative that blocks it there, or a destination that
 *                   does not serve, holds the item (HELD, nothing written); an ENABLED keyword with Amazon's id whose switch
 *                   Amazon confirmed is the keyword (nothing created); a PAUSED one is switched on again with the start bid
 *                   (switchOnBid + enableLanding: sent at once) — and that is NO landing: no source or funnel negative is
 *                   written in the same call, they stay owed (HALF_DONE) until servingLandings says Amazon confirmed it.
 *                   A keyword that already stands is asked again before an owed negative is sent (servingLandings).
 *   undo            the harvest put back: every source and funnel negative it made retired, then the keyword PAUSED (never
 *                   archived) — only a keyword this harvest created or enabled; one that stood before keeps running.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../ads-write-gate.js'
import { createKeywordLocal, createTargetLocal } from '../ads-create.service.js'
import { checkLanding, enableLanding, servingLandings, switchOnBid } from '../harvest-landing-guard.js'
import { writeNegativeKeyword, writeNegativeProductTarget } from '../ads-negative-kw.service.js'

export type HarvestMatch = 'EXACT' | 'PHRASE'
export type BlockAction = 'negate' | 'standing' | 'skipped' | 'kept'

/** Who writes, and for which approval. */
export interface Who {
  actor: string
  /** A person's approval (passes the allowlist and pins, as his own click); false for the brain and rules. */
  manual: boolean
  confirmOwnLimits?: boolean
  changeSetId: string | null
  reason: string
}

/** A source (or funnel) ad group as a harvest record keeps it: the plan, and what became of its negative. */
export interface BlockState {
  adGroupId: string
  campaignId: string
  clicks?: number
  role: 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT' | null
  action: BlockAction
  why: string
  /** The negative's match: EXACT (default) or PHRASE (a phrase harvest's block in a broad or auto ad group). */
  negMatch?: HarvestMatch
  negativeTargetId?: string | null
  result?: 'landed' | 'failed' | 'refused'
  error?: string | null
  /**
   * Release review (Low) — false: the negative was there already when this harvest wrote (`already_existed` — another
   * writer's, e.g. the brain's funnel or a person's): it blocks the term, but this harvest's undo never lifts it.
   */
  own?: false
}

/** The negatives a harvest's undo may lift: those it wrote itself. */
export const ownNegatives = (blocks: readonly BlockState[]): string[] => blocks.filter((b) => b.own !== false).map((b) => b.negativeTargetId).filter((x): x is string => !!x)

export const blocksOf = (raw: unknown): BlockState[] => (Array.isArray(raw) ? raw as BlockState[] : [])

/** A limit of the person's own a half goes past (the gate's 3A answer): the card warns, approving it sends it anyway. */
export interface OwnLimitWarning { half: 'keyword' | 'negative' | 'campaign' | 'portfolio'; adGroupId: string | null; limit: string; reason: string }

export interface HarvestWriteInput {
  term: string
  isAsin: boolean
  match: HarvestMatch
  destAdGroupId: string
  bidCents: number
  /** The keyword stands already (a retry, a completion): nothing is created; owed negatives only once it serves. */
  keywordTargetId: string | null
  /** Who writes, in the words of a destination that does not serve ("the brain never harvests into …"). */
  noServeWords?: string
  sources: readonly BlockState[]
  funnel?: readonly BlockState[]
  /** A refused negative is asked again (a person's approval); the brain never retries a refusal. */
  retryRefused?: boolean
  /** The audit's metric (brainHarvest for the brain's writes, harvest for the engine's). */
  metric?: string
  /**
   * N2 (HCORE re-review) — what finishes the blocks still owed, in words. The brain's daily run retries its own HALF_DONE
   * pairs (the default words); a person's, Claude's or a rule's record is finished by harvesting it again, and says so.
   */
  owedWords?: { retried: string; afterSwitchOn: string }
}

/** The brain's words for what is owed: its daily run sends it. */
export const BRAIN_OWED_WORDS = { retried: 'retried by the next run', afterSwitchOn: 'sent by the next run' } as const
/** The engine's words for a person's, Claude's or a rule's record: nothing runs it again by itself. */
export const ENGINE_OWED_WORDS = {
  retried: 'harvest it again to finish (it shows as "Blocks owed")',
  afterSwitchOn: 'harvest it again once Amazon shows the keyword running (it shows as "Blocks owed")',
} as const

export interface HarvestWriteOutcome {
  status: 'DONE' | 'HALF_DONE' | 'REFUSED' | 'FAILED' | 'HELD'
  /** `confirmed` false: switched on again, Amazon has not confirmed it yet (no landing, no judging clock); `bidCents`: written. */
  keyword: { targetId: string | null; externalTargetId: string | null; existed: boolean; confirmed?: boolean; bidCents?: number | null } | null
  sources: BlockState[]
  funnel: BlockState[]
  why: string
  error: string | null
}

const owes = (retryRefused: boolean | undefined) => (s: BlockState) => s.action === 'negate' && s.result !== 'landed' && (retryRefused === true || s.result !== 'refused')
const termText = (term: string, isAsin: boolean) => (isAsin ? term.toUpperCase() : term)
const person = (who: Who) => (who.manual ? { manual: true, ...(who.confirmOwnLimits ? { confirmOwnLimits: true } : {}) } : {})

/** The gate's answer for each half, as the writer that will run it (nothing is written). */
export async function preflightHarvest(p: {
  term: string; isAsin: boolean; destAdGroupId: string | null; bidCents: number | null; keyword: 'create' | 'enable' | 'stands'; blocks: readonly BlockState[]
}, who: Who): Promise<{ ok: true; warnings: OwnLimitWarning[] } | { half: 'keyword' | 'negative'; adGroupId: string; refusal: string; deniedAt: string }> {
  const keywordPending = p.keyword !== 'stands'
  // M2 (HCORE review) — the person's own limits each half goes past (3A / 4A): warned on the card, never hidden.
  const warnings: OwnLimitWarning[] = []
  const warn = (half: 'keyword' | 'negative', adGroupId: string, gate: { pastOwnLimits?: Array<{ limit: string; reason: string }> }) => {
    for (const l of gate.pastOwnLimits ?? []) warnings.push({ half, adGroupId, limit: String(l.limit), reason: l.reason })
  }
  const ids = [...new Set([...(keywordPending && p.destAdGroupId ? [p.destAdGroupId] : []), ...p.blocks.map((s) => s.adGroupId)])]
  const groups = new Map((ids.length ? await prisma.adGroup.findMany({ where: { id: { in: ids } }, select: { id: true, campaignId: true, campaign: { select: { marketplace: true, adProduct: true } } } }) : []).map((g) => [g.id, g]))
  if (keywordPending && p.destAdGroupId) {
    const g = groups.get(p.destAdGroupId)
    if (!g) return { half: 'keyword', adGroupId: p.destAdGroupId, deniedAt: 'not_found', refusal: `the destination ad group ${p.destAdGroupId} is no longer in Nexus` }
    const bid = p.bidCents ?? 0
    const gate = await checkAdsWriteGate((p.keyword === 'enable'
      ? { marketplace: g.campaign.marketplace, campaignId: g.campaignId, adGroupId: g.id, field: 'status', fields: ['status'], payloadValueCents: 0, adProduct: g.campaign.adProduct, dimension: 'keywords', actor: who.actor, ...person(who) }
      : { marketplace: g.campaign.marketplace, campaignId: g.campaignId, adGroupId: g.id, field: 'bid', fields: ['bid'], intendedValueCents: bid, payloadValueCents: bid, adProduct: g.campaign.adProduct, dimension: 'keywords', actor: who.actor, ...person(who) }) as never)
    if (gate.allowed === false) return { half: 'keyword', adGroupId: g.id, deniedAt: gate.deniedAt, refusal: gate.reason }
    warn('keyword', g.id, gate as never)
  }
  for (const s of p.blocks) {
    const g = groups.get(s.adGroupId)
    if (!g) return { half: 'negative', adGroupId: s.adGroupId, deniedAt: 'not_found', refusal: `the source ad group ${s.adGroupId} is no longer in Nexus` }
    const gate = await checkAdsWriteGate({
      marketplace: g.campaign.marketplace, campaignId: g.campaignId, payloadValueCents: 0, isNegation: true,
      keywordText: termText(p.term, p.isAsin), ...(p.isAsin ? {} : { negativeMatchType: s.negMatch === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' }),
      adProduct: g.campaign.adProduct, dimension: 'negatives', actor: who.actor, ...person(who),
    } as never)
    if (gate.allowed === false) return { half: 'negative', adGroupId: g.id, deniedAt: gate.deniedAt, refusal: gate.reason }
    warn('negative', g.id, gate as never)
  }
  return { ok: true, warnings }
}

/** The keyword (or product target) created in the destination; its result as the record keeps it. */
async function addKeyword(p: HarvestWriteInput, who: Who) {
  const common = { adGroupId: p.destAdGroupId, bidEur: p.bidCents / 100, userId: who.actor, manual: who.manual, confirmOwnLimits: who.confirmOwnLimits, changeSetId: who.changeSetId, requireAmazon: true }
  const made = p.isAsin
    ? await createTargetLocal({ ...common, kind: 'PRODUCT', value: p.term.toUpperCase() })
    : await createKeywordLocal({ ...common, keywordText: p.term, matchType: p.match, evidence: { metric: p.metric ?? 'brainHarvest', note: who.reason } as never })
  const outcome = (made as { outcome?: string }).outcome
  const landed = !!made.id && !!made.externalTargetId && (outcome === 'created' || outcome === 'already_existed' || outcome == null)
  const reason = (made as { reason?: string | null }).reason ?? (made as { denied?: { reason?: string } }).denied?.reason ?? (made as { pushError?: string }).pushError ?? null
  return { landed, targetId: made.id, externalTargetId: made.externalTargetId, existed: outcome === 'already_existed' || (made as { existed?: boolean }).existed === true, refused: outcome === 'refused' || outcome === 'needs_confirmation', reason }
}

/** One negative (exact or phrase; an ASIN: a negative product target) in the ad group. */
async function negate(term: string, isAsin: boolean, s: BlockState, who: Who, metric: string): Promise<BlockState> {
  const out = isAsin
    ? await writeNegativeProductTarget({ adGroupId: s.adGroupId, asin: term.toUpperCase(), userId: who.actor, manual: who.manual, confirmOwnLimits: who.confirmOwnLimits, changeSetId: who.changeSetId, evidence: { metric, note: who.reason } as never })
    : await writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: s.adGroupId, keywordText: term, matchType: s.negMatch === 'PHRASE' ? 'PHRASE' : 'EXACT', userId: who.actor, manual: who.manual, changeSetId: who.changeSetId, evidence: { metric, note: who.reason } as never })
  if ((out.outcome === 'created' || out.outcome === 'local') && out.adTargetId) return { ...s, negativeTargetId: out.adTargetId, result: 'landed', error: null }
  // A negative that already blocks the term there: this harvest's own when its earlier attempt made it (a run that died
  // after Amazon took it, before the record was updated — re-review Low: its undo must lift it); else another writer's,
  // recorded and never lifted by this harvest's undo.
  if (out.outcome === 'already_existed' && out.adTargetId) {
    const ours = await madeByThisHarvest(out.adTargetId, who)
    return { ...s, negativeTargetId: out.adTargetId, result: 'landed', error: null, ...(ours ? {} : { own: false as const }) }
  }
  if (out.outcome === 'refused') return { ...s, result: 'refused', error: `${out.refusal?.deniedAt ?? 'refused'}: ${out.refusal?.reason ?? 'refused'}` }
  return { ...s, result: 'failed', error: out.error ?? 'the negative did not reach Amazon' }
}

/**
 * Whether this very harvest made that negative before: its creation was audited for the same change set (a person's or
 * Claude's approved request) or, with no change set (the brain's run), by the same writer. Read only.
 */
async function madeByThisHarvest(adTargetId: string, who: Who): Promise<boolean> {
  const by = who.changeSetId ? { executionId: who.changeSetId } : { userId: who.actor }
  const n = await prisma.advertisingActionLog.count({ where: { entityType: 'AD_TARGET', entityId: adTargetId, actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] }, ...by } })
  return n > 0
}

/**
 * Write a harvest (or what is left of it): the landing guard first, then every half asked of the gate, then the keyword
 * (create, or a paused copy switched on — no landing yet — or nothing when it stands), then each source and funnel
 * negative still owed, only where the keyword serves. Pure of the record: the caller stores the outcome.
 */
export async function writeHarvest(p: HarvestWriteInput, who: Who): Promise<HarvestWriteOutcome> {
  const keywordPending = !p.keywordTargetId
  const owed = owes(p.retryRefused)
  const funnelIn = [...(p.funnel ?? [])]
  const metric = p.metric ?? 'brainHarvest'
  const next = p.owedWords ?? BRAIN_OWED_WORDS
  const blocks = [...p.sources, ...funnelIn]
  const what = p.isAsin ? 'product target' : 'keyword'
  // The landing guard (harvest-landing-guard.ts, the one landing check): nothing is written where the term could not serve.
  const landing = keywordPending ? await checkLanding({ adGroupId: p.destAdGroupId, term: p.term, match: p.isAsin ? 'PRODUCT' : p.match }) : null
  if (landing && (landing.kind === 'hold' || (landing.kind !== 'enable' && !landing.serves))) {
    const why = landing.kind === 'hold' ? landing.why : `${landing.why}: ${p.noServeWords ?? 'the brain never harvests into a destination that does not serve'}`
    return { status: 'HELD', keyword: null, sources: [...p.sources], funnel: funnelIn, why: `held — ${why}`, error: why }
  }
  if (!keywordPending && blocks.some(owed) && !(await servingLandings([{ adTargetId: p.keywordTargetId!, term: p.term }])).size) {
    const why = `the ${what} is not enabled at Amazon (or its switch-on is not confirmed yet) in a serving ad group now, or a negative there blocks the term: no source is negated (the term would serve nowhere)`
    const mark = (s: BlockState) => (owed(s) ? { ...s, result: 'failed' as const, error: why } : s)
    // Not serving now: no landing, so the judging clock does not start here (a harvest that landed before keeps its own).
    return { status: 'HALF_DONE', keyword: { targetId: p.keywordTargetId, externalTargetId: null, existed: true, confirmed: false }, sources: p.sources.map(mark), funnel: funnelIn.map(mark), why: `the keyword stands, but ${why}; ${next.retried}`, error: why }
  }
  const pre = await preflightHarvest({ term: p.term, isAsin: p.isAsin, destAdGroupId: p.destAdGroupId, bidCents: p.bidCents, keyword: !keywordPending ? 'stands' : landing?.kind === 'enable' ? 'enable' : landing?.kind === 'landed' ? 'stands' : 'create', blocks: blocks.filter(owed) }, who)
  if (!('ok' in pre)) {
    const why = `the write gate refuses the ${pre.half === 'keyword' ? 'keyword' : 'source negative'} (${pre.deniedAt}: ${pre.refusal})`
    if (keywordPending) return { status: 'REFUSED', keyword: null, sources: [...p.sources], funnel: funnelIn, why: `nothing was written — ${why}; the pair is written whole or not at all`, error: why }
    const mark = (s: BlockState) => (s.adGroupId === pre.adGroupId && owed(s) ? { ...s, result: 'refused' as const, error: `${pre.deniedAt}: ${pre.refusal}` } : s)
    return { status: 'HALF_DONE', keyword: { targetId: p.keywordTargetId, externalTargetId: null, existed: true }, sources: p.sources.map(mark), funnel: funnelIn.map(mark), why: `the keyword stands; ${why}`, error: why }
  }
  let keyword: HarvestWriteOutcome['keyword'] = { targetId: p.keywordTargetId, externalTargetId: null, existed: true }
  if (keywordPending && landing?.kind === 'enable') {
    // A paused keyword of the term there: switched on again with the start bid (held as a create's), sent at once. NO
    // landing yet: every source and funnel negative stays owed until Amazon confirmed the switch (servingLandings above).
    const sw = await switchOnBid({ targetId: landing.targetId, wantCents: p.bidCents, who })
    const on = await enableLanding(landing.targetId, sw.cents, { actor: who.actor, manual: who.manual, confirmOwnLimits: who.confirmOwnLimits, changeSetId: who.changeSetId, reason: `${who.reason} — ${landing.why}` })
    if (!on.ok) {
      const why = `${landing.why} — but the switch was refused (${on.why}): nothing was negated, nothing changed`
      return { status: 'REFUSED', keyword: null, sources: [...p.sources], funnel: funnelIn, why, error: on.why }
    }
    const kw = { targetId: landing.targetId, externalTargetId: landing.externalTargetId, existed: true, confirmed: false, bidCents: on.bidCents }
    const wait = `waiting for Amazon to confirm the switch-on: ${next.afterSwitchOn}`
    const mark = (s: BlockState) => (owed(s) ? { ...s, result: 'failed' as const, error: wait } : s)
    const sources = p.sources.map(mark)
    const funnel = funnelIn.map(mark)
    const owedNow = [...sources, ...funnel].filter((s) => s.action === 'negate' && s.result !== 'landed').length
    return owedNow
      ? { status: 'HALF_DONE', keyword: kw, sources, funnel, why: `the paused ${what} was switched on again${sw.held ? ` (its bid ${sw.held})` : ''}; ${owedNow === 1 ? 'its source negative waits' : `its ${owedNow} source negatives wait`} for Amazon to confirm the switch-on: ${next.afterSwitchOn}`, error: wait }
      : { status: 'DONE', keyword: kw, sources, funnel, why: `the paused ${what} was switched on again${sw.held ? ` (its bid ${sw.held})` : ''}; no source to negate`, error: null }
  } else if (keywordPending && landing?.kind === 'landed') {
    // An enabled keyword of the term already runs there: it is the keyword (the row the guard found, never another).
    keyword = { targetId: landing.targetId, externalTargetId: landing.externalTargetId, existed: true }
  } else if (keywordPending) {
    const k = await addKeyword(p, who)
    if (!k.landed) {
      const why = `the ${what} did not reach Amazon (${k.reason ?? 'no id came back'}): nothing was negated, nothing changed`
      return { status: k.refused ? 'REFUSED' : 'FAILED', keyword: null, sources: [...p.sources], funnel: funnelIn, why, error: k.reason ?? 'not created' }
    }
    keyword = { targetId: k.targetId, externalTargetId: k.externalTargetId, existed: k.existed }
  }
  const sources: BlockState[] = []
  for (const s of p.sources) sources.push(owed(s) ? await negate(p.term, p.isAsin, s, who, metric) : s)
  const funnel: BlockState[] = []
  for (const s of funnelIn) funnel.push(owed(s) ? await negate(p.term, p.isAsin, s, who, metric) : s)
  const left = [...sources, ...funnel].filter((s) => s.action === 'negate' && s.result !== 'landed')
  if (!left.length) {
    const landed = sources.filter((s) => s.action === 'negate').length
    const fun = funnel.filter((s) => s.action === 'negate').length
    return {
      status: 'DONE', keyword, sources, funnel,
      why: `${keywordPending ? `the ${what} landed` : 'the keyword stands'}${landed ? ` and its ${landed === 1 ? 'source is' : `${landed} sources are`} negated exact` : ''}${fun ? `, with ${fun === 1 ? 'one funnel block' : `${fun} funnel blocks`}` : ''}: one change set, whole`,
      error: null,
    }
  }
  const errors = left.map((s) => `ad group ${s.adGroupId}: ${s.error ?? 'not landed'}`).join('; ')
  return {
    status: 'HALF_DONE', keyword, sources, funnel,
    why: `the keyword stands, ${left.length === 1 ? 'one source negative' : `${left.length} source negatives`} did not land (${errors}): ${left.some((s) => s.result === 'failed') ? next.retried : 'refused — named, not retried'}`,
    error: errors,
  }
}

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface UndoOutcome {
  paused: boolean
  retired: number
  problems: string[]
  /** Nothing of the harvest stands any more: the keyword not enabled (or not this harvest's) and no negative standing. */
  complete: boolean
  /** The halves already back before this call (a negative no longer standing, the keyword no longer enabled). */
  alreadyBack: number
  /** The action-log rows the undo wrote (the keyword's pause first, then each retire). */
  actionLogIds: string[]
}

/**
 * Put a harvest back: every negative it made (sources and funnel) retired, so the term runs where it ran before, then the
 * keyword PAUSED (it stays at Amazon; never archived) — only when this harvest created or enabled it (`pauseKeyword`). Both
 * halves are asked of the write gate first, as the writer they run as — any refusal and neither is written. The keyword is
 * paused only once every block is lifted (the term is never left without a home); a retire that fails leaves the keyword
 * running, named, and the undo can be sent again (it writes only what is left).
 */
export async function undoHarvestWrite(r: { keywordTargetId: string | null; pauseKeyword: boolean; blocks: readonly BlockState[] }, who: Who): Promise<UndoOutcome> {
  const negatives = ownNegatives(r.blocks)
  const ids = [...(r.keywordTargetId ? [r.keywordTargetId] : []), ...negatives]
  const rows = ids.length
    ? await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, isNegative: true, status: true, adGroup: { select: { campaignId: true, campaign: { select: { name: true, marketplace: true, adProduct: true } } } } } })
    : []
  const enabled = rows.find((t) => t.id === r.keywordTargetId && !t.isNegative && String(t.status) === 'ENABLED') ?? null
  const keyword = r.pauseKeyword ? enabled : null
  const standing = rows.filter((t) => t.isNegative && String(t.status) !== 'ARCHIVED')
  const alreadyBack = negatives.filter((n) => !standing.some((t) => t.id === n)).length + (r.pauseKeyword && r.keywordTargetId && !enabled ? 1 : 0)
  const out: UndoOutcome = { paused: false, retired: 0, problems: [], complete: false, actionLogIds: [], alreadyBack }
  if (!keyword && !standing.length) return { ...out, complete: true }

  const halves = [
    ...standing.map((t) => ({ half: 'the source negative', t, ctx: { dimension: 'negatives' } })),
    ...(keyword ? [{ half: 'the keyword\'s pause', t: keyword, ctx: { isSuppression: true } }] : []),
  ]
  for (const { half, t, ctx } of halves) {
    const g = t.adGroup
    const gate = await checkAdsWriteGate({
      marketplace: g?.campaign.marketplace ?? null, campaignId: g?.campaignId ?? null, payloadValueCents: 0, field: 'status', fields: ['status'],
      adProduct: g?.campaign.adProduct ?? null, actor: who.actor, ...ctx, ...person(who),
    } as never)
    if (gate.allowed === false) {
      return { ...out, problems: [`nothing was put back — the write gate refuses ${half} in campaign "${g?.campaign.name ?? '?'}" (${gate.deniedAt}: ${gate.reason}): the undo is written whole or not at all`] }
    }
  }

  if (standing.length) {
    const { retireNegatives } = await import('../negatives-retire.service.js')
    // Negative Targeting (review S7) — a harvest's own undo lifts its own source and funnel negatives (Harvest keeps them otherwise).
    const res = await retireNegatives({ adTargetIds: standing.map((t) => t.id), actor: who.actor as never, retireReason: who.reason, changeSetId: who.changeSetId, manual: who.manual, owners: { undo: true } })
    for (const o of res.outcomes) {
      if (o.kind === 'retired' || o.kind === 'removed_local') { out.retired++; if (o.actionLogId) out.actionLogIds.push(o.actionLogId) }
      else if (o.kind !== 'skipped') out.problems.push(`a source negative was not retired (${o.reason ?? o.kind})`)
    }
  }
  if (keyword && out.problems.length) out.problems.push('the keyword was left running: a source still blocks the term, so pausing it now would leave the term without a home — send the undo again')
  else if (keyword) {
    const { updateAdTargetWithSync } = await import('../ads-mutation.service.js')
    const res = await updateAdTargetWithSync({ adTargetId: keyword.id, patch: { status: 'PAUSED' }, actor: who.actor as never, reason: who.reason, changeSetId: who.changeSetId, manual: who.manual, letsGo: true, askGate: true })
    if (res.ok) { out.paused = true; if (res.actionLogId) out.actionLogIds.unshift(res.actionLogId) }
    else out.problems.push(`the keyword was not paused (${res.error ?? 'refused'}): the term runs in its sources and its exact keyword until the undo is sent again`)
  }
  out.complete = !out.problems.length
  return out
}

export const jsonOf = (v: unknown) => v as Prisma.InputJsonValue
