'use client'

/**
 * Bid page, Bids view — every change on a bid goes through the DS review (ReviewChangesModal): one table Now → New, a
 * counted Save, Done with Undo. This hook holds the review the view shows and saves each kind:
 *
 *   adjust  Change bid, one keyword or many (bulk-bid): Set to ·   Undo: each change through the change feed
 *           Raise / Lower by an amount or a percent, an optional
 *           limit — a form above the table, worked out again on every key (adjustModel.ts)
 *           one rule with Apply (the Owner's decision): whoever sets the bid, it goes; a keyword the brain runs at
 *           Auto goes Manual with it (and back on Undo), a rule / plan / engine row says who may move it next
 *   undo    one change of the History, put back (the change feed)  —
 *   lock    the campaign's bids locked / unlocked (Nexus only)     Undo: the lock as it was
 *   apply   Amazon's suggested bid, one row or many (bulk-bid)     Undo: each change through the change feed
 *           a keyword the brain runs at Auto goes Manual with it (and back on Undo)
 *   mode    Auto / Manual for one keyword                          Undo: the other way
 *   goal    the keyword's own target ACoS / max / top of search   Undo: the values before (the brain's settings)
 *
 * "Now" is read again before Save where the server can say it (one keyword's bid, a lock); the plan words are pure
 * (adjustModel.ts, suggestedModel.ts, goalModel.ts, bidsModel.ts).
 */
