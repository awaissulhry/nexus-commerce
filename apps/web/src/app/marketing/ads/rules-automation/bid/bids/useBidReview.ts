'use client'

/**
 * Bid page, Bids view — every change on a bid goes through the DS review (ReviewChangesModal): one table Now → New, a
 * counted Save, Done with Undo. This hook holds the review the view shows and saves each kind:
 *
 *   bid     a person's bid, sent now (PATCH ad-targets)            Undo: the bid before, sent again
 *           one rule with Apply (the Owner's decision): whoever sets the bid, it goes; a keyword the brain runs at
 *           Auto goes Manual with it (and back on Undo), a rule / plan / engine row says who may move it next
 *   undo    one change of the History, put back (the change feed)  —
 *   lock    the campaign's bids locked / unlocked (Nexus only)     Undo: the lock as it was
 *   apply   Amazon's suggested bid, one row or many (bulk-bid)     Undo: each change through the change feed
 *           a keyword the brain runs at Auto goes Manual with it (and back on Undo)
 *   mode    Auto / Manual for one keyword                          Undo: the other way
 *   goal    the keyword's own target ACoS / max / top of search   Undo: the values before (the brain's settings)
 *
 * "Now" is read again before Save where the server can say it (a bid, a lock); the plan words are pure
 * (suggestedModel.ts, goalModel.ts, bidsModel.ts).
 */
import { createElement, useCallback, useState, type ReactNode } from 'react'
import { Button } from '@/design-system/primitives'
import type { ReviewChange, ReviewResult, ReviewState } from '@/design-system/patterns'
import type { WriteResult } from '../../../_shared/adsWrite'
import { money, relWords } from '../_shared/format'
import { readCampaignLock, readOneBid, readWhy, saveGoalSetting, sendBid, sendBids, setBidLock, setKeywordMode, undoChange } from './bidsApi'
import { AUTO_WORDS, modeChangeLine, type BidGridRow } from './bidsModel'
import type { BidAsk } from './BidDetail'
import { GOAL_KEYS, GOAL_LABEL, goalBody, goalChanges, goalHeld, goalRaises, goalValueWords, type GoalChange, type InheritedGoal } from './goalModel'
import { applyHeld, applyLabel, applyPlan, applySummary, BRAIN_STOPS, movesNext, skipWords, type SuggestedCell } from './suggestedModel'

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
}

const ACK = 'I understand automation may change this bid again.'

