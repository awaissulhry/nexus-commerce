/**
 * ADS AUTONOMY W3-2 — cancel an Amazon ad write Nexus queued and has not sent yet, for Claude's cancel-queued-ad-write.
 *
 * Every ad write waits in the outbound queue for its grace window (holdUntil, 5 minutes unless sent at once) before the
 * worker sends it; the staged-changes tray's Discard cancels it there (POST /advertising/queued-mutations/:id/cancel).
 * This is the same cancel (`cancelPendingMutation`, ads-mutation.service.ts): only a row still PENDING inside its window,
 * compare-and-set, and Nexus puts each field back where it still holds the cancelled value. Nothing reaches Amazon.
 *
 *   one write    by its queue row (`outboundQueueId`: the staged tray, approval-status)
 *   a request    every write still waiting of one change set (`changeSetId`: a Claude request's approval id)
 *   both         that one write, only when it belongs to that change set
 *
 * The plan names each write exactly: what it changes (field, from → to), on which campaign, ad group, keyword, target or
 * product ad, who queued it, the change set and whether that is a Claude request, and when its window ends. A write
 * that left the queue, or whose window is over, is named apart and never cancelled.
 */
import prisma from '../../db.js'

export interface QueuedWriteInput {
  outboundQueueId?: string
  changeSetId?: string
}

/** What a cancelled write would have done to spend. */
export type WriteEffect = 'raise' | 'lowering' | 'change'

export interface QueuedWrite {
  queueId: string
  entityType: string
  entityId: string
  /** What a person calls it: `keyword "…" (campaign "…")`. */
  label: string
  campaignId: string | null
  market: string | null
  /** Each field it changes, as Nexus queued it (a bid in cents of the campaign's currency, a daily budget in its units). */
  fields: Array<{ field: string; from: string | null; to: string | null }>
  effect: WriteEffect
  /** It lowers a bid, a budget or a placement, or pauses or archives: cancelling it keeps today's value (spend stays up). */
  lowers: boolean
  queuedBy: string
  changeSetId: string | null
  /** The change set is a request Claude asked for (an approval of a Claude call). */
  byClaude: boolean
  /** Null: the write was queued to go at once (no grace window); it can be cancelled only while no worker has taken it. */
  graceEndsAt: string | null
}

/** A write named but not cancellable, and why. */
export interface NotCancellable {
  queueId: string
  label: string
  why: string
}

/** The request the cancelled writes came from, when they are ALL of it: what an undo asks for again. */
export interface SourceRequest {
  approvalId: string
  tool: string
  args: Record<string, unknown>
}

export interface CancelPlan {
  action: 'cancel-queued-ad-write'
  writes: QueuedWrite[]
  notCancellable: NotCancellable[]
  /** The writes it cancels that were lowerings: cancelling one keeps today's bid, budget or status. */
  keepsSpend: string[]
  totals: { writes: number; byClaude: number; byOthers: number }
  /** The rows it starts from (state and window): one moving makes the approved cancel a different one. */
  basis: string
  summary: string
  effect: string
}

/** The fields whose value is money going out (as the mutation layer's SPEND_FIELDS): a higher value spends more. */
const SPEND_FIELDS = new Set(['bid', 'defaultBid', 'dailyBudget', 'PLACEMENT_TOP', 'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH'])

/**
 * Pure — what a write does to spend: a higher bid, budget or placement, or switching on, raises; lower, or a pause or
 * archive, lowers. `lowers`: any field of it lowers (a write that also raises something is a `change`, and still lowers).
 */
export function writeEffect(fields: Array<{ field: string; from: string | null; to: string | null }>): { effect: WriteEffect; lowers: boolean } {
  let raise = false
  let lower = false
  for (const f of fields) {
    if (SPEND_FIELDS.has(f.field)) {
      const from = Number(f.from), to = Number(f.to)
      if (Number.isFinite(from) && Number.isFinite(to)) {
        if (to > from) raise = true
        else if (to < from) lower = true
      } else raise = true
    } else if (f.field === 'status') {
      if (f.to === 'ENABLED' && f.from !== 'ENABLED') raise = true
      else if (f.to !== 'ENABLED' && f.from === 'ENABLED') lower = true
    } else {
      raise = true // a portfolio, a bidding strategy, a name: judged as a change that can add spend
    }
  }
  const effect: WriteEffect = raise ? (lower ? 'change' : 'raise') : lower ? 'lowering' : 'change'
  return { effect, lowers: lower }
}

