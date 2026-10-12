'use client'

/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — EVERY write of the page goes through the DS review
 * (ReviewChangesModal): one table, a counted Save, then Done with an Undo that says what it does. One hook for both
 * views and the record modal (a review opened from the modal stacks ABOVE it).
 *
 *   change   pause · negative exact / phrase / product (ad group or campaign) · turn on · remove negative · release ·
 *            keep paused until — POST /waste/preview (writes nothing) → Save → POST /waste/apply: ONE change set,
 *            approved by the person who clicks (a step the API says `needsCode` for asks the authenticator code in the DS
 *            StepUpModal; none does since 2026-10-12). Undo: inside the 20 s window the approve is taken back and the request rejected; after it,
 *            the set is undone (undo-change), or one history row (POST /advertising/changes/:id/undo).
 *   skip     Skip 7 d / 30 d, Unskip — Nexus only; Undo is the other one.
 *   decide   Approve / Reject what waits for you — through the Approvals page's path. Undo of an approve: back to
 *            waiting inside its window; a reject does not come back (said, never a silent button).
 *   undo     one row of a History tab.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { EntityPath, type EntityLinkComponent } from '@/design-system/components'
import type { ReviewChange, ReviewResult, ReviewState } from '@/design-system/patterns'
import Link from '@/lib/workspaces/Link'
import { dayWords, relWords } from '../../bid/_shared/format'
import {
  applyWaste, decideWaiting, previewWaste, readWaitingSteps, restoreCard, skipRows, takeBackApproval, undoActionLog, undoChangeSet, unskipRows,
} from './wasteApi'
import {
  ackWords, appliedWords, decideLines, decideSummary, deliveryView, doneLine, historyWord, isAsinText, isFinal, keepWord, landsWord, olderKeep, plural, previewSummary, saveWords,
  shownSteps, stepStateWord, undoWords, unknownAction, verbLabel, type BulkPlan, type DecideLine, type Waiting,
} from './wasteModel'
import type { ApplyAnswer, HistoryItem, PreviewAnswer, PreviewStep, Ref, WaitingSteps, WasteItem } from './wasteTypes'
import styles from '../negatives.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
/** A rule's Ask-me card (`suggestion:<id>`): rejecting it dismisses it, and Undo restores it. */
const CARD = 'suggestion:'
const isCard = (approvalId: string) => approvalId.startsWith(CARD)

/** A row named in a Nexus-only review (skip, unskip): its words and, when known, where it sits. */
export interface AskRow { id: string; text: string; place?: Array<Ref | null> }

export type WasteAsk =
  /** `keepFrom`: each kept-paused row's end before a Keep paused (null = Always): the review's "Now" and its Undo. */
  | { kind: 'change'; items: WasteItem[]; left?: BulkPlan['left']; keepFrom?: Record<string, string | null>; texts?: Record<string, string> }
  | { kind: 'skip'; rows: AskRow[]; days: 7 | 30 }
  | { kind: 'unskip'; rows: AskRow[] }
  | { kind: 'decide'; decide: 'approve' | 'reject'; waits: Waiting[] }
  | { kind: 'undo'; item: HistoryItem }

export interface WasteReview {
  ask: WasteAsk
  title: string
  changes: ReviewChange[]
  state: ReviewState
  problems: string[]
  summary: ReactNode
  saveLabel: string
  doneVerb: string
  ackLabel?: string
  /** Done's Undo: what it does in words, and the call. Null = nothing to undo (`noUndo` says why, when it matters). */
  undoLabel: string | null
  undo: (() => Promise<Record<string, ReviewResult>>) | null
  noUndo: string | null
  undoing: boolean
  preview: PreviewAnswer | null
  /** What apply sends: the ask's items, or their older form when the server does not know KEEP_UNTIL yet. */
  sendItems: WasteItem[] | null
  /** NFIX — a decide review's lines (every step of a request decided whole), for its results and its Undo. */
  lines?: DecideLine[]
}

/** The authenticator code asked on top of the review, when the API says a step needs it (`needsCode`). */
export interface StepUpAsk { busy: boolean; error: string | null; approvalId: string | null }