/** What a write's answer says, for the review's Result column. */
const resultWords = (r: WriteResult): string => (r.ok ? (r.outcome === 'queued' ? 'Sent' : 'Saved') : r.reason ?? 'Not saved')
const where = (r: BidGridRow) => `${r.campaign.name} · ${r.adGroup.name}`
const bidWords = (cents: number | null | undefined, currency: string) => (typeof cents === 'number' ? money(cents, currency) : '—')

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

  const ask = useCallback(async (a: BidAsk) => {
    const r = a.row
    const base = { ask: a, problems: [] as string[], undo: null, undoing: false, ackLabel: ACK, doneNote: undefined }
    // A market Nexus only reads: the controls are held there; a review that opens anyway says why and saves nothing (A1).
    const blocked = a.kind === 'apply' ? null : r.writeBlock ?? null

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

    // A person's bid, or one change of the History put back: "Now" read again. A bid follows Apply's one rule: who moves
    // it next is said on its line, and a keyword the brain runs at Auto goes Manual with it (A6).
    const next = a.kind === 'bid' ? a.nextCents : a.line.from
    const bidSummary = (row: Pick<BidGridRow, 'owner' | 'auto'>) => {
      const who = a.kind === 'bid' ? movesNext(row) : { note: null, goesManual: false }
      const offer = who.goesManual ? goalOffer(r) : null
      return {
        note: a.kind === 'undo' ? `Undo · ${relWords(a.line.at)}` : who.note ?? undefined,
        summary: who.goesManual ? createElement('span', null, `Sends to Amazon now. ${BRAIN_STOPS}.`, offer ? ' ' : null, offer) : 'Sends to Amazon now.',
      }
    }
    const first = bidSummary(r)
    setReview({
      ...base,
      changes: [{ id: r.targetId, where: where(r), what: r.text, now: bidWords(r.bidNow, r.currency), next: bidWords(next, r.currency), note: first.note }],
      state: { phase: 'reading' },
      problems: blocked ? [blocked] : next == null ? ['The bid before this change is not known.'] : [],
      summary: first.summary,
      saveLabel: a.kind === 'undo' ? 'Undo 1 change' : 'Send 1 bid',
      doneVerb: a.kind === 'undo' ? 'undone' : 'sent',
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
      if (a.kind === 'bid' && fresh.bidNow === a.nextCents) problems.push('That is the bid now.')
      const before = typeof fresh.bidNow === 'number' ? fresh.bidNow : null
      // Who sets it now (read again): its line and the summary follow the fresh owner.
      const now = bidSummary({ owner: fresh.owner, auto: fresh.auto ?? r.auto })
      setReview((v) => v && v.ask === a ? {
        ...v,
        changes: v.changes.map((c) => ({ ...c, now: bidWords(fresh.bidNow, r.currency), note: now.note })),
        summary: now.summary,
        problems,
        state: { phase: 'ready', conflicts },
        undo: a.kind === 'bid' && before !== null ? async () => {
          const back = await sendBid(r.targetId, before)
          return { [r.targetId]: { ok: back.ok, words: back.ok ? 'Undone' : back.reason ?? 'Not undone' } }
        } : null,
      } : v)
    } catch (e) { fail(a, e) }
  }, [market, canGoal, cellOf, onSetGoal]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    const v = review
    if (!v || v.state.phase !== 'ready' || v.problems.length) return
    const a = v.ask
    setReview({ ...v, state: { phase: 'saving', done: 0 } })
    const results: Record<string, ReviewResult> = {}
    let undo: BidReview['undo'] = null
    let doneNote: ReactNode | undefined

    if (a.kind === 'bid' || a.kind === 'undo' || a.kind === 'lock') {
      const out = a.kind === 'bid' ? await sendBid(a.row.targetId, a.nextCents)
        : a.kind === 'undo' ? (a.line.undo.kind === 'undo' ? await undoChange(a.line.undo.changeId) : { ok: false, outcome: 'refused' as const, reason: a.line.undo.reason })
          : await setBidLock(a.row.campaign.id, a.lock)
      const id = v.changes[0]?.id ?? 'change'
      results[id] = { ok: out.ok, words: a.kind === 'undo' && out.ok ? 'Undone' : resultWords(out) }
      // A keyword the brain runs at Auto goes Manual with a person's bid (Apply's rule), and back on Undo.
      const manual = out.ok && a.kind === 'bid' && movesNext(a.row).goesManual && a.row.auto === 'AUTO'
      if (manual) {
        const m = await setKeywordMode(a.row.targetId, 'MANUAL')
        if (!m.ok) results[id] = { ok: true, words: `${results[id].words} · still Auto: ${m.reason ?? 'not switched'}` }
      }
      if (out.ok && a.kind === 'bid' && v.undo) {
        const sendBack = v.undo
        undo = manual ? async () => {
          const back = await sendBack()
          if (back[id]?.ok) {
            const m = await setKeywordMode(a.row.targetId, 'AUTO')
            if (!m.ok) back[id] = { ok: true, words: `Undone · still Manual: ${m.reason ?? 'not switched'}` }
          }
          return back
        } : sendBack
      }
      if (out.ok && a.kind === 'lock') {
        undo = async () => {
          const back = await setBidLock(a.row.campaign.id, !a.lock)
          return { [id]: { ok: back.ok, words: back.ok ? 'Undone' : back.reason ?? 'Not undone' } }
        }
      }
    } else if (a.kind === 'apply') {
      const plan = applyPlan(a.rows, cellOf)
      const sent = await sendBids(plan.send.map((l) => ({ targetId: l.row.targetId, bidCents: l.next! })))
      const manual: string[] = []
      for (const s of sent) {
        const line = plan.send.find((l) => l.row.targetId === s.targetId)
        let words = s.words
        if (s.ok && line?.goesManual && line.row.auto === 'AUTO') {
          const m = await setKeywordMode(s.targetId, 'MANUAL')
          if (m.ok) manual.push(s.targetId)
          else words = `${words} · still Auto: ${m.reason ?? 'not switched'}`
        }
        results[s.targetId] = { ok: s.ok, words }
      }
      const handles = sent.filter((s) => s.ok && s.actionLogId)
      if (handles.length) {
        undo = async () => {
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
        }
      }
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

    setReview((cur) => (cur && cur.ask === a ? { ...cur, state: { phase: 'done', results }, undo, doneNote } : cur))
    await after()
  }, [review, market, cellOf, after])

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
