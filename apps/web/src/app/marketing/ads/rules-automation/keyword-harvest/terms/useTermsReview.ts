'use client'

/**
 * Keyword Harvest page, Terms view — every change of the view goes through ONE review (the DS ReviewChangesModal: one
 * summary, one table, a counted button) and ends in Done with Undo where the server allows it (2026-10-11, lane TERMS).
 *
 *   Skip 7 d / 30 d / for good   POST /skip (Nexus only, at once)              Undo: POST /unskip
 *   Unskip                       POST /unskip                                  Undo: skip again (for good, or 7 d / 30 d by
 *                                                                              what was left)
 *   Approve                      POST /waiting/decide (the Approvals page's    Undo: take the approve back while its undo
 *                                own path, as this person)                     window runs
 *   Reject                       POST /waiting/decide                          no Undo: a rejected request does not come back
 *   Undo harvest                 POST /undo, approved in the same click        Undo: take that approve back
 *
 * An approve that needs the approver's authenticator code (the server answers `mfa_required`) asks for it in the DS
 * code dialog, one request at a time (a raise is never approved in bulk); a wrong code keeps the dialog with its words.
 */
import { useCallback, useRef, useState } from 'react'
import type { ReviewGroup, ReviewPanelChange, ReviewResult, ReviewState } from '@/design-system/patterns'
import { relWords } from '../../bid/_shared/format'
import { decideWaiting, skipTerms, takeBackApproval, undoHarvests, unskipTerms } from '../_shared/harvestApi'
import type { HarvestCandidateRow, SkipDays } from '../_shared/types'
import {
  decideButtonWords, decideChanges, decideDoneLine, DONE_VERB, plural, REVIEW_GROUPS, requestIds, skipChanges, SKIP_WORD, undoChanges,
  unskipChanges,
} from './termsModel'

export type TermsTask =
  | { kind: 'skip'; rows: HarvestCandidateRow[]; days: SkipDays }
  | { kind: 'unskip'; rows: HarvestCandidateRow[] }
  /** Every loaded row of the requests decided (a request can cover several terms): the review lists all their writes. */
  | { kind: 'approve' | 'reject'; rows: HarvestCandidateRow[]; leftOut?: number }
  | { kind: 'undo'; rows: HarvestCandidateRow[] }

type Results = Record<string, ReviewResult>
type UndoFn = () => Promise<Results>

export interface TermsReview {
  task: TermsTask
  changes: ReviewPanelChange[]
  /** The table's tabs (Approve / Reject: Keywords · Negatives). */
  groups: readonly ReviewGroup[]
  /** The Done line when counting the rows cannot say it (a decision counts requests). */
  doneLine?: { line: string; tone: 'success' | 'warning' | 'danger' }
  /** Where the focus goes after Done (S16): the first term the change was about. */
  focusId: string | null
  state: ReviewState
  title: string
  summary: string
  saveLabel: string
  doneVerb: string
  undo: UndoFn | null
  undoing: boolean
}

export interface StepUpAsk { approvalId: string; sentence: string; busy: boolean; error: string | null }

const CODE_NEEDED = new Set(['mfa_required', 'mfa_invalid'])
/** The routes' caps (advertising-harvest.routes.ts): decide and undo ≤ 200 a call, skip / unskip ≤ 5,000 (R6). */
export const DECIDE_MAX = 200
export const UNDO_MAX = 200
export const SKIP_MAX = 5000
/** A list in pieces the route takes. Pure. */
export function chunked<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
/** The answers of every piece, as one (R6): the pieces' results, or the first refusal for the pieces that failed. */
async function inPieces<T, R>(list: readonly T[], size: number, send: (piece: T[]) => Promise<{ ok: true; data: R } | { ok: false; status: number; words: string }>): Promise<Array<{ piece: T[]; out: { ok: true; data: R } | { ok: false; status: number; words: string } }>> {
  const done: Array<{ piece: T[]; out: { ok: true; data: R } | { ok: false; status: number; words: string } }> = []
  for (const piece of chunked(list, size)) done.push({ piece, out: await send(piece) })
  return done
}
/** The approvals' undo window (approval-inbox.service.ts UNDO_WINDOW_MS): the review says how long Undo lasts. */
export const UNDO_SECONDS = 20
const DAY = 86_400_000

/** The skip to put back after an unskip: for good stays for good; a timed skip comes back as 7 d or 30 d. Pure. */
export function reskipDays(until: string | null, now: number = Date.now()): SkipDays {
  if (until == null) return null
  const left = Date.parse(until) - now
  return left <= 7 * DAY ? 7 : 30
}

