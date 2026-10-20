/**
 * Meta step 17 (write base) — what every change of a Meta ad account is before it is sent: the requests Meta gets, what a
 * person reads before approving (a sentence, from → to lines, counts, warnings, what spends money), the live facts it
 * stands on (read again when it runs) and what it replaced and wrote (for undo). Built from a request and the account's
 * live state, without any call: pure.
 *
 * Unlike Google Ads, Meta has no all-or-nothing request for several objects (a Graph batch runs its parts one by one;
 * facts F1 X6): a change of N objects is N requests, sent in order, each with its own outcome (meta-ads-kit.ts).
 */
import type { MetaStatusKind } from './live-status.js'

/** One request of a change: one object, one POST /<id> with these form fields. */
export interface MetaChangeRequest {
  /** 1-based, in the order Nexus sends them. */
  step: number
  /** What a person reads, e.g. 'Pause campaign "Spring sale" (120000000000001)'. */
  label: string
  kind: MetaStatusKind
  objectId: string
  /** The form fields Meta gets (`status`, …), exactly as sent. */
  params: Record<string, string>
  /**
   * Meta's check (validate_only) for this request: `meta` — asked before it is queued; `none` — Meta documents none for it
   * (ad set and ad updates); `not-yet` — Meta documents one, but Nexus does not use it for this change until a live probe
   * shows Meta honours it (gateway meta-calls.ts META_UPDATE_CHECK_PROVEN: today only a pause is checked).
   */
  check: 'meta' | 'none' | 'not-yet'
  /**
   * It can make the account spend more (a switch-on, a raise): after any earlier request of the same change that did not
   * happen, it is not sent (review fix A1: its "nothing spends yet" may have rested on that request).
   */
  raisesSpend: boolean
  /** Ask Meta for the object back in the same POST (read-after-write is documented for a campaign update only). */
  readBackInPost: boolean
  /** It moves an ad set's daily or lifetime budget (Meta allows 4 an hour per ad set; an undo counts too). */
  budget: boolean
  /** Its undo is a change of the same object (so it meets Meta's per-object limits too); false: it has none (an archive). */
  undoable: boolean
}

export interface MetaChangeDraft {
  /** ONE plain sentence of what it does. */
  summary: string
  /** from → to, as a person reads it (at most 20 lines; the rest is counted in `totals`). */
  changes: Record<string, { from: unknown; to: unknown }>
  totals: Record<string, number>
  /** Sentences a person reads before approving (not about money). */
  warnings: string[]
  /** Why this change can make the account spend more: each a sentence. Empty when it cannot. */
  spendsMoney: string[]
  /** What was asked and needs nothing done (already so): said, not sent. */
  skipped: string[]
  requests: MetaChangeRequest[]
  /** The live facts the change stands on: when they moved, the approved change is not sent. */
  stands: unknown
  /** What it replaces and what it writes, in one shape per tool (AgentChange; undo reads them). */
  before: unknown
  after: unknown
}

export const MAX_CHANGE_LINES = 20

/** A from → to table of at most MAX_CHANGE_LINES lines; the lines left out are counted. */
export function changeLines(lines: Array<[string, unknown, unknown]>): { changes: MetaChangeDraft['changes']; more: number } {
  const changes: MetaChangeDraft['changes'] = {}
  let more = 0
  for (const [label, from, to] of lines) {
    if (Object.keys(changes).length >= MAX_CHANGE_LINES) { more += 1; continue }
    let key = label
    for (let n = 2; key in changes; n++) key = `${label} (${n})`
    changes[key] = { from, to }
  }
  return { changes, more }
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
