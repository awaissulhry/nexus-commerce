/**
 * Negative Targeting page (NREAD) — GET /api/advertising/waste/history: what was stopped, kept, released, turned on,
 * negated, removed, refused or skipped in the scope, newest first, each with who, why, its delivery and whether it can be
 * undone (and why not). Read only.
 *
 *   from     the action log: our keywords' state changes (payloadAfter.status ≠ payloadBefore.status; a hold set or
 *            ended in the same write reads "kept" / "released" — NWRITE writes keptPausedAt into the payloads), every
 *            negative's create and retire; the brain's refused negatives (AdsBrainNegative REFUSED); NWRITE's skips
 *            (AdsWasteSkip, read defensively in read.ts) — a refused write keeps its own row: "refused", never silent
 *   undo     a state change: Undo (POST /advertising/changes/:changeId/undo) while it landed, is not undone, carries what it
 *            replaced and is inside its window (rollback.service.ts rollbackWindowMsFor); a negative made inside a change
 *            set: the Undo of `changeSetId` retires it; a removed negative: never (Amazon archives it); a skip an Unskip
 *            ended reads UNDONE
 *   words    `by` is a plain name (You, a rule's name, Brain, Claude, Harvest, Unknown); stored words pass plainWords (no
 *            raw ids, no tool names, Rome times)
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { rollbackWindowLabel, rollbackWindowMsFor } from '../rollback.service.js'
import { labelFor } from '../bid-grid.service.js'
import { negativeKeptBy, ownerOfActor, refOfOwner } from './owner.js'
import { HOLD_ACTIONS, KEPT_PAUSED_DENIED_AT } from './hold.js'
import { DAY_MS, deliveryOf, negativeMatch, plainWords, romeDay, romeTime, targetMatch, termKeyOf, type Delivery, type Ref } from './pure.js'
import { inScope, ownerOfNegative, placeRefs, readSkipRows, scopedFacts, type ResolvedScope, type WasteFacts, type WasteScope } from './read.js'

export type HistoryAction = 'paused' | 'kept' | 'released' | 'turned_on' | 'negated' | 'removed' | 'refused' | 'skipped'

export interface HistoryItem {
  at: string
  action: HistoryAction
  text: string
  kind: 'KEYWORD' | 'TARGET' | 'TERM'
  /** The row it belongs to (kw:/neg:/term: — a skip names the row it skipped). */
  rowId: string | null
  campaign: Ref
  adGroup: Ref | null
  product: Ref | null
  by: Ref
  why: string | null
  /** POST /advertising/changes/:changeId/undo takes it; the action-log id. */
  changeId: string | null
  /** The change set (approval) it ran in: its Undo puts the whole set back. */
  changeSetId: string | null
  delivery: Delivery
  undo: { available: boolean; why: string }
}

export interface HistoryQuery extends WasteScope {
  days?: number | null
  kind?: 'keyword' | 'term' | 'all'
}

export type HistoryAnswer = { ok: true; rows: HistoryItem[]; days: number; truncated: boolean } | { ok: false; status: 400 | 404; error: string }

export const HISTORY_MAX = 500
const REMOVED_FINAL = 'A removed negative cannot come back: Amazon archives it. Add it again as a new negative.'
const jsonObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const NOT_SENT = ['FAILED', 'SKIPPED', 'CANCELLED', 'SUPERSEDED', 'REFUSED']
/**
 * NWRITE's Nexus-only rows of the hold (waste/hold.ts HOLD_ACTIONS; amazonResponseStatus SKIPPED: nothing is sent, the
 * hold is in force in Nexus at once). Named here so this file needs nothing of the WRITE lane's to read them.
 */
export { HOLD_ACTIONS }
const HOLD_ACTION_OF: Record<string, HistoryAction> = {
  [HOLD_ACTIONS.kept]: 'kept', [HOLD_ACTIONS.released]: 'released', [HOLD_ACTIONS.ended]: 'released',
  // A turn-on the lock refused, with the person (or writer) who tried: shown once, as refused.
  [HOLD_ACTIONS.refused]: 'refused',
}
/** A refused turn-on and its AdWriteRefusal are written together: this close in time, they are one event. */
const SAME_REFUSAL_MS = 10_000