function titleOf(task: TermsTask): string {
  switch (task.kind) {
    case 'skip': return 'Skip terms'
    case 'unskip': return 'Unskip terms'
    case 'approve': return 'Approve harvests'
    case 'reject': return 'Reject harvests'
    case 'undo': return 'Undo harvests'
  }
}
function summaryOf(task: TermsTask): string {
  switch (task.kind) {
    case 'skip': return task.days == null ? 'Nexus only · hidden until you unskip' : 'Nexus only · comes back by itself'
    case 'unskip': return 'Nexus only'
    // A rule's ask is applied by its rule at once; a change set waits out the undo window.
    case 'approve': {
      const when = task.rows.every((r) => r.waiting?.kind === 'rule-ask') ? 'Amazon · at once' : `Amazon · Undo for ${UNDO_SECONDS} s`
      return task.leftOut ? `${when} · ${plural(task.leftOut, 'request')} left out: cannot be approved now` : when
    }
    case 'reject': return 'Nothing is sent'
    case 'undo': return `Amazon · keyword paused, blocks removed · Undo for ${UNDO_SECONDS} s`
  }
}
function changesOf(task: TermsTask): ReviewPanelChange[] {
  switch (task.kind) {
    case 'skip': return skipChanges(task.rows, task.days)
    case 'unskip': return unskipChanges(task.rows)
    case 'approve':
    case 'reject': return decideChanges(task.rows, task.kind)
    case 'undo': return undoChanges(task.rows)
  }
}
function focusOf(task: TermsTask): string | null {
  return task.rows[0]?.id ?? null
}

function saveLabelOf(task: TermsTask, n: number): string {
  switch (task.kind) {
    case 'skip': return `${SKIP_WORD(task.days).replace('Skipped', 'Skip')} · ${plural(n, 'term')}`
    case 'unskip': return `Show ${plural(n, 'term')}`
    case 'approve':
    case 'reject': return decideButtonWords(task.kind, task.rows).long
    case 'undo': return `Undo ${plural(n, 'harvest')}`
  }
}

const approvedWords = (executeAfter: string | null | undefined): string => (executeAfter ? `Approved · runs ${relWords(executeAfter)}` : 'Approved')

