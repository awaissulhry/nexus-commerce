/**
 * Negative Targeting page — "Remove protection and stop" finishes on the server.
 *
 * A shopper's term that a protected term keeps safe cannot get its negative in the same change set as the removal: the
 * negative's tool refuses a protected term (the negation policy refuses every writer). So the page sends the removal, and
 * the negatives that wait for it (`after: 'UNPROTECT'`) are written here as ONE follow-up (AdsWasteFollowUp). Once the
 * removal has run, the server sends them through the page's own write (write.ts previewWaste → applyWaste: the tool's dry
 * run as the person, one change set asked and approved as that person, its undo window, its audit rows) — as the person
 * who approved the removal (approval-inbox.service.ts deciderPrincipal: re-checked now), never another gate or approval.
 *
 *   create   applyWaste, when the removal is queued and some negatives wait for it
 *   run      claims WAITING → SENDING (one runner wins); waits while the removal has not run; refuses in plain words when it
 *            did not run (rejected, expired, failed) or the person may no longer do it; else reads the waiting negatives
 *            again and sends those that are ready, saying why for each one that is not (SENT · REFUSED)
 *   due      every WAITING follow-up of the business (the cron, jobs/waste-follow-up.job.ts, about once a minute), and a SENDING one
 *            left by a stopped runner is closed (never sent twice)
 *   cancel   the person's Undo: WAITING → CANCELLED (nothing is sent); once sent, the answer names the negatives' change
 *            set so the page undoes it
 *   read     the follow-up with its negatives' change set as it is now (in its undo window, or ran), for the page's words
 *   reads    the rows (`followUp`: waiting, or not stopped and why) and their History (refused, with why)
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import type { UserPrincipal } from '../../agents/call-tool.js'
import type { WasteItem } from './write.js'

export type FollowUpStatus = 'WAITING' | 'SENDING' | 'SENT' | 'REFUSED' | 'CANCELLED'
/** Per row: asked and approved (`sent`: its change set holds it), where it lands then, or why not. */
export interface FollowUpResult { rowId: string; sent: boolean; why: string | null; lands?: 'amazon' | 'nexus' | null }
export interface FollowUpView {
  approvalId: string
  status: FollowUpStatus
  changeSetId: string | null
  rowIds: string[]
  results: FollowUpResult[]
  why: string | null
  createdAt: string
  endedAt: string | null
  /** The negatives' change set now: still in its undo window (scheduled), running, or ran (executed) — the page's words. */
  changeSet: { status: string; executeAfter: string | null } | null
}

/** A runner that stopped mid-send leaves SENDING: past this it is closed, never sent again (it may have run). */
export const SENDING_LEASE_MS = 10 * 60_000
/** The request's words (the approver and the ads audit read them). */
const FOLLOW_WHY = 'after the protection was removed'
/** Removal statuses that mean it has not run yet. */
const NOT_YET = new Set(['pending', 'scheduled', 'executing'])

const resultsOf = (v: unknown): FollowUpResult[] => (Array.isArray(v) ? v as FollowUpResult[] : [])
function viewOf(r: { approvalId: string; status: string; changeSetId: string | null; rowIds: string[]; results: unknown; why: string | null; createdAt: Date; endedAt: Date | null }, changeSet: FollowUpView['changeSet'] = null): FollowUpView {
  return { approvalId: r.approvalId, status: r.status as FollowUpStatus, changeSetId: r.changeSetId, rowIds: r.rowIds, results: resultsOf(r.results), why: r.why, createdAt: r.createdAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null, changeSet }
}
const SELECT = { id: true, approvalId: true, status: true, changeSetId: true, rowIds: true, results: true, why: true, createdAt: true, endedAt: true, items: true } as const

/** The stops of a review that wait for its removals: those items (and the removals they stand on). Pure. */
export function followUpItems(items: readonly WasteItem[], waiting: ReadonlySet<number>): WasteItem[] {
  return items.filter((it, i) => it.action === 'UNPROTECT' || waiting.has(i))
}