const pathNode = (items: Array<Ref | null>) => <EntityPath items={items} linkAs={WorkspaceLink} label="Where" />
/** A whole-campaign change ends its path at the campaign and says so (audit M1). */
const campaignWide = (s: PreviewStep, item?: WasteItem) => s.level === 'CAMPAIGN' || (s.level == null && item?.where === 'campaign')
const where = (s: PreviewStep, item?: WasteItem): ReactNode => (campaignWide(s, item)
  ? <span className={styles.inline}>{pathNode([s.place.portfolio, s.place.campaign])}<span className={styles.quietInline}>· whole campaign</span></span>
  : pathNode([s.place.portfolio, s.place.campaign, s.place.adGroup]))
/** A step's words: the row's own words as the table shows them (an auto target by its group: "Close match"), else the
 *  server's; an ASIN in capitals. */
const stepText = (s: PreviewStep, texts?: Record<string, string>) => {
  const t = (texts?.[s.rowId] ?? '').trim() || (s.text ?? '').trim()
  return !t ? 'Auto target' : isAsinText(t) ? t.toUpperCase() : t
}

/** A decide line as the review table shows it: the row's place, or the step's own place as a link. */
const decideChange = (l: DecideLine): ReviewChange => ({
  id: l.id,
  where: l.place ? <EntityPath items={l.place} linkAs={WorkspaceLink} label="Where" />
    : l.whereLink ? (l.whereLink.href ? <Link href={l.whereLink.href} className="nds-entitylink">{l.whereLink.name}</Link> : l.whereLink.name) : undefined,
  what: l.what,
  now: l.now,
  next: l.next,
  note: l.note,
})

/** The decide review's words for what happens after (the request's own path; a rule's card comes back on Undo). */
function decideWords(a: Extract<WasteAsk, { kind: 'decide' }>): string {
  if (a.decide === 'approve') return 'Runs as you after a short window in which you can undo it.'
  return a.waits.every((w) => isCard(w.approvalId)) ? 'Nothing is sent. Undo brings it back to waiting.'
    : a.waits.some((w) => isCard(w.approvalId)) ? 'Nothing is sent. A rule\'s ask can come back to waiting; the others do not.'
      : 'Nothing is sent. A rejected request does not come back.'
}

function previewChanges(steps: readonly PreviewStep[], a: Extract<WasteAsk, { kind: 'change' }>): ReviewChange[] {
  return [
    ...steps.map((s, i) => {
      const item = a.items[i]
      const keep = s.action === 'KEEP_UNTIL'
      return {
        id: `${i}:${s.rowId}`,
        where: where(s, item),
        what: `${verbLabel(s.action, campaignWide(s, item) ? 'campaign' : null)} · ${stepText(s, a.texts)}`,
        now: keep ? keepWord(s.from) : stepStateWord(s.from),
        next: s.refusal ? '—' : keep ? keepWord(s.to) : stepStateWord(s.to),
        note: landsWord(s),
        raise: !s.refusal && (s.raise || isFinal(s)),
      }
    }),
    ...(a.left ?? []).map((l) => ({ id: `left:${l.id}`, what: l.text, now: '—', next: '—', note: `Left out: ${l.why}` })),
  ]
}