/** Names of the entities the writes change, as a person reads them. */
async function labelsOf(rows: Array<{ entityType: string; entityId: string }>): Promise<Map<string, { label: string; campaignId: string | null }>> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))]
  const [campaigns, groups, targets, ads] = await Promise.all([
    ids('CAMPAIGN').length ? prisma.campaign.findMany({ where: { id: { in: ids('CAMPAIGN') } }, select: { id: true, name: true } }) : [],
    ids('AD_GROUP').length ? prisma.adGroup.findMany({ where: { id: { in: ids('AD_GROUP') } }, select: { id: true, name: true, campaign: { select: { id: true, name: true } } } }) : [],
    ids('AD_TARGET').length ? prisma.adTarget.findMany({ where: { id: { in: ids('AD_TARGET') } }, select: { id: true, kind: true, expressionValue: true, adGroup: { select: { campaign: { select: { id: true, name: true } } } } } }) : [],
    ids('PRODUCT_AD').length ? prisma.adProductAd.findMany({ where: { id: { in: ids('PRODUCT_AD') } }, select: { id: true, sku: true, asin: true, adGroup: { select: { campaign: { select: { id: true, name: true } } } } } }) : [],
  ])
  const out = new Map<string, { label: string; campaignId: string | null }>()
  for (const c of campaigns) out.set(`CAMPAIGN:${c.id}`, { label: `campaign "${c.name}"`, campaignId: c.id })
  for (const g of groups) out.set(`AD_GROUP:${g.id}`, { label: `ad group "${g.name}" (campaign "${g.campaign.name}")`, campaignId: g.campaign.id })
  for (const t of targets) out.set(`AD_TARGET:${t.id}`, { label: `${t.kind === 'KEYWORD' ? 'keyword' : 'target'} "${t.expressionValue}" (campaign "${t.adGroup.campaign.name}")`, campaignId: t.adGroup.campaign.id })
  for (const a of ads) out.set(`PRODUCT_AD:${a.id}`, { label: `the ad of ${a.sku ?? a.asin ?? a.id} (campaign "${a.adGroup.campaign.name}")`, campaignId: a.adGroup.campaign.id })
  return out
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Why a queue row cannot be cancelled now, or null when it can. */
function notCancellableWhy(row: { syncStatus: string; holdUntil: Date | null }, now: Date): string | null {
  if (row.syncStatus === 'CANCELLED') return 'it is cancelled already'
  if (row.syncStatus === 'SUCCESS') return 'it was sent to Amazon'
  if (row.syncStatus === 'IN_PROGRESS') return 'it is being sent to Amazon now'
  if (row.syncStatus !== 'PENDING') return `it left the queue (${row.syncStatus.toLowerCase()})`
  if (row.holdUntil && row.holdUntil <= now) return 'its grace window is over: the worker sends it at its next pass'
  return null
}

/**
 * The cancel, as a person approves it: each write it cancels, named, and each it cannot, with why. A refusal when
 * nothing names an ad write, or when none can be cancelled any more. Read-only.
 */
