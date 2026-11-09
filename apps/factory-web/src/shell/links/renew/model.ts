import type { EndStateAction } from '@nexus/ui/components/EndState/index'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { LinkState } from '../link-state'

/**
 * "Ask for a new link" (design links.frame sec:ask-new-link; PLT-066; B-W2b-163's `POST /link/renew`): a dead link is
 * not a dead end. Pure, so the tests hold it.
 *
 *  - Offered on a used, expired or unavailable link (the API's one 404 for used, expired, withdrawn or unknown), with
 *    the dead link's own token: the page never asks for an address — a new link only ever goes to the address on file.
 *  - ONE answer whatever the token was (202): "We passed this on. If the link was ours, the sender will write to the
 *    address it was sent to." Pressed once → held "Asked — we passed it on".
 *  - Held by the abuse guard per token and per network: a 429 says when to try again (`retryAfter`); after suspicious
 *    traffic the API asks for a solved challenge first (`challenge`), which the page solves by itself and sends again.
 */

export const RENEW_STATES = ['idle', 'busy', 'checking', 'done', 'wait', 'failed'] as const
export type RenewState = (typeof RENEW_STATES)[number]

export interface LinkRenew {
  readonly state: RenewState
  /** `wait`: when asking is possible again (ISO). */
  readonly waitUntil: string | null
  readonly ask: () => void
}

/** The link states that offer it (design: "Button 'Ask for a new link' on used / expired / unavailable"). */
export const ASKS_FOR_NEW_LINK: ReadonlySet<LinkState> = new Set<LinkState>(['used', 'expired', 'unavailable'])

/** A 429 that asks for a solved challenge first (proof of work, after suspicious traffic). */
export const wantsChallenge = (error: unknown): boolean => isApiError(error) && error.kind === 'rate_limited' && error.issues.some((issue) => issuePath(issue) === 'challenge')

/** What a failed ask means: wait until a time (asked too often), else it did not reach us. */
export function renewFailure(error: unknown, now: Date): { state: 'wait' | 'failed'; waitUntil: string | null } {
  if (isApiError(error) && error.kind === 'rate_limited') {
    const seconds = Number(error.issues.find((issue) => issuePath(issue) === 'retryAfter')?.message)
    // A challenge the page could not solve, or a wait without its time: a minute, then it may ask again.
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 60
    return { state: 'wait', waitUntil: new Date(now.getTime() + wait * 1000).toISOString() }
  }
  return { state: 'failed', waitUntil: null }
}

/** How the button draws: its words (a catalogue key) and why it is held (a key), or null when it acts. */
export function renewButton(renew: Pick<LinkRenew, 'state'>): { label: string; held: string | null; done: string | null; busy: boolean } {
  switch (renew.state) {
    case 'busy':
      return { label: 'ask.label', held: null, done: null, busy: true }
    case 'checking':
      return { label: 'ask.label', held: 'ask.checking', done: null, busy: false }
    case 'done':
      return { label: 'ask.label', held: null, done: 'ask.done', busy: false }
    case 'wait':
      return { label: 'ask.label', held: 'ask.waitHeld', done: null, busy: false }
    case 'failed':
      return { label: 'ask.again', held: null, done: null, busy: false }
    default:
      return { label: 'ask.label', held: null, done: null, busy: false }
  }
}

/** The line under the end: the one answer once asked, the wait, the failure, else where a new link goes. */
export function renewLine(renew: Pick<LinkRenew, 'state'>): string {
  switch (renew.state) {
    case 'done':
      return 'ask.answer'
    case 'wait':
      return 'ask.wait'
    case 'failed':
      return 'ask.failed'
    case 'checking':
      return 'ask.checkingBody'
    default:
      return 'ask.onFile'
  }
}

/**
 * The EndState's part of it: the line under the end and the one action. `say` gives a catalogue key's words (with the
 * wait's time already in them) — the frame's dead states and a task page's own "used" end draw it alike.
 */
export function renewEnd(renew: LinkRenew, say: (key: string) => string): { next: string; action: EndStateAction } {
  const button = renewButton(renew)
  return {
    next: say(renewLine(renew)),
    action: { label: say(button.label), variant: 'primary', onClick: renew.ask, busy: button.busy, heldReason: button.held ? say(button.held) : null, done: button.done ? say(button.done) : null },
  }
}
