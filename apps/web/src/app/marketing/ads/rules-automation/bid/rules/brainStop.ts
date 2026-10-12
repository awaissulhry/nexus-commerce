/**
 * Bid page, Rules view — the Brain's "Stop the brain" and "Start again" (Owner 2026-10-12), pure and tested in Node.
 *
 * Stop: POST /api/advertising/automation/brain/kill `{ op: 'kill', lever: 'bids', market }` — the brain's kill switch on its
 * `bids` lever for EVERY product of the market in view (All markets: no market, so every market). That is the narrowest
 * stop of the brain's bid writes there: one lever (its keyword bids), every product, one market. The door runs it at once on
 * the person's click (recorded, undoable); nothing is sent to Amazon by the stop itself — bids stay where they are — and the
 * brain's other levers, a person's own bids and every other engine are as before.
 *
 * Start again: the same door with `op: 'end'` for the stop the row names (`row.stop`: its market, or every market), asked
 * and approved in one click with the approver's authenticator code (the DS StepUpModal): ending a stop lets the brain write
 * bids again, a big door. The code is passed through once and never kept.
 *
 * The page's words only: Brain, Stop, Start again, bids, campaigns. No sentences on the page beyond the confirm's one line.
 */
import { whenWords } from '../_shared/format'
import { brainAskWords, isBrain, plural, worksOn, type BidRuleRow, type BrainStop } from './bidRulesModel'

export type { BrainStop }

/** The brain's lever the Bid page stops: its keyword bids. */
export const BRAIN_STOP_LEVER = 'bids'
export const STOP_WHY = 'Stopped on the Bid page'
export const START_WHY = 'Started again on the Bid page'

/** Why a Stop / Start again cannot be used, in the page's words. */
export const STOP_HELD = {
  security: 'Needs the security permission: starting again takes your authenticator code',
  watching: 'The brain changes no bids here: it only watches',
  stopped: 'Already stopped on all its campaigns: start it again in its market',
  unread: 'Not read: reload the page',
} as const

export type BrainStopAction = 'stop' | 'start'
export interface BrainStopView {
  action: BrainStopAction
  label: string
  variant: 'danger' | 'secondary'
  /** Why it cannot be used now (the button is held with it), or null. */
  held: string | null
  /** Start again: when and where the brain was stopped (on hover and focus). */
  hint: string | null
}

/**
 * Which button the Brain's detail shows, and why it is held. `held`: the page's reason for every brain write (a missing
 * ads automation permission, a market Nexus only reads); `busy`: a Start again approved and waiting to run.
 *   a stop stands      → Start again (also held without the security permission: it takes the code)
 *   no stop            → Stop the brain (held while the brain runs no campaign on Auto here: it changes no bids; and
 *                        while other stops already hold every one of its campaigns — a market's own stop seen from All
 *                        markets, or stops of its products: the mode's "Brain off")
 *   the stop not read  → Stop the brain, held (an older answer, or the read failed: the page cannot say which)
 */
export function brainStopView(row: BidRuleRow, ctx: { held: string | null; canSecurity: boolean; busy?: string | null }): BrainStopView | null {
  if (!isBrain(row)) return null
  const stop = row.stop
  if (stop) {
    return {
      action: 'start', label: 'Start again', variant: 'secondary',
      held: ctx.held ?? ctx.busy ?? (ctx.canSecurity ? null : STOP_HELD.security),
      hint: `Stopped ${whereWords(stop.market)} · ${whenWords(stop.at)}`,
    }
  }
  const held = ctx.held ?? ctx.busy
    ?? (stop === undefined ? STOP_HELD.unread : row.mode.set !== 'AUTO' ? STOP_HELD.watching : allStopped(row) ? STOP_HELD.stopped : null)
  return { action: 'stop', label: 'Stop the brain', variant: 'danger', held, hint: null }
}

/** Other stops hold every campaign it runs on Auto here: the mode's first hold is the API's "Brain off" (HOLDS.brainOff). */
const allStopped = (row: BidRuleRow): boolean => row.mode.heldBy?.kind === 'stopped' && row.mode.heldBy.label === 'Brain off'

/** "in IT" · "in every market". */
function whereWords(market: string | null): string {
  return market && market !== 'all' ? `in ${market}` : 'in every market'
}