/** applyWaste: the negatives that wait for this removal, written once (one per removal change set). */
export async function createFollowUp(args: { approvalId: string; items: readonly WasteItem[]; by: string }): Promise<FollowUpView> {
  const rowIds = [...new Set(args.items.filter((i) => i.action !== 'UNPROTECT').map((i) => i.rowId.trim()))]
  const row = await prisma.adsWasteFollowUp.create({ data: { approvalId: args.approvalId, items: args.items as never, rowIds, by: args.by }, select: SELECT })
  return viewOf(row)
}

/** The follow-up of a removal, with its negatives' change set as it is now, or null. */
export async function readFollowUp(approvalId: string): Promise<FollowUpView | null> {
  const row = await prisma.adsWasteFollowUp.findFirst({ where: { approvalId }, orderBy: { createdAt: 'desc' }, select: SELECT })
  if (!row) return null
  const set = row.changeSetId ? await prisma.agentApproval.findUnique({ where: { id: row.changeSetId }, select: { status: true, executeAfter: true } }) : null
  return viewOf(row, set ? { status: set.status, executeAfter: set.executeAfter?.toISOString() ?? null } : null)
}

async function close(id: string, from: FollowUpStatus, data: { status: FollowUpStatus; why?: string | null; results?: FollowUpResult[]; changeSetId?: string | null }): Promise<void> {
  await prisma.adsWasteFollowUp.updateMany({
    where: { id, status: from },
    data: { status: data.status, why: data.why ?? null, ...(data.results ? { results: data.results as never } : {}), ...(data.changeSetId !== undefined ? { changeSetId: data.changeSetId } : {}), endedAt: data.status === 'WAITING' ? null : new Date() },
  })
}

/**
 * Run one follow-up now, if its removal has run: the negatives sent as the person who approved the removal, or why not.
 * Safe to call from several places at once (the cron, the page's "now"): one runner claims it.
 */
export async function runFollowUp(approvalId: string): Promise<FollowUpView | null> {
  const row = await prisma.adsWasteFollowUp.findFirst({ where: { approvalId, status: 'WAITING' }, orderBy: { createdAt: 'desc' }, select: SELECT })
  if (!row) return readFollowUp(approvalId)
  const claimed = await prisma.adsWasteFollowUp.updateMany({ where: { id: row.id, status: 'WAITING' }, data: { status: 'SENDING' } })
  if (!claimed.count) return readFollowUp(approvalId)
  try {
    const removal = await prisma.agentApproval.findUnique({ where: { id: approvalId }, select: { status: true, toolName: true, decidedBy: true, decidedByUserId: true, workspaceId: true } })
    if (removal && NOT_YET.has(removal.status)) { await close(row.id, 'SENDING', { status: 'WAITING' }); return readFollowUp(approvalId) }
    if (!removal || removal.status !== 'executed') {
      await close(row.id, 'SENDING', { status: 'REFUSED', why: `The protection was not removed (${removal ? `it was ${removal.status}` : 'its request is gone'}), so no negative was sent.` })
      return readFollowUp(approvalId)
    }
    const { deciderPrincipal } = await import('../../agent-fleet/approval-inbox.service.js')
    const decider = await deciderPrincipal(removal)
    if ('refusal' in decider) {
      await close(row.id, 'SENDING', { status: 'REFUSED', why: `No negative was sent: ${decider.refusal}.` })
      return readFollowUp(approvalId)
    }
    const out = await sendReady(row.items as unknown as WasteItem[], decider.principal)
    await close(row.id, 'SENDING', out)
    return readFollowUp(approvalId)
  } catch (error) {
    logger.error('[waste-follow-up] run failed', { approvalId, error: error instanceof Error ? error.message : String(error) })
    // Before anything was asked it may simply run again; the claim is put back.
    await close(row.id, 'SENDING', { status: 'WAITING' })
    throw error
  }
}

