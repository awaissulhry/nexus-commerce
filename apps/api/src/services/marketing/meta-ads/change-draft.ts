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
import type { MetaBoostWriteKind, MetaBrandSafetyKind, MetaPageKind, MetaLabelsKind, MetaOptimizeKind, MetaRemoveKind, MetaWebhookKind } from '../../gateway/meta-calls.js'
import type { MetaSignalsKind } from '../../gateway/meta-signals-rules.js'
import type { MetaCatalogKind } from '../../gateway/meta-catalog-rules.js'
import type { MetaChangeResult, MetaRequestVia, MetaWriteTarget } from './write-client.js'

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
   * Step 26 (review A3) — the fields as this preview's plan hash reads them, when they differ from `params`: a creator's
   * partnership ad code is replaced in it (a short code could be reversed from a hash; the request's arguments still carry the
   * code). Default: `params`.
   */
  planParams?: Record<string, string>
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
   * Step 31: an audience (`customaudience`) or the chosen ad account (`adaccount`: its audiences, opt-outs, settings).
   * Step 30: the chosen ad account (`adaccount`: its connected app, its alert subscriptions), the connection's own app
   * (`app`), the chosen Page (step 28's `page`: the app's removal from it).
   */
  objectKind?: 'highdemandperiod' | 'adaccount' | MetaRemoveKind | MetaLabelsKind
    // Step 28 — a new study's portfolio, a study, a Page, a Page video test.
    | MetaOptimizeKind
    // Step 29 — a Meta automated rule.
    | 'adrule'
    // Step 39 — an ad set's targeting, a publisher or content block list (brand safety).
    | MetaBrandSafetyKind
    // Step 31 — one of the chosen ad account's own custom audiences.
    | 'customaudience'
    // Step 36 — a lead form of the chosen Page, a test lead Nexus made on it.
    | MetaPageKind
    // Step 26 — the chosen Instagram account (`iguser`) or a media of it (`igmedia`); the chosen Page on Meta's partnership
    // host is step 28's `page` (set-meta-partnership-access).
    | MetaBoostWriteKind
    // Step 32 — a dataset, its business portfolio, a custom conversion, an event source group, an Instagram account.
    | MetaSignalsKind
    // Step 30 — the connection's own Meta app (its webhook subscriptions).
    | MetaWebhookKind
    // Step 34 — a catalog, product set, item or feed of this business, the portfolio a catalog is made in.
    | MetaCatalogKind
  /** A create on the object's edge (POST /<id>/budget_schedules; step 19: act_<id>/campaigns | adsets, <id>/copies, …; step 29: act_<id>/adrules_library, <rule id>/execute; step 31: an account's audiences, an audience's people or shares). */
  edge?: MetaWriteEdge
  /** DELETE (a budget schedule's); default POST. */
  method?: 'POST' | 'DELETE'
  /** A budget schedule's campaign or ad set; step 34: a feed's catalog. */
  parent?: { kind: 'campaign' | 'adset' | 'catalog'; id: string }
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
  // ── step 36 (lead forms, test leads) ──
  /** Never read back after it is made (a test lead: Nexus keeps Meta's answer, the new id, and never reads a lead). */
  skipReadBack?: true
  /** Meta's codes this request may meet, in plain words (base code → sentence), added to the step's sentence. */
  explain?: Readonly<Record<string, string>>
  // ── step 27 ──
  /** A new ad's check runs Meta's synchronous integrity review with it (synchronous_ad_review, AD-026 … AD-028). */
  adReview?: boolean
  // ── step 30 (webhook and alert subscriptions) ──
  /** Its path, a DELETE's query, PATCH (write-client.ts MetaRequestVia); Meta's answer is all there is. */
  via?: MetaRequestVia
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