export function useTermsReview({ after }: { after: () => Promise<void> | void }) {
  const [review, setReview] = useState<TermsReview | null>(null)
  const [stepUp, setStepUp] = useState<StepUpAsk | null>(null)
  /** The requests still waiting for a code, and the review rows each one answers. */
  const codeQueue = useRef<Array<{ approvalId: string; decide: 'approve' | 'reject'; changeIds: string[] }>>([])
  const results = useRef<Results>({})
  const pendingUndo = useRef<UndoFn | null>(null)
  /** Approves that went through with a code (their Undo is the same take-back). */
  const codeApproved = useRef<string[]>([])
  /** Requests approved in this decision's first pass (no code needed). */
  const approvedCount = useRef(0)

  const ask = useCallback((task: TermsTask) => {
    const changes = changesOf(task)
    codeQueue.current = []
    results.current = {}
    pendingUndo.current = null
    codeApproved.current = []
    approvedCount.current = 0
    setStepUp(null)
    const decide = task.kind === 'approve' || task.kind === 'reject'
    setReview({
      task, changes, groups: decide ? REVIEW_GROUPS : [], focusId: focusOf(task), state: { phase: 'ready' }, title: titleOf(task), summary: summaryOf(task),
      saveLabel: saveLabelOf(task, changes.length), doneVerb: DONE_VERB[task.kind], undo: null, undoing: false,
    })
  }, [])

  /** A decision's Done line counts requests: one result per request, read from its rows. */
  const doneLineOf = (r: TermsReview, res: Results) => {
    if (r.task.kind !== 'approve' && r.task.kind !== 'reject') return undefined
    const byRequest = new Map<string, boolean>()
    let undone = 0
    for (const c of r.changes) {
      const a = (c as { approvalId?: string }).approvalId
      const got = res[c.id]
      if (!a || !got || byRequest.has(a)) continue
      const back = /^Undone/.test(got.words)
      if (back && got.ok) undone++
      byRequest.set(a, got.ok && !back)
    }
    if (undone) return { line: `${plural(undone, 'request')} undone`, tone: 'success' as const }
    return decideDoneLine(r.task.kind, byRequest)
  }
  const finish = useCallback(async () => {
    setReview((r) => {
      if (!r) return r
      const approvedNothing = r.task.kind === 'approve' && approvedCount.current + codeApproved.current.length === 0
      return { ...r, state: { phase: 'done', results: { ...results.current } }, undo: approvedNothing ? null : pendingUndo.current, doneLine: doneLineOf(r, results.current) }
    })
    await after()
  }, [after])

  /** The next request that needs a code, or Done. */
  const nextCode = useCallback(async () => {
    const next = codeQueue.current[0]
    if (!next) { setStepUp(null); await finish(); return }
    setStepUp({ approvalId: next.approvalId, busy: false, error: null, sentence: 'This request takes the code from your authenticator app.' })
  }, [finish])

  const save = useCallback(async () => {
    if (!review || review.state.phase !== 'ready') return
    const task = review.task
    const ids = review.changes.map((c) => c.id)
    setReview({ ...review, state: { phase: 'saving' } })
    const put = (id: string, r: ReviewResult) => { results.current[id] = r }

    if (task.kind === 'skip' || task.kind === 'unskip') {
      const pieces = await inPieces(ids, SKIP_MAX, (piece) => (task.kind === 'skip' ? skipTerms(piece, task.days) : unskipTerms(piece)))
      const failed = pieces.filter((p) => !p.out.ok)
      for (const p of failed) for (const id of p.piece) put(id, { ok: false, words: p.out.ok ? '' : p.out.words })
      {
        const refused = new Map(pieces.flatMap((p) => (p.out.ok ? p.out.data.refused.map((r) => [r.id, r.why] as const) : [])))
        const sent = new Set(pieces.filter((p) => p.out.ok).flatMap((p) => p.piece))
        for (const id of ids) if (sent.has(id)) put(id, refused.has(id) ? { ok: false, words: `Not done: ${refused.get(id)}` } : { ok: true, words: task.kind === 'skip' ? SKIP_WORD(task.days) : 'Shown' })
        const done = ids.filter((id) => sent.has(id) && !refused.has(id))
        if (done.length && task.kind === 'skip') {
          pendingUndo.current = async () => {
            const back = await unskipTerms(done)
            return Object.fromEntries(done.map((id) => [id, back.ok && back.data.ids.includes(id) ? { ok: true, words: 'Undone: shown again' } : { ok: false, words: back.ok ? 'Not undone' : back.words, verb: 'undone' }]))
          }
        } else if (done.length && task.kind === 'unskip') {
          const until = new Map(task.rows.map((r) => [r.id, r.skipped?.until ?? null]))
          pendingUndo.current = async () => {
            const groups = new Map<SkipDays, string[]>()
            for (const id of done) { const d = reskipDays(until.get(id) ?? null); groups.set(d, [...(groups.get(d) ?? []), id]) }
            const back: Results = {}
            for (const [days, list] of groups) {
              const out2 = await skipTerms(list, days)
              for (const id of list) back[id] = out2.ok && out2.data.ids.includes(id) ? { ok: true, words: `Undone: ${SKIP_WORD(days).toLowerCase()}` } : { ok: false, words: out2.ok ? 'Not undone' : out2.words, verb: 'undone' }
            }
            return back
          }
        }
      }
      await finish()
      return
    }

    if (task.kind === 'approve' || task.kind === 'reject') {
      // One decision per request; its result reads on every row (write) of that request.
      const rowsOf = (approvalId: string) => review.changes.filter((c) => (c as { approvalId?: string }).approvalId === approvalId).map((c) => c.id)
      const putRequest = (approvalId: string, r: ReviewResult) => { for (const id of rowsOf(approvalId)) put(id, r) }
      // ≤ 200 decisions a call (R6): every piece is sent, its answers read the same way.
      const pieces = await inPieces(requestIds(task.rows).map((approvalId) => ({ approvalId, decide: task.kind })), DECIDE_MAX, (piece) => decideWaiting(piece))
      const approved: string[] = []
      // A harvest rule's ask is applied by its rule at once (no undo window): no Undo here for it.
      const ruleAsks = new Set(task.rows.filter((r) => r.waiting?.kind === 'rule-ask').map((r) => r.waiting!.approvalId))
      for (const { piece, out } of pieces) {
        if (!out.ok) { for (const d of piece) putRequest(d.approvalId, { ok: false, words: out.words }); continue }
        for (const r of out.data.results) {
          if (r.ok) {
            putRequest(r.approvalId, { ok: true, words: task.kind === 'reject' ? 'Rejected' : r.status === 'applied' ? 'Applied' : approvedWords(r.executeAfter) })
            if (task.kind === 'approve' && !ruleAsks.has(r.approvalId)) approved.push(r.approvalId)
          }
          else if (r.code && CODE_NEEDED.has(r.code)) codeQueue.current.push({ approvalId: r.approvalId, decide: task.kind, changeIds: rowsOf(r.approvalId) })
          else putRequest(r.approvalId, { ok: false, words: r.error ?? 'Not decided' })
        }
      }
      const undoApprovals = (list: readonly string[]): UndoFn => async () => {
        const back: Results = {}
        for (const a of list) {
          const o = await takeBackApproval(a)
          for (const id of rowsOf(a)) back[id] = o.ok ? { ok: true, words: 'Undone: waits for you again' } : { ok: false, words: o.words, verb: 'undone' }
        }
        return back
      }
      // Undo only when something was approved (Low): a decision that approved nothing offers none.
      approvedCount.current = approved.length
      if (task.kind === 'approve') pendingUndo.current = () => undoApprovals([...approved, ...codeApproved.current])()
      await nextCode()
      return
    }

    // Undo harvest: one request per ≤ 200 harvests (R6; the route's cap), each approved in the same click.
    const pieces = await inPieces(ids, UNDO_MAX, (piece) => undoHarvests({ harvestIds: piece, approve: true }))
    const taken: Array<{ changeSetId: string; ids: string[] }> = []
    for (const { piece, out } of pieces) {
      if (!out.ok) { for (const id of piece) put(id, { ok: false, words: out.words, verb: 'undone' }); continue }
      const a = out.data.approve
      if (a?.ok) {
        for (const id of piece) put(id, { ok: true, words: approvedWords(out.data.executeAfter), verb: 'undone' })
        taken.push({ changeSetId: out.data.changeSetId, ids: piece })
      } else if (a?.code && CODE_NEEDED.has(a.code)) codeQueue.current.push({ approvalId: out.data.changeSetId, decide: 'approve', changeIds: piece })
      else for (const id of piece) put(id, { ok: false, words: `Asked, not approved: ${a?.error ?? 'it waits for you'}`, verb: 'undone' })
    }
    if (taken.length) {
      pendingUndo.current = async () => {
        const back: Results = {}
        for (const t of taken) {
          const o = await takeBackApproval(t.changeSetId)
          for (const id of t.ids) back[id] = o.ok ? { ok: true, words: 'Undone: the harvest stays' } : { ok: false, words: o.words, verb: 'undone' }
        }
        return back
      }
    }
    await nextCode()
  }, [review, finish, nextCode])

  const submitCode = useCallback(async (code: string) => {
    const next = codeQueue.current[0]
    if (!next || !stepUp) return
    setStepUp({ ...stepUp, busy: true, error: null })
    const out = await decideWaiting([{ approvalId: next.approvalId, decide: next.decide, code }])
    const r = out.ok ? out.data.results[0] : null
    if (!r?.ok && (!out.ok || (r?.code && CODE_NEEDED.has(r.code)) || r?.code === 'mfa_locked')) {
      // A wrong code keeps the dialog with the server's words; too many tries end it.
      if (r?.code === 'mfa_locked') {
        for (const id of next.changeIds) results.current[id] = { ok: false, words: r.error ?? 'Too many tries' }
        codeQueue.current.shift()
        await nextCode()
        return
      }
      setStepUp({ ...stepUp, busy: false, error: out.ok ? r?.error ?? 'Not approved' : out.words })
      return
    }
    for (const id of next.changeIds) {
      results.current[id] = r?.ok ? { ok: true, words: approvedWords(r.executeAfter), ...(review?.task.kind === 'undo' ? { verb: 'undone' } : {}) } : { ok: false, words: r?.error ?? 'Not approved' }
    }
    if (r?.ok) {
      codeApproved.current.push(next.approvalId)
      if (review?.task.kind === 'undo') {
        const changeSetId = next.approvalId
        const ids = next.changeIds
        // Added to the take-backs of the pieces approved without a code (R6: an undo can be several requests).
        const before = pendingUndo.current
        pendingUndo.current = async () => {
          const earlier = before ? await before() : {}
          const o = await takeBackApproval(changeSetId)
          return { ...earlier, ...Object.fromEntries(ids.map((id) => [id, o.ok ? { ok: true, words: 'Undone: the harvest stays' } : { ok: false, words: o.words, verb: 'undone' }])) }
        }
      }
    }
    codeQueue.current.shift()
    await nextCode()
  }, [stepUp, nextCode, review])

  /** No code: this request stays waiting (it is not rejected — the term shows "Waiting for you"). */
  const cancelCode = useCallback(async () => {
    const next = codeQueue.current.shift()
    if (next) for (const id of next.changeIds) results.current[id] = { ok: false, words: 'Not approved: it needs your authenticator code' }
    await nextCode()
  }, [nextCode])

  const undoSaved = useCallback(async () => {
    if (!review?.undo || review.undoing) return
    const run = review.undo
    setReview({ ...review, undoing: true })
    const back = await run()
    results.current = { ...results.current, ...back }
    setReview((r) => (r ? { ...r, undoing: false, undo: null, state: { phase: 'done', results: { ...results.current } }, doneLine: doneLineOf(r, results.current) } : r))
    await after()
  }, [review, after])

  const close = useCallback(() => {
    if (review?.state.phase === 'saving') return
    setReview(null)
    setStepUp(null)
    codeQueue.current = []
    codeApproved.current = []
  }, [review])

  return { review, ask, save, close, undoSaved, stepUp, submitCode, cancelCode }
}