export async function planCancelQueuedWrites(input: QueuedWriteInput): Promise<{ ok: true; plan: CancelPlan; source: SourceRequest | null } | { ok: false; error: string }> {
  const byQueue = input.outboundQueueId?.trim()
  const bySet = input.changeSetId?.trim()
  if (!byQueue && !bySet) return { ok: false, error: 'Name the write: outboundQueueId (one queued write) or changeSetId (every write of one request still waiting).' }

  // The queue rows it names, and the change set of each (the audit row the write was queued with).
  let queueIds: string[]
  if (bySet) {
    const logs = await prisma.advertisingActionLog.findMany({ where: { executionId: bySet, outboundQueueId: { not: null } }, select: { outboundQueueId: true } })
    queueIds = [...new Set(logs.map((l) => l.outboundQueueId as string))]
    if (!queueIds.length) return { ok: false, error: `changeSetId ${bySet}: not found in this business (no queued Amazon ad write carries it).` }
    if (byQueue) {
      if (!queueIds.includes(byQueue)) return { ok: false, error: `outboundQueueId ${byQueue}: not found in change set ${bySet}.` }
      queueIds = [byQueue]
    }
  } else {
    queueIds = [byQueue!]
  }
  const [queued, mutations, logs] = await Promise.all([
    prisma.outboundSyncQueue.findMany({ where: { id: { in: queueIds } }, select: { id: true, syncStatus: true, holdUntil: true, payload: true } }),
    prisma.adMutation.findMany({ where: { outboundQueueId: { in: queueIds } }, select: { outboundQueueId: true, entityType: true, entityId: true, marketplace: true, field: true, previousValue: true, intendedValue: true, actor: true, state: true }, orderBy: { field: 'asc' } }),
    prisma.advertisingActionLog.findMany({ where: { outboundQueueId: { in: queueIds } }, select: { outboundQueueId: true, executionId: true } }),
  ])
  if (byQueue && !queued.length) return { ok: false, error: `outboundQueueId ${byQueue}: not found in this business.` }
  const fieldsOf = new Map<string, typeof mutations>()
  for (const m of mutations) fieldsOf.set(m.outboundQueueId as string, [...(fieldsOf.get(m.outboundQueueId as string) ?? []), m])
  // Only an ad write: a queue row with its typed ad rows (a listing price or stock push is not cancelled here).
  const ads = queued.filter((q) => fieldsOf.has(q.id))
  if (!ads.length) return { ok: false, error: `${byQueue ? `outboundQueueId ${byQueue}` : `changeSetId ${bySet}`}: not an Amazon ad write Nexus queued.` }
  const setOf = new Map(logs.map((l) => [l.outboundQueueId as string, l.executionId ?? null]))
  const sets = [...new Set(ads.map((q) => setOf.get(q.id)).filter((id): id is string => !!id))]
  const approvals = sets.length
    ? await prisma.agentApproval.findMany({ where: { id: { in: sets } }, select: { id: true, toolName: true, args: true, agentRun: { select: { via: true } } } })
    : []
  const approvalOf = new Map(approvals.map((a) => [a.id, a]))
  const names = await labelsOf(ads.map((q) => fieldsOf.get(q.id)![0]))

  const now = new Date()
  const writes: QueuedWrite[] = []
  const notCancellable: NotCancellable[] = []
  for (const q of ads.sort((a, b) => a.id.localeCompare(b.id))) {
    const rows = fieldsOf.get(q.id)!
    const first = rows[0]
    const name = names.get(`${first.entityType}:${first.entityId}`) ?? { label: `${first.entityType.toLowerCase()} ${first.entityId}`, campaignId: null }
    const why = notCancellableWhy(q, now)
    if (why) { notCancellable.push({ queueId: q.id, label: name.label, why }); continue }
    // A field a newer write replaced is never sent (SUPERSEDED): it is not named as cancelled either.
    const fields = rows.filter((r) => r.state !== 'SUPERSEDED').map((r) => ({ field: r.field, from: r.previousValue, to: r.intendedValue }))
    const changeSetId = setOf.get(q.id) ?? null
    const approval = changeSetId ? approvalOf.get(changeSetId) : undefined
    writes.push({
      queueId: q.id, entityType: first.entityType, entityId: first.entityId, label: name.label, campaignId: name.campaignId,
      market: first.marketplace ?? null, fields, ...writeEffect(fields),
      queuedBy: first.actor || String((q.payload as { actor?: unknown } | null)?.actor ?? 'unrecorded'),
      changeSetId, byClaude: approval?.agentRun?.via === 'claude', graceEndsAt: q.holdUntil?.toISOString() ?? null,
    })
  }
  if (!writes.length) {
    return { ok: false, error: `Nothing to cancel: ${notCancellable.map((n) => `${n.label} — ${n.why}`).join('; ')}.` }
  }

  // The request they came from, when this cancel takes ALL of it (every write it queued, none sent, nothing inline):
  // undo asks for that request again. Never a change plan (its steps are asked for one by one).
  let source: SourceRequest | null = null
  if (sets.length === 1 && writes.every((w) => w.changeSetId === sets[0])) {
    const approval = approvalOf.get(sets[0])
    const all = await prisma.advertisingActionLog.findMany({ where: { executionId: sets[0] }, select: { outboundQueueId: true } })
    const cancelled = new Set(writes.map((w) => w.queueId))
    if (approval && approval.toolName !== 'submit-change-plan' && all.every((l) => l.outboundQueueId && cancelled.has(l.outboundQueueId))) {
      source = { approvalId: approval.id, tool: approval.toolName, args: (approval.args ?? {}) as Record<string, unknown> }
    }
  }

  const byClaude = writes.filter((w) => w.byClaude).length
  const keepsSpend = writes.filter((w) => w.lowers).map((w) => w.label)
  const ends = writes.map((w) => w.graceEndsAt).filter((t): t is string => !!t).sort()[0] ?? null
  const summary = `Cancels ${plural(writes.length, 'queued Amazon ad write', 'queued Amazon ad writes')} before ${writes.length === 1 ? 'it is' : 'they are'} sent: `
    + writes.map((w) => `${w.label} (${w.fields.map((f) => `${f.field} ${f.from ?? '(empty)'} → ${f.to ?? '(empty)'}`).join(', ')})`).join('; ') + '.'
  return {
    ok: true,
    source,
    plan: {
      action: 'cancel-queued-ad-write',
      writes,
      notCancellable,
      keepsSpend,
      totals: { writes: writes.length, byClaude, byOthers: writes.length - byClaude },
      basis: JSON.stringify(writes.map((w) => [w.queueId, w.graceEndsAt])),
      summary,
      effect: `${summary} Nothing reaches Amazon: Nexus puts each field back where it still holds the cancelled value. `
        + (keepsSpend.length ? `${plural(keepsSpend.length, 'write lowers', 'writes lower')} a bid, a budget or a status: cancelling keeps today's value (${keepsSpend.join('; ')}). ` : '')
        + (ends ? `It works only while the write waits: the first grace window ends at ${ends}; approved after that, a write already sent is not cancelled.` : '')
        + (writes.some((w) => !w.graceEndsAt) ? ` ${plural(writes.filter((w) => !w.graceEndsAt).length, 'write was', 'writes were')} queued to go at once, with no grace window: cancellable only while still waiting and no worker has taken ${writes.length === 1 ? 'it' : 'them'}.` : ''),
    },
  }
}