/** Read the waiting negatives again as the person and send those that are ready; why not for each of the others. */
async function sendReady(items: readonly WasteItem[], person: UserPrincipal): Promise<{ status: FollowUpStatus; why: string | null; results: FollowUpResult[]; changeSetId?: string | null }> {
  const { applyWaste, previewWaste } = await import('./write.js')
  const read = await previewWaste(items, person, FOLLOW_WHY, { reach: false })
  const results: FollowUpResult[] = []
  const ready: WasteItem[] = []
  read.steps.forEach((s, i) => {
    const item = items[read.itemOf[i]]
    if (!item || item.action === 'UNPROTECT') return
    if (s.after) results.push({ rowId: item.rowId, sent: false, why: 'The protection is still there, so its negative was not sent.' })
    else if (s.refusal) results.push({ rowId: item.rowId, sent: false, why: s.refusal.label })
    else ready.push(item)
  })
  if (!ready.length) return { status: 'REFUSED', why: results[0]?.why ?? 'Nothing was left to send.', results }
  const again = await previewWaste(ready, person, FOLLOW_WHY, { reach: false })
  const sent = await applyWaste({ items: ready, planHash: again.planHash, why: FOLLOW_WHY }, person)
  const ok = sent.http === 200 || sent.http === 202
  const why = ok ? null : String(sent.body.error ?? 'refused')
  const changeSetId = ok && typeof sent.body.changeSetId === 'string' ? sent.body.changeSetId : null
  const steps = (Array.isArray(sent.body.steps) ? sent.body.steps : again.steps) as Array<{ rowId: string; refusal: { label: string } | null; lands?: 'amazon' | 'nexus' | 'approval' | null }>
  for (const item of ready) {
    const s = steps.find((x) => x.rowId === item.rowId)
    const lands = s?.lands === 'nexus' ? 'nexus' : s?.lands ? 'amazon' : null
    results.push({ rowId: item.rowId, sent: ok && !s?.refusal, why: !ok ? why : s?.refusal?.label ?? null, lands })
  }
  const any = results.some((r) => r.sent)
  return { status: any ? 'SENT' : 'REFUSED', why: any ? null : why ?? results.find((r) => !r.sent)?.why ?? null, results, changeSetId }
}

/** The cron: every follow-up of this business that waits (and close one a stopped runner left mid-send). */
export async function runDueFollowUps(now: Date = new Date()): Promise<{ ran: number; sent: number; closed: number }> {
  const stale = await prisma.adsWasteFollowUp.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: new Date(now.getTime() - SENDING_LEASE_MS) } },
    data: { status: 'REFUSED', why: 'Interrupted while it was being sent: open the row to stop it again.', endedAt: now },
  })
  const due = await prisma.adsWasteFollowUp.findMany({ where: { status: 'WAITING' }, select: { approvalId: true }, orderBy: { createdAt: 'asc' }, take: 50 })
  let sent = 0
  for (const d of due) {
    const out = await runFollowUp(d.approvalId).catch(() => null)
    if (out?.status === 'SENT') sent++
  }
  return { ran: due.length, sent, closed: stale.count }
}

/** The person's Undo: a follow-up that has not run is cancelled; one that ran names the change set to undo. */
export async function cancelFollowUp(approvalId: string, by: string): Promise<FollowUpView | null> {
  await prisma.adsWasteFollowUp.updateMany({ where: { approvalId, status: 'WAITING' }, data: { status: 'CANCELLED', why: `Undone by ${by.startsWith('user:') ? 'a person' : by}: nothing was sent.`, endedAt: new Date() } })
  return readFollowUp(approvalId)
}

/** The rows' follow-ups since a day (newest per row first): what the rows and their History say. */
export async function readFollowUpRows(since: Date): Promise<Array<FollowUpView & { by: string }>> {
  const rows = await prisma.adsWasteFollowUp.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 500, select: { ...SELECT, by: true } })
  return rows.map((r) => ({ ...viewOf(r), by: r.by }))
}

/**
 * A row's follow-up as the row shows it: waiting (its negative is sent once the protection is removed), or not stopped
 * and why (refused). A sent or cancelled one shows nothing on the row (its negative, or nothing, is what it did). Pure.
 */
export function rowFollowUp(list: ReadonlyArray<FollowUpView>, rowId: string): { status: 'WAITING' | 'REFUSED'; why: string | null; at: string } | null {
  for (const f of list) {
    if (!f.rowIds.includes(rowId)) continue
    if (f.status === 'WAITING' || f.status === 'SENDING') return { status: 'WAITING', why: null, at: f.createdAt }
    const mine = f.results.find((r) => r.rowId === rowId)
    if (f.status === 'REFUSED' || (f.status === 'SENT' && mine && !mine.sent)) return { status: 'REFUSED', why: mine?.why ?? f.why, at: f.endedAt ?? f.createdAt }
    return null
  }
  return null
}
