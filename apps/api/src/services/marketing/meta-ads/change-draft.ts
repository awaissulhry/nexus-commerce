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
import type { MetaWriteEdge } from '../../gateway/meta.js'
import type { MetaBrandSafetyKind, MetaLabelsKind, MetaOptimizeKind, MetaRemoveKind } from '../../gateway/meta-calls.js'
import type { MetaChangeResult, MetaWriteTarget } from './write-client.js'

/** One request of a change: one object, one POST /<id> with these form fields. */
export interface MetaChangeRequest {
  /** 1-based, in the order Nexus sends them. */
  step: number
  /** What a person reads, e.g. 'Pause campaign "Spring sale" (120000000000001)'. */
  label: string
  /** A campaign, ad set or ad (step 39: a request of another kind names it in `objectKind` and leaves this out). */
  kind?: MetaStatusKind
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
  // ── step 18: a request past status (all optional; a status change needs none of them) ──
  /** The gateway / ledger operation (default `<kind>.status`). */
  operation?: string
  /** What the read-back must show, field → value as sent (default: `status`). */
  expect?: Record<string, string>
  /** The fields read back (default id,status,effective_status). */
  readBackFields?: string
  /**
   * The object the gateway confirms, when it is not `kind` (a budget schedule: `highdemandperiod`; step 19: a create names
   * the chosen ad account itself, `adaccount`). Step 29: a Meta automated rule (`adrule`) or the ad account's rule
   * library (`adaccount`, a rule's create); `kind` then only types the request (`campaign` by convention).
   * Step 23: an upload names the chosen ad account (`adaccount`) or its business portfolio (step 28's `business`);
   * captions name the library video (step 22's `video`). Its `kind` is then `ad`, as for step 22's deletes.
   */
  objectKind?: 'highdemandperiod' | 'adaccount' | MetaRemoveKind | MetaLabelsKind
    // Step 28 — a new study's portfolio, a study, a Page, a Page video test.
    | MetaOptimizeKind
    // Step 29 — a Meta automated rule.
    | 'adrule'
    // Step 39 — an ad set's targeting, a publisher or content block list (brand safety).
    | MetaBrandSafetyKind
  /** A create on the object's edge (POST /<id>/budget_schedules; step 19: act_<id>/campaigns | adsets, <id>/copies, …; step 29: act_<id>/adrules_library, <rule id>/execute). */
  edge?: MetaWriteEdge
  /** DELETE (a budget schedule's); default POST. */
  method?: 'POST' | 'DELETE'
  /** A budget schedule's campaign or ad set. */
  parent?: { kind: 'campaign' | 'adset'; id: string }
  /** Step 19 — Meta's check of this create asks its setup recommendations too (master CMP-031). */
  recommendations?: boolean
  /**
   * Step 19 (review A4) — a create or a copy: when Meta answers success but the new object reads back otherwise, it is still
   * recorded as made (with what it reads), so its undo can delete it; never "no record" for an object Meta made.
   */
  recordEvenIfNotAsAsked?: boolean
  /**
   * Step 22 — the steps of the same change this request stands on (a creative deleted after the ads that use it, an image
   * after the creatives that use it): when one of them did not happen as asked, it is not sent.
   */
  needs?: number[]
  /**
   * Step 21 — an edge that changes the object itself (labels ADDED to a campaign: POST /<campaign>/adlabels answers
   * {"success": true}): the object is read back, never a new one.
   */
  readBackObject?: true
  // ── step 23: a request that brings its own sender ──
  /**
   * Sends the request itself (an upload whose answer is read again, or Meta's video-ads upload, whose later calls need the
   * first one's answer): the kit runs it as ONE step in place of metaSendChange. It goes only through the write client
   * (the gateway), and rejects with a MetaWriteError exactly like metaSendChange (not_sent, refused, unknown).
   */
  send?: (target: MetaWriteTarget) => Promise<MetaChangeResult>
  /** The step's sentence when Meta made it (else the kit's own). */
  doneSentence?: (result: MetaChangeResult) => string
  // ── step 39 (brand safety) ──
  /** The read-back that judges it (meta write-client `judge`), and what is read (default the object). */
  judge?: (node: Record<string, unknown>) => { moved: string[]; reads: string }
  readBackOf?: string
  /**
   * Params it takes from an earlier request of the same change, just before it is sent (a list made from the draft step 1
   * uploaded): its plan holds the rest. A MetaWriteError it throws ends the run there (nothing more is sent).
   */
  prepare?: (done: ReadonlyArray<{ request: MetaChangeRequest; result: MetaChangeResult }>) => Promise<Record<string, string>>
  /** The capability grant Meta needs for it (D6): Meta refusing it for access answers with the no-grant controls. */
  grant?: string
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
  /** Step 22 — everything a delete takes with it (every ad set and ad of a campaign or ad set, by id), shown in full. */
  alsoDeleted?: unknown
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