export function useWasteReview({ market, after }: { market: string | null; after: () => Promise<void> | void }) {
  const [review, setReview] = useState<WasteReview | null>(null)
  const [stepUp, setStepUp] = useState<StepUpAsk | null>(null)
  const close = useCallback(() => { setReview(null); setStepUp(null) }, [])
  const patch = (a: WasteAsk, next: Partial<WasteReview>) => setReview((v) => (v && v.ask === a ? { ...v, ...next } : v))

  /** Read the preview again: a moved row is said once, as a conflict, and the table shows today's steps. */
  const runPreview = useCallback(async (a: Extract<WasteAsk, { kind: 'change' }>, moved: boolean) => {
    try {
      let sendItems = a.items
      let legacy = false
      let p: PreviewAnswer
      try {
        p = await previewWaste(sendItems)
      } catch (e) {
        if (!a.items.some((i) => i.action === 'KEEP_UNTIL') || !unknownAction(e)) throw e
        sendItems = olderKeep(a.items)
        legacy = true
        p = await previewWaste(sendItems)
      }
      const steps = shownSteps(p, a, legacy)
      const sendable = steps.filter((s) => !s.refusal).length
      patch(a, {
        preview: { ...p, steps },
        sendItems,
        changes: previewChanges(steps, a),
        title: `Review ${plural(sendable, 'change')}`,
        summary: previewSummary(steps, market),
        problems: sendable ? [] : ['Nothing to send: every row is left out (each says why).'],
        saveLabel: saveWords(steps),
        ackLabel: ackWords(steps),
        state: { phase: 'ready', conflicts: moved ? [{ label: 'The rows', was: 'as you saw them', now: 'changed since — read again below' }] : undefined },
      })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      patch(a, { summary: `Not read — ${why}`, state: { phase: 'failed', error: `Not read — ${why}.` } })
    }
  }, [market]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * NFIX — every step of each request before it is decided: a change plan is approved (or rejected) whole by the
   * approvals service, so the review lists all its steps — the ones this page does not show too — and says so. Not
   * read: nothing can be decided (the review says why, with Try again).
   */
  const runDecideRead = useCallback(async (a: Extract<WasteAsk, { kind: 'decide' }>) => {
    const ids = [...new Set(a.waits.map((w) => w.approvalId).filter((id) => !isCard(id)))]
    try {
      const read = await Promise.all(ids.map((id) => readWaitingSteps(id)))
      const steps = new Map<string, WaitingSteps | null>(ids.map((id, i) => [id, read[i]]))
      const lines = decideLines(a.waits, steps, a.decide)
      const whole = decideSummary(a.waits, steps, a.decide)
      patch(a, {
        lines,
        changes: lines.map(decideChange),
        title: `Review ${plural(lines.length, 'change')}`,
        summary: whole ? `${whole} ${decideWords(a)}` : decideWords(a),
        // Counted: a request decided whole says how many changes go with it.
        saveLabel: whole ? `${a.decide === 'approve' ? 'Approve' : 'Reject'} ${plural(lines.length, 'change')} together` : `${a.decide === 'approve' ? 'Approve' : 'Reject'} ${a.waits.length}`,
        state: { phase: 'ready' },
      })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      patch(a, { summary: `Not read — ${why}`, state: { phase: 'failed', error: `Every step of the request was not read — ${why}. Nothing was decided.` } })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const ask = useCallback((a: WasteAsk) => {
    setStepUp(null)
    const base = { ask: a, problems: [] as string[], undo: null, undoLabel: null, noUndo: null, undoing: false, preview: null, sendItems: null }
    if (a.kind === 'change') {
      setReview({ ...base, title: `Review ${plural(a.items.length, 'change')}`, changes: [], state: { phase: 'reading' }, summary: 'Reading what each change does…', saveLabel: 'Send', doneVerb: 'sent' })
      void runPreview(a, false)
      return
    }
    if (a.kind === 'skip' || a.kind === 'unskip') {
      const until = a.kind === 'skip' ? dayWords(new Date(Date.now() + a.days * 86_400_000).toISOString()) : null
      setReview({
        ...base,
        title: `Review ${plural(a.rows.length, 'change')}`,
        changes: a.rows.map((r) => ({ id: r.id, where: r.place ? pathNode(r.place) : '—', what: r.text, now: a.kind === 'skip' ? 'Shown' : 'Skipped', next: a.kind === 'skip' ? `Skipped to ${until}` : 'Shown' })),
        state: { phase: 'ready' },
        summary: a.kind === 'skip' ? 'Nexus only: it comes back with fresh numbers.' : 'Nexus only: shown again now.',
        saveLabel: a.kind === 'skip' ? `Skip ${a.rows.length}` : `Unskip ${a.rows.length}`,
        doneVerb: a.kind === 'skip' ? 'skipped' : 'shown',
      })
      return
    }
    if (a.kind === 'decide') {
      const approve = a.decide === 'approve'
      // Every step of each request is read first (a plan is decided whole); a rule's card is one change, shown at once.
      const reading = a.waits.some((w) => !isCard(w.approvalId))
      const lines = reading ? [] : decideLines(a.waits, new Map(), a.decide)
      setReview({
        ...base,
        lines,
        title: `Review ${plural(reading ? a.waits.length : lines.length, 'change')}`,
        changes: lines.map(decideChange),
        state: reading ? { phase: 'reading' } : { phase: 'ready' },
        summary: reading ? 'Reading every step of each request…' : decideWords(a),
        saveLabel: `${approve ? 'Approve' : 'Reject'} ${a.waits.length}`,
        doneVerb: approve ? 'approved' : 'rejected',
      })
      if (reading) void runDecideRead(a)
      return
    }
    const it = a.item
    setReview({
      ...base,
      title: 'Review 1 change',
      changes: [{ id: it.changeId ?? it.changeSetId ?? it.at, what: `${historyWord(it.action)} · ${it.text}`, now: deliveryView(it.delivery).word, next: 'Undone', note: relWords(it.at) }],
      state: { phase: 'ready' },
      summary: it.action === 'negated' ? 'Removes the negative at Amazon (Amazon archives it).' : 'Puts it back at Amazon.',
      problems: it.changeId || it.changeSetId ? [] : [it.undo.why || 'This change has no undo.'],
      saveLabel: 'Undo 1',
      doneVerb: 'undone',
    })
  }, [runPreview, runDecideRead])

  /** The apply and what it did, line by line; the Undo that fits its status. */
  const finishApply = useCallback(async (a: Extract<WasteAsk, { kind: 'change' }>, v: WasteReview, answer: ApplyAnswer) => {
    const steps = v.preview?.steps ?? []
    const results: Record<string, ReviewResult> = {}
    steps.forEach((s, i) => {
      const r = appliedWords(s, answer)
      const verb = s.action === 'KEEP_UNTIL' ? 'kept' : s.lands === 'nexus' ? 'saved' : answer.status === 'queued' ? 'sending' : 'sent'
      results[`${i}:${s.rowId}`] = { ok: r.ok, words: r.words, verb }
    })
    for (const l of a.left ?? []) results[`left:${l.id}`] = { ok: false, words: `Left out: ${l.why}`, verb: 'sent' }
    const sent = steps.filter((s) => !s.refusal)
    const id = answer.changeSetId ?? null
    let undo: WasteReview['undo'] = null
    let noUndo: string | null = null
    const final = sent.some((s) => s.action === 'REMOVE_NEGATIVE')
    const amazon = sent.some((s) => s.lands === 'amazon' || s.lands === 'approval')
    if (final) {
      // Final once it runs (audit M2); in its 20 s window it can still be stopped (audit N2): "Stop it (20 s)" takes the
      // approve back and rejects it, then the button goes and the line says it is final.
      noUndo = null
      if (id && answer.status === 'queued') {
        undo = async () => {
          const back = await takeBackApproval(id)
          const [r] = back.ok ? await decideWaiting([{ approvalId: id, decide: 'reject' }]) : [null]
          const ok = back.ok && !!r?.ok
          return Object.fromEntries(sent.map((s) => [`${steps.indexOf(s)}:${s.rowId}`, { ok, words: ok ? 'Stopped: not sent' : back.error ?? r?.error ?? 'Too late to stop', verb: 'stopped' }]))
        }
        const ms = answer.executeAfter ? Math.max(0, Date.parse(answer.executeAfter) - Date.now()) : 20_000
        window.setTimeout(() => setReview((cur) => (cur && cur.ask === a && cur.state.phase === 'done' && cur.undo && !cur.undoing
          ? { ...cur, undo: null, undoLabel: null, summary: amazon ? 'Removed at Amazon — final' : 'Removed in Nexus — final' }
          : cur)), ms)
      }
    } else if (id && (answer.status === 'queued' || answer.status === 'waiting')) {
      undo = async () => {
        // Inside the window: take the approve back, then reject the request, so it never runs and never lingers.
        const back = answer.status === 'queued' ? await takeBackApproval(id) : { ok: true }
        if (back.ok) {
          const [r] = await decideWaiting([{ approvalId: id, decide: 'reject' }])
          return Object.fromEntries(sent.map((s) => [`${steps.indexOf(s)}:${s.rowId}`, { ok: !!r?.ok, words: r?.ok ? 'Undone: not sent' : r?.error ?? 'Not undone', verb: 'undone' }]))
        }
        // It ran already: undo the whole set.
        const u = await undoChangeSet(id)
        return Object.fromEntries(sent.map((s) => [`${steps.indexOf(s)}:${s.rowId}`, { ok: u.ok, words: u.ok ? 'Undone' : u.error ?? 'Not undone', verb: 'undone' }]))
      }
    } else if (id || answer.status === 'applied') {
      if (id) undo = async () => {
        const u = await undoChangeSet(id)
        return Object.fromEntries(sent.map((s) => [`${steps.indexOf(s)}:${s.rowId}`, { ok: u.ok, words: u.ok ? 'Undone' : u.error ?? 'Not undone', verb: 'undone' }]))
      }
      else noUndo = 'Undo it from the row\'s History'
    }
    patch(a, {
      state: { phase: 'done', results },
      summary: final && answer.status === 'queued' && undo ? `${amazon ? 'Removes at Amazon' : 'Removes in Nexus'} in 20 s — final after that`
        : final && answer.status !== 'waiting' ? (amazon ? 'Removed at Amazon — final' : 'Removed in Nexus — final') : doneLine(steps, answer),
      undo,
      undoLabel: final ? (undo ? 'Stop it (20 s)' : null) : undo ? undoWords(sent.map((s) => s.action), sent.filter((s) => s.action === 'KEEP_UNTIL').map((s) => s.from)) : null,
      noUndo,
    })
    await after()
  }, [after]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyChange = useCallback(async (a: Extract<WasteAsk, { kind: 'change' }>, v: WasteReview, code?: string) => {
    if (!v.preview) return
    patch(a, { state: { phase: 'saving' } })
    const out = await applyWaste(v.preview.planHash, v.sendItems ?? a.items, code)
    if (out.status === 409) {
      setStepUp(null)
      await runPreview(a, true)
      return
    }
    if (out.status !== 200 && out.status !== 202) {
      setStepUp(null)
      // Not the person's fault (audit S12): "Not saved — why", and Try again reads it all again.
      patch(a, { state: { phase: 'failed', error: `Not saved — ${out.body.error ?? `the server answered ${out.status || 'nothing'}`}.` } })
      return
    }
    // A code that was wrong leaves the request waiting: ask again for it (the request is approved, never sent twice).
    if (code !== undefined && out.body.status === 'waiting' && out.body.needsCode && out.body.changeSetId) {
      setStepUp({ busy: false, error: out.body.approve?.error ?? 'The code was not accepted.', approvalId: out.body.changeSetId })
      patch(a, { state: { phase: 'ready' } })
      return
    }
    setStepUp(null)
    await finishApply(a, v, out.body)
  }, [runPreview, finishApply]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    const v = review
    if (!v || v.state.phase !== 'ready' || v.problems.length) return
    const a = v.ask
    if (a.kind === 'change') {
      const needsCode = v.preview?.steps.some((s) => !s.refusal && s.needsCode)
      if (needsCode) { setStepUp({ busy: false, error: null, approvalId: null }); return }
      await applyChange(a, v)
      return
    }
    setReview({ ...v, state: { phase: 'saving' } })
    const results: Record<string, ReviewResult> = {}
    let undo: WasteReview['undo'] = null
    let noUndo: string | null = null
    let undoLabel: string | null = null
    if (a.kind === 'skip') {
      const out = await skipRows(a.rows.map((r) => r.id), { days: a.days })
      for (const r of a.rows) results[r.id] = { ok: out.ok, words: out.ok ? 'Skipped' : out.error ?? 'Not skipped', verb: 'skipped' }
      if (out.ok) {
        undoLabel = `Undo: show ${a.rows.length} again`
        undo = async () => {
          const u = await unskipRows(a.rows.map((r) => r.id))
          return Object.fromEntries(a.rows.map((r) => [r.id, { ok: u.ok, words: u.ok ? 'Undone' : u.error ?? 'Not undone', verb: 'undone' }]))
        }
      }
    } else if (a.kind === 'unskip') {
      const out = await unskipRows(a.rows.map((r) => r.id))
      for (const r of a.rows) results[r.id] = { ok: out.ok, words: out.ok ? 'Shown' : out.error ?? 'Not shown', verb: 'shown' }
      // Its Undo reopens the very skips it ended (the same start, person, end and reason), never a new skip (audit M5).
      const reopen = out.ok && out.undo && !Array.isArray(out.undo) ? out.undo.body.reopen ?? [] : []
      const older = out.ok && Array.isArray(out.undo) ? out.undo : []
      if (reopen.length || older.length) {
        undoLabel = `Undo: skip ${a.rows.length} again`
        undo = async () => {
          const res = reopen.length ? [await skipRows([], { reopen })] : await Promise.all(older.map((b) => skipRows(b.body.ids, { until: b.body.until })))
          const ok = res.every((r) => r.ok)
          return Object.fromEntries(a.rows.map((r) => [r.id, { ok, words: ok ? 'Undone' : res.find((x) => !x.ok)?.error ?? 'Not undone', verb: 'undone' }]))
        }
      }
    } else if (a.kind === 'decide') {
      const out = await decideWaiting(a.waits.map((w) => ({ approvalId: w.approvalId, decide: a.decide })))
      // A request is decided whole: each of its lines (every step of a plan) carries its result.
      const linesOf = (approvalId: string) => { const ids = (v.lines ?? []).filter((l) => l.approvalId === approvalId).map((l) => l.id); return ids.length ? ids : [approvalId] }
      const whole = (v.lines ?? []).some((l) => l.id !== l.approvalId)
      for (const r of out) for (const id of linesOf(r.approvalId)) results[id] = { ok: r.ok, words: r.ok ? (a.decide === 'approve' ? 'Approved' : 'Rejected') : r.error ?? 'Not decided', verb: a.decide === 'approve' ? 'approved' : 'rejected' }
      // Back to waiting: an approve inside its window is taken back; a rejected rule card is restored. A rejected request
      // of any other kind does not come back (said only for those).
      const back = a.decide === 'approve'
        ? out.filter((r) => r.ok && r.executeAfter && !isCard(r.approvalId))
        : out.filter((r) => r.ok && isCard(r.approvalId))
      if (back.length) {
        // The Undo covers each request whole: a plan goes back to waiting with every step.
        undoLabel = whole ? `Undo: ${back.length === 1 ? 'the whole request' : `${back.length} requests, whole,`} back to waiting` : `Undo: back to waiting (${back.length})`
        undo = async () => {
          const res = await Promise.all(back.map((r) => (a.decide === 'approve' ? takeBackApproval(r.approvalId) : restoreCard(r.approvalId.slice(CARD.length)))))
          return Object.fromEntries(back.flatMap((r, i) => linesOf(r.approvalId).map((id) => [id, { ok: res[i].ok, words: res[i].ok ? 'Waiting again' : res[i].error ?? 'Not undone', verb: 'undone' }])))
        }
      } else if (out.some((r) => r.ok)) {
        noUndo = a.decide === 'reject' ? 'A rejected request does not come back' : 'Undo it from the row\'s History'
      }
    } else if (a.kind === 'undo') {
      const it = a.item
      const out = it.changeId ? await undoActionLog(it.changeId) : it.changeSetId ? await undoChangeSet(it.changeSetId) : { ok: false, error: it.undo.why }
      results[v.changes[0]?.id ?? 'change'] = { ok: out.ok, words: out.ok ? 'Undone' : out.error ?? 'Not undone', verb: 'undone' }
    }
    setReview((cur) => (cur && cur.ask === a ? { ...cur, state: { phase: 'done', results }, undo, undoLabel, noUndo } : cur))
    await after()
  }, [review, applyChange, after])

  /** The code from the authenticator: the apply (first time) or the approval left waiting (a code that was wrong). */
  const submitCode = useCallback(async (code: string) => {
    const v = review
    if (!v || v.ask.kind !== 'change' || !stepUp) return
    const a = v.ask
    setStepUp({ ...stepUp, busy: true, error: null })
    if (!stepUp.approvalId) { await applyChange(a, v, code); return }
    const [r] = await decideWaiting([{ approvalId: stepUp.approvalId, decide: 'approve', code }])
    if (!r?.ok) { setStepUp({ ...stepUp, busy: false, error: r?.error ?? 'The code was not accepted.' }); return }
    setStepUp(null)
    await finishApply(a, v, { changeSetId: stepUp.approvalId, status: 'queued', executeAfter: r.executeAfter })
  }, [review, stepUp, applyChange, finishApply])

  const undoSaved = useCallback(async () => {
    const v = review
    if (!v?.undo || v.undoing) return
    setReview({ ...v, undoing: true })
    const back = await v.undo()
    setReview((cur) => (cur && cur.ask === v.ask && cur.state.phase === 'done'
      ? { ...cur, undoing: false, undo: null, undoLabel: null, noUndo: null, summary: undefined, state: { phase: 'done', results: { ...cur.state.results, ...back } } }
      : cur))
    await after()
  }, [review, after])

  const retry = useCallback(() => { if (review) ask(review.ask) }, [review, ask])
  const cancelCode = useCallback(() => {
    setStepUp(null)
    setReview((v) => (v && v.state.phase === 'saving' ? { ...v, state: { phase: 'ready' } } : v))
  }, [])

  return { review, stepUp, ask, save, submitCode, cancelCode, undoSaved, retry, close }
}