export interface StopConfirmWords {
  title: string
  line: string
  cancel: string
  confirm: string
  /** The confirm button's words while it is sent. */
  busy: string
  /** The confirm button's look: a stop is the red one. */
  tone: 'danger' | 'primary'
}

/** The confirm before a stop: its campaigns (the ones it runs on Auto here) and the market in view. */
export function stopConfirmWords(row: BidRuleRow, market: string): StopConfirmWords {
  const n = worksOn(row, 'campaigns').total
  return {
    title: 'Stop the brain?',
    line: `It stops changing bids on its ${plural(n, 'campaign')} ${whereWords(market)} at once. Bids stay where they are.`,
    cancel: 'Keep running',
    confirm: 'Stop now',
    busy: 'Stopping…',
    tone: 'danger',
  }
}

/** The confirm before Start again: the stop's own market (a stop of every market seen from one market says so). */
export function startConfirmWords(row: BidRuleRow, market: string, stop: BrainStop): StopConfirmWords {
  const same = (stop.market ?? 'all') === (market && market !== 'all' ? market : 'all')
  const what = same ? `bids on its ${plural(worksOn(row, 'campaigns').total, 'campaign')} ${whereWords(stop.market)}` : `bids ${whereWords(stop.market)}`
  return {
    title: 'Start the brain again?',
    line: `It changes ${what} again, inside your limits. Next: the code from your authenticator app.`,
    cancel: 'Keep stopped',
    confirm: 'Start again',
    busy: 'Starting…',
    tone: 'primary',
  }
}

/** The code step's words (the DS StepUpModal). */
export function startCodeWords(stop: BrainStop): { title: string; sentence: string; confirm: string } {
  return {
    title: 'Start the brain again',
    sentence: `The brain changes bids ${whereWords(stop.market)} again. Approving it takes the code from your authenticator app.`,
    confirm: 'Start again',
  }
}

// ── the requests ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KillBody {
  op: 'kill' | 'end'
  lever: typeof BRAIN_STOP_LEVER
  why: string
  market?: string
  approve?: true
  code?: string
}

/** Stop: every product's bids in the market in view; All markets names no market (every market). */
export function stopBody(market: string): KillBody {
  return { op: 'kill', lever: BRAIN_STOP_LEVER, why: STOP_WHY, ...(market && market !== 'all' ? { market } : {}) }
}

/** Start again: ends the stop the row names, approved in the same click with the person's code. */
export function startBody(stop: BrainStop, code: string): KillBody {
  return { op: 'end', lever: BRAIN_STOP_LEVER, why: START_WHY, ...(stop.market ? { market: stop.market } : {}), approve: true, code }
}

// ── the answers ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The kill door's answer (advertising-brain.routes.ts `ask`). */
export interface KillAnswer {
  approvalId: string
  status: string
  executeAfter?: string
  needsCode?: boolean
  approve?: { ok: boolean; code?: string; error?: string }
}

export interface StopNotice {
  tone: 'success' | 'info' | 'warning' | 'danger'
  title: string
  body: string | null
}

/** A stop's answer in words: done at once, waiting (it could not run now: the request waits in Approvals), or refused. */
export function stopNotice(out: { ok: true; body: KillAnswer } | { ok: false; words: string }): StopNotice {
  if (!out.ok) return { tone: 'danger', title: 'Not stopped', body: out.words }
  if (out.body.status === 'executed') return { tone: 'success', title: 'Brain stopped', body: 'Bids stay where they are.' }
  return { tone: 'warning', title: 'Waiting for approval', body: out.body.approve?.error ?? 'It did not run now: the request waits in Approvals.' }
}

/** A Start again's answer in words: approved (and when it runs), or refused. A refused code stays in the code step. */
export function startNotice(out: { ok: true; executeAfter?: string | null } | { ok: false; words: string }, now = Date.now()): StopNotice {
  if (!out.ok) return { tone: 'danger', title: 'Not started', body: out.words }
  const later = !!out.executeAfter && Date.parse(out.executeAfter) > now
  return { tone: later ? 'info' : 'success', title: later ? 'Starting again' : 'Brain started again', body: brainAskWords(out, now) }
}

/** While an approved Start again waits to run: the held words of the button, until the page reads again after it. */
export function startingHeld(executeAfter: string | null | undefined, now = Date.now()): string | null {
  return executeAfter && Date.parse(executeAfter) > now ? `Starting: ${brainAskWords({ executeAfter }, now).replace(/^Approved · /, '')}` : null
}