/** The whys a log carries: the evidence's note or why, or the error that stopped it. */
const whyOf = (evidence: unknown, after: Record<string, unknown>): string | null => {
  const e = jsonObj(evidence)
  const w = e.why ?? e.note ?? e.reason ?? after.reason ?? after.error ?? null
  return w == null ? null : String(w).slice(0, 500)
}

interface Filter { targetIds?: ReadonlySet<string>; termKey?: string; adGroupIds?: ReadonlySet<string>; campaignIds?: ReadonlySet<string> }

/**
 * The items of the scope (every place, running or not), `days` back. `filter` narrows to one row (row.ts): its target
 * ids, or a term's words in its places.
 */
export async function historyItems(f: WasteFacts, s: ResolvedScope, days: number, kind: 'keyword' | 'term' | 'all', filter: Filter = {}): Promise<{ rows: HistoryItem[]; truncated: boolean }> {
  const now = f.now.getTime()
  const since = new Date(now - days * DAY_MS)
  const places = new Set([...f.adGroups.keys()].filter((id) => inScope(f, id, { ...s, idle: true })))
  if (!places.size) return { rows: [], truncated: false }
  const logs = await prisma.$queryRaw<Array<{
    id: string; entityId: string; actionType: string; actor: string | null; executionId: string | null; at: Date; status: string | null
    rolledBackAt: Date | null; before: unknown; after: unknown; evidence: unknown; outboundQueueId: string | null
    adGroupId: string; kind: string; expressionType: string; expressionValue: string; isNegative: boolean; negativeLevel: string | null; targetStatus: string; retiredAt: Date | null
  }>>(Prisma.sql`
    SELECT l.id, l."entityId", l."actionType", l."userId" AS actor, l."executionId", l."createdAt" AS at, l."amazonResponseStatus" AS status,
           l."rolledBackAt", l."payloadBefore" AS before, l."payloadAfter" AS after, l.evidence, l."outboundQueueId",
           t."adGroupId", t.kind, t."expressionType", t."expressionValue", t."isNegative", t."negativeLevel", t.status::text AS "targetStatus", t."retiredAt"
      FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id = l."entityId"
     WHERE l."entityType" = 'AD_TARGET' AND l."createdAt" >= ${since} AND t."adGroupId" = ANY(${[...places]}::text[])
       AND (l."actionType" IN ('create_negative_keyword', 'create_negative_product_target', 'retire_negative', ${Prisma.join(Object.values(HOLD_ACTIONS))})
            OR (NOT t."isNegative" AND l."payloadAfter" ? 'status' AND (l."payloadBefore" ->> 'status') IS DISTINCT FROM (l."payloadAfter" ->> 'status'))
            OR (NOT t."isNegative" AND (l."payloadAfter" ? 'keptPausedAt' OR l."payloadBefore" ? 'keptPausedAt')))
     ORDER BY l."createdAt" DESC, l.id DESC
     LIMIT ${HISTORY_MAX * 2}`)
  const sets = [...new Set(logs.map((l) => l.executionId).filter((x): x is string => !!x))]
  const [approvals, claude] = await Promise.all([
    sets.length ? prisma.agentApproval.findMany({ where: { id: { in: sets } }, select: { id: true } }) : Promise.resolve([]),
    sets.length ? prisma.agentApproval.findMany({ where: { id: { in: sets }, agentRun: { via: 'claude' } }, select: { id: true } }) : Promise.resolve([]),
  ])
  const approvalIds = new Set(approvals.map((a) => a.id))
  const names = { rules: f.names.rules, claudeChangeSets: new Set([...f.names.claudeChangeSets, ...claude.map((a) => a.id)]) }
  const missingRules = [...new Set(logs.map((l) => (l.actor ?? '').replace(/^automation:(automation:)*/, '').replace(/^rule-/, '')).filter((id) => id && l_isRule(id) && !names.rules.has(id)))]
  if (missingRules.length) for (const r of await prisma.automationRule.findMany({ where: { id: { in: missingRules } }, select: { id: true, name: true } })) (names.rules as Map<string, string>).set(r.id, r.name)

  // A negative another writer keeps (Harvest's source, the brain's funnel) is not undone here either.
  const keptBy = (id: string) => {
    const t = f.targetById.get(id)
    return t && t.isNegative ? negativeKeptBy(ownerOfNegative(f, t)) : null
  }
  const items: HistoryItem[] = []
  for (const l of logs) {
    if (!matchesFilter(f, filter, l)) continue
    const before = jsonObj(l.before)
    const after = jsonObj(l.after)
    const holdAction = HOLD_ACTION_OF[l.actionType] ?? null
    // A hold row changes Nexus only (SKIPPED: nothing to send): it is in force at once.
    const delivery: Delivery = holdAction === 'refused' ? 'REFUSED' : holdAction ? (l.rolledBackAt ? 'UNDONE' : 'LIVE') : deliveryOf(l.status, l.rolledBackAt)
    const refused = !holdAction && NOT_SENT.includes(String(l.status ?? '').toUpperCase()) && delivery !== 'CANCELLED'
    let action: HistoryAction
    let rowKind: HistoryItem['kind']
    let text: string
    let undo: HistoryItem['undo']
    if (l.isNegative) {
      rowKind = 'TERM'
      const m = negativeMatch(l.kind, l.expressionType)
      text = m === 'ASIN' ? l.expressionValue.toUpperCase() : l.expressionValue
      action = refused ? 'refused' : l.actionType === 'retire_negative' ? 'removed' : 'negated'
      if (action === 'removed') undo = { available: false, why: REMOVED_FINAL }
      else if (action === 'refused') undo = { available: false, why: 'Nothing changed at Amazon: there is nothing to undo.' }
      else if (l.retiredAt || l.targetStatus === 'ARCHIVED') undo = { available: false, why: 'Already removed.' }
      else if (keptBy(l.entityId)) undo = { available: false, why: keptBy(l.entityId)! }
      else if (l.executionId && approvalIds.has(l.executionId)) undo = { available: true, why: 'Undo removes the negative it made (final at Amazon).' }
      else undo = { available: false, why: 'Made outside a change set: remove the negative instead (final at Amazon).' }
    } else {
      const tm = targetMatch(l.kind, l.expressionType)
      rowKind = tm?.rowKind ?? 'KEYWORD'
      text = labelFor(l.expressionValue, l.kind || 'UNKNOWN', l.expressionType).label
      const to = String(after.status ?? '')
      action = holdAction ?? (refused ? 'refused'
        : after.keptPausedAt != null && before.keptPausedAt == null ? 'kept'
          : after.keptPausedAt == null && before.keptPausedAt != null && to !== 'ENABLED' ? 'released'
            : to === 'PAUSED' ? 'paused' : to === 'ENABLED' ? 'turned_on' : 'paused')
      if (to === 'ARCHIVED') continue
      const window = rollbackWindowMsFor(l.actionType)
      undo = holdAction === 'refused' ? { available: false, why: 'Nothing changed at Amazon: there is nothing to undo.' }
        : holdAction ? { available: false, why: holdAction === 'kept' ? 'The lock ends with Release lock (Stopped view), or with the Undo of the pause that set it.' : 'Keep it paused again from the Stopped view.' }
        : refused ? { available: false, why: 'Nothing changed at Amazon: there is nothing to undo.' }
        : l.rolledBackAt ? { available: false, why: 'Already undone.' }
          : delivery !== 'LIVE' && delivery !== 'SENT' ? { available: false, why: `It never landed (${delivery.toLowerCase()}): there is nothing to put back.` }
            : !Object.keys(before).length ? { available: false, why: 'Nothing on record to put back.' }
              : now - l.at.getTime() > window ? { available: false, why: `Older than the ${rollbackWindowLabel(l.actionType)} undo window for this kind of change.` }
                : { available: true, why: action === 'paused' || action === 'kept' ? 'Undo turns it back on.' : 'Undo pauses it again.' }
    }
    if (kind === 'keyword' && rowKind === 'TERM') continue
    if (kind === 'term' && rowKind !== 'TERM') continue
    const refs = placeRefs(f, l.adGroupId)
    const campaignLevel = l.isNegative && l.negativeLevel === 'CAMPAIGN'
    items.push({
      at: l.at.toISOString(), action, text, kind: rowKind, rowId: l.isNegative ? `neg:${l.entityId}` : `kw:${l.entityId}`,
      campaign: refs.campaign, adGroup: campaignLevel ? null : refs.adGroup, product: refs.product,
      by: refOfOwner(ownerOfActor(l.actor, names, l.executionId)),
      why: l.actionType === HOLD_ACTIONS.refused ? 'Kept paused — not turned on' : plainWords(whyOf(l.evidence, after)),
      changeId: l.id, changeSetId: l.executionId, delivery, undo,
    })
  }
  // The lock's refusals already written with their writer (above): their AdWriteRefusal twin is not shown again.
  const refusedAt = new Map<string, number[]>()
  for (const l of logs) if (l.actionType === HOLD_ACTIONS.refused) refusedAt.set(l.entityId, [...(refusedAt.get(l.entityId) ?? []), l.at.getTime()])
  const twin = (entityId: string, at: Date) => (refusedAt.get(entityId) ?? []).some((t) => Math.abs(t - at.getTime()) <= SAME_REFUSAL_MS)

  // The brain's refused negatives (a refusal leaves no action-log row of its own).
  const campaignsIn = new Set([...places].map((id) => f.adGroups.get(id)!.campaignId))
  if (kind !== 'keyword') {
    const refusals = await prisma.adsBrainNegative.findMany({
      where: { action: 'ADD', status: 'REFUSED', checkedAt: { gte: since }, campaignId: { in: [...campaignsIn] } },
      select: { id: true, text: true, match: true, campaignId: true, adGroupId: true, why: true, result: true, checkedAt: true, approvalId: true },
      orderBy: { checkedAt: 'desc' }, take: HISTORY_MAX,
    })
    for (const r of refusals) {
      if (filter.termKey && termKeyOf(r.text) !== filter.termKey) continue
      if (filter.adGroupIds && r.adGroupId && !filter.adGroupIds.has(r.adGroupId)) continue
      const g = r.adGroupId ? f.adGroups.get(r.adGroupId) : [...f.adGroups.values()].find((x) => x.campaignId === r.campaignId)
      if (!g || (r.adGroupId && !places.has(r.adGroupId))) continue
      const refs = placeRefs(f, g.id)
      items.push({
        at: r.checkedAt.toISOString(), action: 'refused', text: r.text, kind: 'TERM', rowId: null,
        campaign: refs.campaign, adGroup: r.adGroupId ? refs.adGroup : null, product: refs.product,
        by: { id: 'brain', name: 'Brain' }, why: plainWords((r.result ?? r.why ?? '').slice(0, 500)) || null,
        changeId: null, changeSetId: r.approvalId, delivery: 'REFUSED', undo: { available: false, why: 'Nothing changed at Amazon: there is nothing to undo.' },
      })
    }
  }

  // Writes the gate (or the kept-paused lock) refused before anything was sent: AdWriteRefusal, one per refusal; a refusal
  // whose queued write has its own action-log row above is that row already.
  const sentQueues = new Set(logs.map((l) => l.outboundQueueId).filter((x): x is string => !!x))
  const targetsIn = [...f.targetById.values()].filter((t) => places.has(t.adGroupId))
  if (targetsIn.length) {
    const refusals = await prisma.adWriteRefusal.findMany({
      where: { entityType: 'AD_TARGET', entityId: { in: targetsIn.map((t) => t.id) }, createdAt: { gte: since } },
      select: { id: true, deniedAt: true, reason: true, entityId: true, queueId: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: HISTORY_MAX,
    })
    for (const r of refusals) {
      if (r.queueId && sentQueues.has(r.queueId)) continue
      if (r.deniedAt === KEPT_PAUSED_DENIED_AT && twin(r.entityId!, r.createdAt)) continue
      const t = f.targetById.get(r.entityId!)!
      if (!matchesFilter(f, filter, { entityId: t.id, isNegative: t.isNegative, expressionValue: t.expressionValue, adGroupId: t.adGroupId, negativeLevel: t.negativeLevel })) continue
      const tm = t.isNegative ? null : targetMatch(t.kind, t.expressionType)
      const rowKind: HistoryItem['kind'] = t.isNegative ? 'TERM' : tm?.rowKind ?? 'KEYWORD'
      if ((kind === 'keyword' && rowKind === 'TERM') || (kind === 'term' && rowKind !== 'TERM')) continue
      const refs = placeRefs(f, t.adGroupId)
      items.push({
        at: r.createdAt.toISOString(), action: 'refused', text: t.isNegative ? t.expressionValue : labelFor(t.expressionValue, t.kind || 'UNKNOWN', t.expressionType).label,
        kind: rowKind, rowId: t.isNegative ? `neg:${t.id}` : `kw:${t.id}`, campaign: refs.campaign, adGroup: refs.adGroup, product: refs.product,
        by: { id: 'unknown', name: 'Unknown' },
        why: r.deniedAt === KEPT_PAUSED_DENIED_AT ? 'Kept paused — not turned on' : plainWords(r.reason.slice(0, 500)),
        changeId: null, changeSetId: null, delivery: 'REFUSED', undo: { available: false, why: 'Nothing changed at Amazon: there is nothing to undo.' },
      })
    }
  }

  // NWRITE's skips (Nexus only).
  for (const skip of await readSkipRows(since)) {
    if (filter.targetIds || filter.termKey) {
      const own = (filter.targetIds && [...filter.targetIds].some((id) => skip.rowKey === `kw:${id}`)) || (filter.termKey && skip.rowKey.endsWith(`|${filter.termKey}`))
      if (!own) continue
    }
    const isTerm = skip.rowKey.startsWith('term:')
    if ((kind === 'keyword' && isTerm) || (kind === 'term' && !isTerm)) continue
    const target = skip.rowKey.startsWith('kw:') ? f.targetById.get(skip.rowKey.slice(3)) : undefined
    const term = isTerm ? skip.rowKey.slice(5).split('|') : null
    const groupId = target?.adGroupId ?? (term ? [...f.adGroups.values()].find((g) => g.externalAdGroupId === term[1])?.id : undefined)
    if (!groupId || !places.has(groupId)) continue
    const refs = placeRefs(f, groupId)
    // An Unskip ended it (or the Undo of the skip): UNDONE, with who and when; past its end: ended; else it holds.
    const ended = skip.endedAt != null
    const over = !ended && skip.until.getTime() <= now
    const reason = plainWords(skip.reason)
    items.push({
      at: (skip.at ?? new Date(now)).toISOString(), action: 'skipped',
      text: target ? labelFor(target.expressionValue, target.kind || 'UNKNOWN', target.expressionType).label : (f.placesByKey.get(term!.slice(2).join('|'))?.[0]?.text ?? term!.slice(2).join('|')),
      kind: isTerm ? 'TERM' : (target && targetMatch(target.kind, target.expressionType)?.rowKind) || 'KEYWORD', rowId: skip.rowKey,
      campaign: refs.campaign, adGroup: refs.adGroup, product: refs.product,
      by: refOfOwner(ownerOfActor(skip.by, names)),
      why: `${ended ? `Skipped until ${romeDay(skip.until)}; unskipped ${romeTime(skip.endedAt!)}${skip.endedBy ? ` by ${ownerOfActor(skip.endedBy, names).name}` : ''}.` : over ? `Skipped until ${romeDay(skip.until)}: it has ended.` : `Skipped until ${romeDay(skip.until)}: it comes back with fresh numbers.`}${reason ? ` ${reason}` : ''}`,
      changeId: null, changeSetId: null, delivery: ended ? 'UNDONE' : 'LIVE',
      undo: ended ? { available: false, why: 'Already undone.' } : over ? { available: false, why: 'The skip has ended.' } : { available: true, why: 'Unskip brings it back now.' },
    })
  }

  // Step 4 — "Remove protection and stop": a negative the server could not send once the protection was removed.
  for (const fu of f.followUps ?? []) {
    if (new Date(fu.createdAt).getTime() < since.getTime()) continue
    for (const rowId of fu.rowIds) {
      const mine = fu.results.find((r) => r.rowId === rowId)
      if (!(fu.status === 'REFUSED' || (fu.status === 'SENT' && mine && !mine.sent))) continue
      if (filter.targetIds || filter.termKey) {
        const own = (filter.targetIds && [...filter.targetIds].some((id) => rowId === `kw:${id}`)) || (filter.termKey && rowId.endsWith(`|${filter.termKey}`))
        if (!own) continue
      }
      const isTerm = rowId.startsWith('term:')
      if ((kind === 'keyword' && isTerm) || (kind === 'term' && !isTerm)) continue
      const target = rowId.startsWith('kw:') ? f.targetById.get(rowId.slice(3)) : undefined
      const term = isTerm ? rowId.slice(5).split('|') : null
      const groupId = target?.adGroupId ?? (term ? [...f.adGroups.values()].find((g) => g.externalAdGroupId === term[1])?.id : undefined)
      if (!groupId || !places.has(groupId)) continue
      const refs = placeRefs(f, groupId)
      items.push({
        at: fu.endedAt ?? fu.createdAt, action: 'refused',
        text: target ? labelFor(target.expressionValue, target.kind || 'UNKNOWN', target.expressionType).label : (f.placesByKey.get(term!.slice(2).join('|'))?.[0]?.text ?? term!.slice(2).join('|')),
        kind: isTerm ? 'TERM' : (target && targetMatch(target.kind, target.expressionType)?.rowKind) || 'KEYWORD', rowId,
        campaign: refs.campaign, adGroup: refs.adGroup, product: refs.product,
        by: refOfOwner(ownerOfActor(fu.by, names)),
        why: `Not stopped after the protection was removed: ${plainWords((mine?.why ?? fu.why ?? 'it was refused').replace(/\.$/, ''))}.`,
        changeId: null, changeSetId: fu.approvalId, delivery: 'REFUSED',
        undo: { available: false, why: 'Nothing was sent: there is nothing to undo here (the protection\'s removal has its own Undo).' },
      })
    }
  }

  items.sort((a, b) => b.at.localeCompare(a.at))
  return { rows: items.slice(0, HISTORY_MAX), truncated: items.length > HISTORY_MAX }
}

/** Does one log belong to the row the filter names (its targets, or a negative of its words in its places)? */
function matchesFilter(f: WasteFacts, filter: Filter, l: { entityId: string; isNegative: boolean; expressionValue: string; adGroupId: string; negativeLevel: string | null }): boolean {
  if (!filter.targetIds && !filter.termKey) return true
  if (filter.targetIds?.has(l.entityId)) return true
  if (!filter.termKey || !l.isNegative || termKeyOf(l.expressionValue) !== filter.termKey) return false
  if (!filter.adGroupIds || filter.adGroupIds.has(l.adGroupId)) return true
  const g = f.adGroups.get(l.adGroupId)
  return l.negativeLevel === 'CAMPAIGN' && !!g && !!filter.campaignIds?.has(g.campaignId)
}

const l_isRule = (id: string) => !id.includes(':') && !/^(ads-brain|bid-brain|auto-bid|rank-|dayparting|budget|coverage|autopilot|tos-|reconcile|ads-write)/.test(id)

/** GET /advertising/waste/history. */
export async function readHistory(q: HistoryQuery, now: Date = new Date()): Promise<HistoryAnswer> {
  const scope = await scopedFacts(q, now)
  if ('error' in scope) return scope
  const days = Math.min(90, Math.max(1, Math.round(q.days ?? 30)))
  // Each market's history, merged newest first (one market's facts each).
  const outs = await Promise.all(scope.facts.map((f) => historyItems(f, { ...q, roots: scope.roots }, days, q.kind ?? 'all')))
  const rows = outs.flatMap((o) => o.rows).sort((a, b) => b.at.localeCompare(a.at))
  return { ok: true, rows: rows.slice(0, HISTORY_MAX), days, truncated: outs.some((o) => o.truncated) || rows.length > HISTORY_MAX }
}