export interface CancelOutcome {
  cancelled: Array<{ queueId: string; label: string; restored: string[]; kept: string[] }>
  failed: Array<{ queueId: string; label: string; why: string }>
}

/** Cancel each write the plan names, one by one, through the staged tray's own cancel. */
export async function cancelQueuedWrites(writes: readonly QueuedWrite[]): Promise<CancelOutcome> {
  const { cancelPendingMutation } = await import('./ads-mutation.service.js')
  const out: CancelOutcome = { cancelled: [], failed: [] }
  for (const w of writes) {
    const r = await cancelPendingMutation(w.queueId)
    if (r.ok) out.cancelled.push({ queueId: w.queueId, label: w.label, restored: r.restored ?? [], kept: r.kept ?? [] })
    else out.failed.push({ queueId: w.queueId, label: w.label, why: r.error === 'grace_expired' ? 'its grace window ended' : r.error?.startsWith('not_pending') ? 'it left the queue meanwhile' : r.error ?? 'refused' })
  }
  return out
}

/** The queue rows still cancelled now, of those a cancel cancelled (its undo compares them). */
export async function stillCancelled(queueIds: readonly string[]): Promise<string[]> {
  if (!queueIds.length) return []
  const rows = await prisma.outboundSyncQueue.findMany({ where: { id: { in: [...queueIds] } }, select: { id: true, syncStatus: true } })
  const cancelled = new Set(rows.filter((r) => r.syncStatus === 'CANCELLED').map((r) => r.id))
  return queueIds.filter((id) => cancelled.has(id))
}