import { createElement, useCallback, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/design-system/primitives'
import type { ReviewChange, ReviewResult, ReviewState } from '@/design-system/patterns'
import type { WriteResult } from '../../../_shared/adsWrite'
import { currencySymbol, money, relWords } from '../_shared/format'
import { adjustForm, adjustNothing, adjustPlan, adjustStart, adjustSummary, changeTitle, sendLabel, tableOrder, type AdjustDraft } from './adjustModel'
import { BID_REASON, readCampaignLock, readOneBid, readWhy, saveGoalSetting, sendBids, setBidLock, setKeywordMode, undoChange, type BidReason } from './bidsApi'
import { AUTO_WORDS, modeChangeLine, type BidGridRow } from './bidsModel'
import type { BidAsk } from './BidDetail'
import { ChangeBidForm } from './ChangeBidForm'
import { GOAL_KEYS, GOAL_LABEL, goalBody, goalChanges, goalHeld, goalRaises, goalValueWords, type GoalChange, type InheritedGoal } from './goalModel'
import { applyHeld, applyLabel, applyPlan, applySummary, skipWords, type SuggestedCell } from './suggestedModel'

export interface BidReview {
  ask: BidAsk
  changes: ReviewChange[]
  state: ReviewState
  problems: string[]
  summary: ReactNode
  /** What the Done screen says under its title (the brain's warnings after a goal). */
  doneNote?: ReactNode
  saveLabel: string
  doneVerb: string
  ackLabel: string
  /** Done's Undo: puts the saved values back and says how each went. */
  undo: (() => Promise<Record<string, ReviewResult>>) | null
  undoing: boolean
  /** The dialog's own title ("Change 12 bids"); unset = the review's count. */
  title?: string
  /** Change bid: the form above the table, why Save waits on it, and what it was worked out from. */
  lead?: ReactNode
  leadHeld?: string | null
  adjust?: { rows: BidGridRow[]; draft: AdjustDraft }
}

const ACK = 'I understand automation may change this bid again.'

/** What a write's answer says, for the review's Result column. */
const resultWords = (r: WriteResult): string => (r.ok ? (r.outcome === 'queued' ? 'Sent' : 'Saved') : r.reason ?? 'Not saved')
const where = (r: BidGridRow) => `${r.campaign.name} · ${r.adGroup.name}`
const bidWords = (cents: number | null | undefined, currency: string) => (typeof cents === 'number' ? money(cents, currency) : '—')

/** A line that goes to Amazon: the bid it gets, and whether the brain's keyword goes Manual with it. */
interface SendLine { row: BidGridRow; next: number | null; goesManual: boolean }

/**
 * Send bids now in one bulk call (Apply suggested and Change bid): each result in words; a keyword the brain runs at Auto
 * goes Manual with its bid. Undo puts each change back through the change feed, and a keyword switched to Manual back
 * to Auto.
 */
async function sendLines(lines: readonly SendLine[], reason: BidReason): Promise<{ results: Record<string, ReviewResult>; undo: BidReview['undo'] }> {
  const results: Record<string, ReviewResult> = {}
  const sent = await sendBids(lines.map((l) => ({ targetId: l.row.targetId, bidCents: l.next! })), reason)
  const manual: string[] = []
  for (const s of sent) {
    const line = lines.find((l) => l.row.targetId === s.targetId)
    let words = s.words
    if (s.ok && line?.goesManual && line.row.auto === 'AUTO') {
      const m = await setKeywordMode(s.targetId, 'MANUAL')
      if (m.ok) manual.push(s.targetId)
      else words = `${words} · still Auto: ${m.reason ?? 'not switched'}`
    }
    results[s.targetId] = { ok: s.ok, words }
  }
  const handles = sent.filter((s) => s.ok && s.actionLogId)
  const undo = handles.length ? async () => {
    const back: Record<string, ReviewResult> = {}
    for (const s of handles) {
      const u = await undoChange(s.actionLogId!)
      let words = u.ok ? 'Undone' : u.reason ?? 'Not undone'
      if (u.ok && manual.includes(s.targetId)) {
        const m = await setKeywordMode(s.targetId, 'AUTO')
        if (!m.ok) words = `Undone · still Manual: ${m.reason ?? 'not switched'}`
      }
      back[s.targetId] = { ok: u.ok, words }
    }
    return back
  } : null
  return { results, undo }
}

export function useBidReview({ market, canGoal, cellOf, after, onSetGoal }: {
  market: string | null
  canGoal: boolean
  /** Amazon's suggested bid for a row (the view's read). */
  cellOf: (row: BidGridRow) => SuggestedCell
  /** After a save or an Undo: read the rows again. */
  after: () => Promise<void>
  /** "Set a goal instead": the keyword's Goal tab. */
  onSetGoal: (row: BidGridRow) => void
}) {
  const [review, setReview] = useState<BidReview | null>(null)
  const close = useCallback(() => setReview(null), [])
  const patch = (a: BidAsk, next: Partial<BidReview>) => setReview((v) => (v && v.ask === a ? { ...v, ...next } : v))
  const fail = (a: BidAsk, e: unknown) => patch(a, { state: { phase: 'failed', error: e instanceof Error ? e.message : String(e) } })

  /** "Set a goal instead" (the keyword the brain runs goes Manual otherwise): its Goal tab, when a goal may be set. */
  const goalOffer = (row: BidGridRow) => (goalHeld(row, market, canGoal) ? null
    : createElement(Button, { size: 'xs', variant: 'link', onClick: () => { setReview(null); onSetGoal(row) } }, 'Set a goal instead'))

  /**
   * Change bid's review, worked out from its rows and the form as typed: the table (the bids that change first, each one
   * that stays with why), the counted Send, the form, and why Save waits on it. `locked` while the bids are sent.
   */
  const adjustFields = (rows: BidGridRow[], draft: AdjustDraft, locked = false): Pick<BidReview, 'adjust' | 'title' | 'changes' | 'problems' | 'summary' | 'saveLabel' | 'lead' | 'leadHeld'> => {
    const plan = adjustPlan(rows, draft)
    const single = plan.send.length === 1 ? plan.send[0] : null
    const offer = single?.goesManual ? goalOffer(single.row) : null
    const nothing = adjustNothing(plan)
    return {
      adjust: { rows, draft },
      title: changeTitle(rows.length),
      changes: tableOrder(plan.lines).map((l) => ({ id: l.row.targetId, where: where(l.row), what: l.row.text, now: bidWords(l.now, l.row.currency), next: bidWords(l.next, l.row.currency), note: l.note ?? undefined })),
      problems: nothing ? [nothing] : [],
      summary: createElement('span', null, adjustSummary(plan), offer ? ' ' : null, offer),
      saveLabel: sendLabel(plan.send.length),
      lead: createElement(ChangeBidForm, { form: adjustForm(rows, draft, currencySymbol), draft, locked, onDraft: setDraft }),
      leadHeld: plan.input.held,
    }
  }
  const fieldsRef = useRef(adjustFields)
  fieldsRef.current = adjustFields
  /** A key in the form: the table follows it. Nothing moves while the bids are sent or once they are. */
  const setDraft = useCallback((draft: AdjustDraft) => setReview((v) => (v?.adjust && v.state.phase !== 'saving' && v.state.phase !== 'done'
    ? { ...v, ...fieldsRef.current(v.adjust.rows, draft) } : v)), [])
  /** The review on screen, for Try again: it keeps what was typed. */
  const reviewRef = useRef(review)
  reviewRef.current = review

  const ask = useCallback(async (a: BidAsk) => {
    const r = a.row
    const base = { ask: a, problems: [] as string[], undo: null, undoing: false, ackLabel: ACK, doneNote: undefined }
    // A market Nexus only reads: the controls are held there; a review that opens anyway says why and saves nothing (A1).
    // Apply and Change bid say it per line.
    const blocked = a.kind === 'apply' || a.kind === 'adjust' ? null : r.writeBlock ?? null

    if (a.kind === 'lock') {
      setReview({
        ...base,
        problems: blocked ? [blocked] : [],
        changes: [{ id: r.campaign.id, where: r.campaign.name, what: 'Campaign bids locked', now: a.lock ? 'No' : 'Yes', next: a.lock ? 'Yes' : 'No', raise: !a.lock, note: a.lock ? 'Every bid of this campaign' : undefined }],
        state: { phase: 'reading' },
        summary: 'Nexus only: automation leaves a locked campaign\'s bids. Nothing is sent to Amazon.',
        saveLabel: a.lock ? 'Lock campaign bids' : 'Unlock campaign bids',
        doneVerb: a.lock ? 'locked' : 'unlocked',
        ackLabel: 'I understand automation may change this campaign\'s bids again.',
      })
      try {
        const now = await readCampaignLock(r.campaign, market)
        if (!now) throw new Error('The campaign\'s lock could not be read again.')
        const nowWord = now.bidsLocked ? 'Yes' : 'No'
        setReview((v) => v && v.ask === a ? {
          ...v,
          changes: v.changes.map((c) => ({ ...c, now: nowWord })),
          problems: blocked ? [blocked] : now.bidsLocked === a.lock ? [a.lock ? 'Its bids are locked already.' : 'Its bids are not locked.'] : [],
          state: { phase: 'ready' },
        } : v)
      } catch (e) { fail(a, e) }
      return
    }

    if (a.kind === 'apply') {
      const plan = applyPlan(a.rows, cellOf)
      const left = plan.lines.length - plan.send.length
      const leftWords = left ? ` ${left} left out: ${skipWords(plan.lines)}.` : ''
      const single = plan.send.length === 1 ? plan.send[0] : null
      const offer = single?.goesManual ? goalOffer(single.row) : null
      setReview({
        ...base,
        changes: plan.send.map((l) => ({ id: l.row.targetId, where: where(l.row), what: l.row.text, now: bidWords(l.now, l.row.currency), next: bidWords(l.next, l.row.currency), note: l.note ?? undefined })),
        state: { phase: 'ready' },
        problems: plan.send.length ? [] : [applyHeld(plan) ?? 'Nothing to apply'],
        summary: createElement('span', null, `${applySummary(plan)}${leftWords}`, offer ? ' ' : null, offer),
        saveLabel: applyLabel(plan.send.length),
        doneVerb: 'sent',
      })
      return
    }

    if (a.kind === 'adjust') {
      // One keyword (its detail, or one ticked): "Now" and who sets it are read again first, as a bid always was; many
      // keywords go with the rows the view keeps live.
      const single = a.rows.length === 1
      const kept = reviewRef.current?.ask === a ? reviewRef.current.adjust?.draft : undefined
      setReview({
        ...base,
        ...adjustFields(a.rows, kept ?? adjustStart(a.rows)),
        state: single ? { phase: 'reading' } : { phase: 'ready' },
        doneVerb: 'sent',
      })
      if (!single) return
      try {
        const fresh = await readOneBid(r)
        if (!fresh) throw new Error('This bid could not be read again.')
        const conflicts = typeof fresh.bidNow === 'number' && typeof r.bidNow === 'number' && fresh.bidNow !== r.bidNow
          ? [{ label: 'Bid now', was: money(r.bidNow, r.currency), now: money(fresh.bidNow, r.currency) }]
          : []
        const rows = [{ ...r, bidNow: fresh.bidNow, owner: fresh.owner, auto: fresh.auto ?? r.auto }]
        setReview((v) => (v && v.ask === a && v.adjust ? { ...v, ...adjustFields(rows, v.adjust.draft), state: { phase: 'ready', conflicts } } : v))
      } catch (e) { fail(a, e) }
      return
    }

    if (a.kind === 'mode') {
      const line = modeChangeLine(r, a.next)
      setReview({
        ...base,
        changes: [{ ...line, where: where(r), what: `${r.text} · ${line.what}` }],
        state: { phase: 'ready' },
        problems: blocked ? [blocked] : r.auto === a.next ? [`It is ${a.next === 'AUTO' ? AUTO_WORDS.on : AUTO_WORDS.off} already.`] : [],
        summary: 'Nexus only: who moves this keyword\'s bid. Nothing is sent to Amazon.',
        saveLabel: `Switch to ${a.next === 'AUTO' ? AUTO_WORDS.on : AUTO_WORDS.off}`,
        doneVerb: 'switched',
      })
      return
    }

    if (a.kind === 'goal') {
      const changes = goalChanges(r.goal, a.values)
      const held = goalHeld(r, market, canGoal)
      // A raise is measured against what applies now: the keyword's own value, else the inherited one the brain reads
      // (its Why: the target ACoS it bids to). A max is never a raise (audit R9).
      const lines = (inherited: InheritedGoal) => changes.map((c) => {
        const inh = c.key === 'maxBidCents' ? null : inherited[c.key] ?? null
        return {
          id: c.key, where: r.text, what: GOAL_LABEL[c.key], now: goalValueWords(c.key, c.now, r.currency), next: goalValueWords(c.key, c.next, r.currency),
          note: c.next === null ? 'Its campaign\'s or product\'s value applies' : c.now === null && inh !== null ? `Applies now: ${goalValueWords(c.key, inh, r.currency)} (its campaign's or product's)` : undefined,
          raise: goalRaises(c, inherited),
        }
      })
      const needsInherited = changes.some((c) => c.key === 'targetAcosPct' && r.goal?.acosPct == null)
      setReview({
        ...base,
        changes: lines({}),
        state: needsInherited ? { phase: 'reading' } : { phase: 'ready' },
        problems: blocked ? [blocked] : held ? [held] : changes.length ? [] : ['Nothing changed.'],
        summary: 'Saved in Nexus: the brain follows it from its next run (every 15 min) and never bids above the max. Nothing is sent to Amazon now.',
        saveLabel: 'Save goal',
        doneVerb: 'saved',
        ackLabel: 'I understand the brain may spend more on this keyword.',
      })
      if (needsInherited) {
        const why = await readWhy(r.targetId).catch(() => null)
        const acos = typeof why?.aimPct === 'number' ? why.aimPct : null
        patch(a, { changes: lines({ targetAcosPct: acos }), state: { phase: 'ready' } })
      }
      return
    }

    // One change of the History, put back: "Now" read again.
    const next = a.line.from
    setReview({
      ...base,
      changes: [{ id: r.targetId, where: where(r), what: r.text, now: bidWords(r.bidNow, r.currency), next: bidWords(next, r.currency), note: `Undo · ${relWords(a.line.at)}` }],
      state: { phase: 'reading' },
      problems: blocked ? [blocked] : next == null ? ['The bid before this change is not known.'] : [],
      summary: 'Sends to Amazon now.',
      saveLabel: 'Undo 1 change',
      doneVerb: 'undone',
    })
    try {
      const fresh = await readOneBid(r)
      if (!fresh) throw new Error('This bid could not be read again.')
      const conflicts = typeof fresh.bidNow === 'number' && typeof r.bidNow === 'number' && fresh.bidNow !== r.bidNow
        ? [{ label: 'Bid now', was: money(r.bidNow, r.currency), now: money(fresh.bidNow, r.currency) }]
        : []
      const problems: string[] = []
      if (blocked) problems.push(blocked)
      if (next == null) problems.push('The bid before this change is not known.')
      setReview((v) => v && v.ask === a ? {
        ...v,
        changes: v.changes.map((c) => ({ ...c, now: bidWords(fresh.bidNow, r.currency) })),
        problems,
        state: { phase: 'ready', conflicts },
      } : v)
    } catch (e) { fail(a, e) }
  }, [market, canGoal, cellOf, onSetGoal]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    const v = review
    if (!v || v.state.phase !== 'ready' || v.problems.length || v.leadHeld) return
    const a = v.ask
    // Change bid: the form holds still while its bids go, and "Saving…" counts nothing (its table holds the bids that stay).
    setReview({ ...v, ...(v.adjust ? adjustFields(v.adjust.rows, v.adjust.draft, true) : {}), state: v.adjust ? { phase: 'saving' } : { phase: 'saving', done: 0 } })
    let results: Record<string, ReviewResult> = {}
    let undo: BidReview['undo'] = null
    let doneNote: ReactNode | undefined
    // Change bid's Done table lists the bids that went, not the ones that stayed.
    let doneChanges: ReviewChange[] | null = null

    if (a.kind === 'undo' || a.kind === 'lock') {
      const out = a.kind === 'undo' ? (a.line.undo.kind === 'undo' ? await undoChange(a.line.undo.changeId) : { ok: false, outcome: 'refused' as const, reason: a.line.undo.reason })
        : await setBidLock(a.row.campaign.id, a.lock)
      const id = v.changes[0]?.id ?? 'change'
      results[id] = { ok: out.ok, words: a.kind === 'undo' && out.ok ? 'Undone' : resultWords(out) }
      if (out.ok && a.kind === 'lock') {
        undo = async () => {
          const back = await setBidLock(a.row.campaign.id, !a.lock)
          return { [id]: { ok: back.ok, words: back.ok ? 'Undone' : back.reason ?? 'Not undone' } }
        }
      }
    } else if (a.kind === 'apply') {
      const out = await sendLines(applyPlan(a.rows, cellOf).send, BID_REASON.suggested)
      results = out.results
      undo = out.undo
    } else if (a.kind === 'adjust' && v.adjust) {
      const out = await sendLines(adjustPlan(v.adjust.rows, v.adjust.draft).send, BID_REASON.change)
      results = out.results
      undo = out.undo
      doneChanges = v.changes.filter((c) => c.id in results)
    } else if (a.kind === 'mode') {
      const out = await setKeywordMode(a.row.targetId, a.next)
      const word = a.next === 'AUTO' ? AUTO_WORDS.on : AUTO_WORDS.off
      results[a.row.targetId] = { ok: out.ok, words: out.ok ? `Switched to ${word}` : out.reason ?? 'Not switched' }
      if (out.ok) {
        const back = a.next === 'AUTO' ? 'MANUAL' : 'AUTO'
        undo = async () => {
          const u = await setKeywordMode(a.row.targetId, back)
          return { [a.row.targetId]: { ok: u.ok, words: u.ok ? 'Undone' : u.reason ?? 'Not undone' } }
        }
      }
    } else if (a.kind === 'goal') {
      const changes = goalChanges(a.row.goal, a.values)
      const saved: GoalChange[] = []
      const warnings: string[] = []
      let i = 0
      for (const key of GOAL_KEYS) {
        const c = changes.find((x) => x.key === key)
        if (!c) continue
        const body = goalBody(a.row, c, market)
        const out = body ? await saveGoalSetting(body) : { ok: false, words: 'The brain that runs this keyword is not known', warnings: [] }
        results[key] = { ok: out.ok, words: out.words }
        warnings.push(...out.warnings)
        if (out.ok) saved.push(c)
        setReview((cur) => (cur && cur.ask === a ? { ...cur, state: { phase: 'saving', done: ++i } } : cur))
      }
      if (warnings.length) doneNote = [...new Set(warnings)].join(' ')
      if (saved.length) {
        undo = async () => {
          const back: Record<string, ReviewResult> = {}
          for (const c of saved) {
            const body = goalBody(a.row, { key: c.key, next: c.now }, market)
            const out = body ? await saveGoalSetting(body) : { ok: false, words: 'Not undone', warnings: [] }
            back[c.key] = { ok: out.ok, words: out.ok ? 'Undone' : out.words }
          }
          return back
        }
      }
    }

    setReview((cur) => (cur && cur.ask === a ? { ...cur, ...(doneChanges ? { changes: doneChanges } : {}), state: { phase: 'done', results }, undo, doneNote } : cur))
    await after()
  }, [review, market, cellOf, after]) // eslint-disable-line react-hooks/exhaustive-deps

  const undoSaved = useCallback(async () => {
    const v = review
    if (!v?.undo || v.undoing) return
    setReview({ ...v, undoing: true })
    const back = await v.undo()
    setReview((cur) => (cur && cur.ask === v.ask && cur.state.phase === 'done'
      ? { ...cur, undoing: false, undo: null, state: { phase: 'done', results: { ...cur.state.results, ...back } } }
      : cur))
    await after()
  }, [review, after])

  return { review, ask, save, undoSaved, close }
}
