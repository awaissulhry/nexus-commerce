import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_ANSWER, ORDER_REQUEST_KINDS, REQUEST_STATUSES, VERDICT_CODES, CUTOFF_STATUSES, MAX_CUTOFF_DAYS } from '@nexus/factory-domain/sales/change-requests/rules'
import { MAX_REASON, SALES_ORDER_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { MAX_SIZE_QUANTITY, SALES_LINE_KINDS } from '@nexus/factory-domain/sales/quotes/quotes'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { diffView, extraPiecesView, impactView, workOrderPlanView } from '../orders/daily-contract'
// B-OP-012: what Accept's work orders did in its command, and what waits.
import { followedView } from '../../production/work-order-changes/contract'
// B-SA-042 (P6', R1): Accept runs the change at once; the extra pieces' outcome, the work-order changes it proposed.
import { EXTRA_OUTCOMES, WORK_ORDER_CHANGE_KINDS } from '@nexus/factory-domain/order-apply/rules'
// B-PR-25: the production asks from the portal, the impact before Send.
import { ASK_SAMPLE_KINDS, ASK_VERDICT_CODES, MAX_DESIGN_FILES, MAX_DESIGN_WORDS } from '@nexus/factory-domain/sales/change-requests/rules'
// B-SA-046b: which pieces a design change is for.
import { DESIGN_APPLIES_TO } from '@nexus/factory-domain/sales/change-requests/rules'
// B-SA-046c: an accepted request's follow-up on the customer's face.
import { REQUEST_FOLLOW_UPS } from '@nexus/factory-domain/sales/change-requests/rules'
import { FREEZE_STATES, ORDER_FREEZE_ACTIONS, ORDER_FREEZE_FIELDS } from '@nexus/factory-domain/sales/order-changes/freeze'
import { PRODUCTION_REQUEST_KINDS } from '@nexus/factory-domain/production-brand/kinds'
// B-PR-26: our counter-offer on a request.
import { COUNTER_STATES } from '@nexus/factory-domain/sales/change-requests/counter'
// B-SA-045: the apply plan's steps, states and teams.
import { APPLY_STEP_KINDS, APPLY_STEP_STATES, APPLY_TEAMS, FLOOR_STAGES, OUTCOME_NEEDS } from '@nexus/factory-domain/sales/change-requests/apply-plan'

/**
 * Change and cancel requests from the portal (B-W2b-183; SAL-077, SAL-078; design portal.customer.orders "Ask for a
 * change", "Ask to cancel"; the office's Home › Approvals and the order's Changes tab). Every verdict and state carries its
 * words in Italian and English (`words`). The customer's answers hold no price, no cost and no office person (never who
 * answered); the office's preview of the amendment carries money only with the price grain (W2a's diff).
 */

const words = output({ it: z.string(), en: z.string() })
const day = businessDate()
const named = output({ code: z.string(), name: z.string() })
const issue = output({ path: z.string(), message: z.string() })
const live = output({ events: z.array(z.string()) })
const version = z.number().int().min(1)
const verdict = output({ possible: z.boolean(), code: z.enum(VERDICT_CODES), day: day.nullable(), words })
const address = output({ id: id(), label: z.string() })

const cell = output({
  lineId: id(),
  seq: z.number().int(),
  style: named.nullable(),
  colourway: named.nullable(),
  /** null: the line as a whole (a line cancelled). */
  size: z.string().nullable(),
  /** The pieces when it was asked, and the pieces asked (0: none). */
  before: z.number().int(),
  asked: z.number().int(),
  /** B-PR-27a: the colourway a change asks the line in (another of its style's); null: the line keeps its own. */
  askedColourway: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
})

/**
 * B-W2b-F14: a cancel's fee (SalesSettings.cancelFeePct): the percent and its words, and per line the fee of cancelling it
 * with the total, in minor units of the order's currency — prices, dropped for a reader without the grain. Shown only: no
 * money moves.
 */
export const cancelFee = output({
  /** Percent of each cancelled line's net value (decimal text); null: free. */
  pct: z.string().nullable(),
  words,
  currency: z.string(),
  lines: z.array(output({ lineId: id(), seq: z.number().int(), fee: money.price(z.number().int()) })),
  totalFee: money.price(z.number().int()),
})

// ---- B-PR-25 (production plan §3 "Brand asks, we decide", L4; 08-backend §4.2 "Impact before Send"; review fixes R-09, R-50) ----
/** What the rules say of a production ask now (factory-domain askVerdict), in the customer's words. */
const askVerdictOut = output({ possible: z.boolean(), code: z.enum(ASK_VERDICT_CODES), day: day.nullable(), words })
/** A freeze rule's verdict on a part of the order, as the customer reads it (never the rule). */
const freezeOut = output({ state: z.enum(FREEZE_STATES), words })

/**
 * The impact of an ask (factory-domain sales/change-requests/impact): what is frozen, priced or not (never an amount), the
 * earliest date (a date only: planning's answer read through planning/promise/date-only), what the kind may do to the date.
 * The same shape is kept on the request at Send (OrderChangeRequest.impact: no number anywhere).
 */
export const askImpact = output({
  kind: z.enum(ORDER_REQUEST_KINDS),
  frozen: z.array(
    output({
      field: z.enum(ORDER_FREEZE_FIELDS),
      /** The order line (null: the order as a whole) and its number as text. */
      lineId: id().nullable(),
      line: z.string().nullable(),
      size: z.string().nullable(),
      state: z.enum(ORDER_FREEZE_ACTIONS),
      words,
    }),
  ),
  /** Some part asked cannot change any more (Send refuses it). */
  blocked: z.boolean(),
  /** Priced or not (never an amount). */
  priced: notMoney(z.boolean()),
  /** "A price may apply: we will tell you" — every reader; null: no price applies. */
  pricedWords: notMoney(words.nullable()),
  /** The earliest date, an estimate (null: planning was not asked: the ask names no date and adds no pieces). */
  earliest: output({ date: day.nullable(), partial: z.boolean(), meetsWanted: z.boolean().nullable(), words }).nullable(),
  notes: z.array(words),
  words,
  /**
   * B-SA-046b: a design change: the pieces not started yet, or also the pieces already made (rework may cost), as the customer
   * chose before Send; null on every other kind, and on an impact kept before it.
   */
  appliesTo: z.enum(DESIGN_APPLIES_TO).nullable(),
})
// ---- end B-PR-25

/**
 * B-PR-26: our counter-offer on a request (OrderChangeRequest counter columns; its COUNTER_OFFER approval's status): the date we
 * offer, the fee — a price in minor units of the order's currency, dropped for a reader without the grain (`priced` says that one
 * applies) —, our words, and where it stands (WAITING the customer's answer, AGREED, REFUSED, LAPSED) in the reader's words.
 */
export const counterOut = output({
  approvalRequestId: id(),
  at: instant(),
  date: day.nullable(),
  fee: money.price(z.number().int().nullable()),
  note: z.string().nullable(),
  priced: notMoney(z.boolean()),
  /** "Our counter-offer · 10 Dec · a price applies" (never the amount). */
  offer: words,
  state: z.enum(COUNTER_STATES),
  words,
  /** B-OC-003 (order changes tab R3a): when it lapses — its approval's due time ("lapses 26 Nov"); null: not read. */
  dueAt: instant().nullable(),
})

export const requestFields = {
  id: id(),
  orderId: id(),
  orderNumber: z.string(),
  /** Their purchase order number. */
  customerRef: z.string().nullable(),
  /** B-PR-23: any kind of request on the order (the production asks too), each with its words; the portal asks CHANGE and CANCEL. */
  kind: z.enum(ORDER_REQUEST_KINDS),
  kindWords: words,
  status: z.enum(REQUEST_STATUSES),
  words,
  askedAt: instant(),
  cells: z.array(cell),
  /** A cancel of the whole order (no lines named). */
  wholeOrder: z.boolean(),
  requestedDate: day.nullable(),
  shipTo: address.nullable(),
  reasonCode: z.string().nullable(),
  reasonWords: words.nullable(),
  note: z.string().nullable(),
  /** The office's words (never who answered). */
  answer: z.string().nullable(),
  answeredAt: instant().nullable(),
  withdrawnAt: instant().nullable(),
  /**
   * B-W2b-F14: a waiting cancel's fee as the settings say it now (null: a change, or answered or withdrawn). B-PR-25: null for
   * a customer reader without the price grain (the Production role: no fee, not even the percent).
   */
  cancelFee: cancelFee.nullable(),
  // B-PR-25: the impact the customer saw at Send (null: asked before B-PR-25); a sample round's kind.
  impact: askImpact.nullable(),
  sampleKind: z.enum(ASK_SAMPLE_KINDS).nullable(),
  // B-PR-26: the batch it was asked in (a bulk ask: one customer, one kind; null: asked alone) and our counter-offer (null: none).
  batchId: id().nullable(),
  counter: counterOut.nullable(),
  /** B-SA-046: the files a design change sent (of the order or its lines, shared with the customer; none on any other kind). */
  fileIds: z.array(id()),
  /** B-SA-048: the ask's own message in the order's conversation (null: asked before it, or the conversation was closed). */
  askMessageId: id().nullable(),
  version: z.number().int(),
}

/**
 * The customer's view of a request: `mine` when the person asked it. B-SA-046c: `followUp` — an accepted request CARRYING_OUT while
 * the order's Still to do holds a step of it, DONE once none (null: not accepted). A code only: no step, work order, name or count.
 */
// pp-s s.2 (O3-W1): the customer's request names its order by id and its PO — never the office's series (`orderNumber`, a count
// across every customer). Left out of the PARTNER shape only: the office's shapes keep it (a key left out is stripped).
const partnerRequest = output({ ...requestFields, mine: z.boolean(), followUp: z.enum(REQUEST_FOLLOW_UPS).nullable() }).omit({ orderNumber: true })

const orderParams = input({ orderId: id() })
const requestParams = input({ orderId: id(), requestId: id() })

// ---- the portal --------------------------------------------------------------------------------------------------------------

export const rulesContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      asOf: instant(),
      // pp-s s.2 (O3-W1): the order by id and its PO, no office series.
      order: output({ id: id(), customerRef: z.string().nullable(), status: z.enum(SALES_ORDER_STATUSES), requestedDate: day.nullable(), promiseDate: day.nullable(), currency: z.string(), version: z.number().int() }),
      /** May a change be asked at all; may the whole order be asked to be cancelled. */
      change: verdict,
      cancel: verdict,
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          kind: z.enum(SALES_LINE_KINDS),
          style: named.nullable(),
          colourway: named.nullable(),
          /** The style's sizes in its range's order: the pieces ordered and whether the size may be asked (its SKU active). */
          sizes: z.array(output({ size: z.string(), quantity: z.number().int(), offered: z.boolean() })),
          change: verdict,
          cancel: verdict,
          /** B-W2b-F14: the fee of cancelling this line now (a price; 0 when free). */
          cancelFee: money.price(z.number().int()),
          // B-PR-25: per size, what its customer's freeze rules hold now (the size grid locks a BLOCKED one, marks a priced one);
          // whether the line may ship first (ship what is ready) and take each kind of sample round now.
          frozen: z.array(output({ size: z.string(), freeze: freezeOut })),
          split: askVerdictOut,
          samples: z.array(output({ sampleKind: z.enum(ASK_SAMPLE_KINDS), verdict: askVerdictOut })),
          /** B-PR-27a: the other colourways of the line's style a change may ask it in, each with the sizes it is made in. */
          colourways: z.array(output({ id: id(), code: z.string(), name: z.string(), sizes: z.array(z.string()) })),
          /**
           * B-SA-046d: the line's small picture (its colourway's, else its style's main), through the portal's own walled read and the
           * content wall: only the small preview's address (60 seconds; null until it exists); null: none the customer may see.
           */
          picture: output({ small: output({ url: z.string(), expiresAt: instant() }).nullable() }).nullable(),
        }),
      ),
      /**
       * B-W2b-F14: "Ask to cancel"'s fee before the click: the percent and its words, and the whole order's fee (the lines
       * not closed short); each line's own is on the line.
       */
      // B-PR-25: left out for a reader without the price grain (the Production role reads no fee, not even the percent).
      cancelFee: output({ pct: z.string().nullable(), words, currency: z.string(), wholeOrderFee: money.price(z.number().int()) }).optional(),
      /** The cancel reasons (the CANCEL reason list), and whether one asks for their words. */
      reasons: z.array(output({ code: z.string(), words, needsNote: z.boolean() })),
      /** Their delivery addresses in use (for "Ship-to"). */
      addresses: z.array(address),
      /** SAL-304: a made-to-measure order for a consumer: no right of withdrawal applies (said in the cancel pop-up). */
      noWithdrawal: words.nullable(),
      /** The request that waits (one per order). */
      openRequestId: id().nullable(),
      // B-PR-25: the production asks, each open or not by the customer's limits (RUSH exactly while its urgency switch is on,
      // the others while its list names them: R-50), what the rules say of it now and the one that waits (one per kind).
      asks: z.array(output({ kind: z.enum(PRODUCTION_REQUEST_KINDS), words, open: z.boolean(), verdict: askVerdictOut, waitingRequestId: id().nullable() })),
      /** B-SA-046: the design change — open while the customer's ask-kinds switch lists it; one that waits per order. */
      design: output({ words, open: z.boolean(), verdict: askVerdictOut, waitingRequestId: id().nullable() }),
      /** B-PR-25: what the freeze rules hold of the order's date and delivery address now. */
      frozen: output({ deliveryDate: freezeOut, shipTo: freezeOut }),
      live,
    }),
  },
})

/** B-PR-25: the body of an ask and of its impact read (one body for every kind; each kind refuses the fields it does not take). */
const askBody = input({
  kind: z.enum(ORDER_REQUEST_KINDS),
  /** A change: the pieces wanted per size (0 drops the size). A ship-what-is-ready: the first part, the pieces of each size. */
  cells: z.array(input({ lineId: id(), size: z.string().trim().min(1).max(40), quantity: z.number().int().min(0).max(MAX_SIZE_QUANTITY) })).max(500).optional(),
  /** A change: "We would like it by". A rush: the date it is needed by. A ship-what-is-ready: the first part's date. */
  requestedDate: day.nullable().optional(),
  /** A change: one of their delivery addresses. */
  shipToAddressId: id().nullable().optional(),
  /** A cancel: the lines (none: the whole order). B-SA-046: a design change: the lines it is for (at least one). */
  lineIds: z.array(id()).max(200).optional(),
  /** A cancel: a code of the reasons offered (a pause: one of its list, when one is offered). */
  reasonCode: z.string().trim().min(1).max(40).optional(),
  /** Their words: up to 2000 characters (the rules say it in words); B-SA-046: a design change's up to 4000, required. */
  note: z.string().max(MAX_DESIGN_WORDS).nullable().optional(),
  /** B-SA-046: a design change: up to 10 files of the order or its lines, shared with the customer (uploaded first). */
  fileIds: z.array(id()).max(MAX_DESIGN_FILES).optional(),
  /** B-SA-046b: a design change: the pieces not started yet (left out: the default) or also the pieces already made. */
  appliesTo: z.enum(DESIGN_APPLIES_TO).optional(),
  /** B-PR-25: a sample round: the line the sample is of, and the kind of round. */
  lineId: id().nullable().optional(),
  sampleKind: z.enum(ASK_SAMPLE_KINDS).nullable().optional(),
  /** B-PR-27a: a change: a line in another colourway of its style (its sizes as the cells ask, else as they are). */
  colourways: z.array(input({ lineId: id(), colourwayId: id() })).max(200).optional(),
})

/**
 * B-PR-25: POST …/change-requests/impact — what the ask would do, before Send (the same checks as Send, refused the same way):
 * the impact in the customer's words; a cancel's fee only for a reader with the price grain (else left out: the impact's
 * "A price may apply").
 */
export const impactContract = defineContract({
  params: input({ orderId: id() }),
  body: askBody,
  response: {
    200: output({
      asOf: instant(),
      order: output({ id: id(), customerRef: z.string().nullable() }), // pp-s s.2 (O3-W1): no office series
      impact: askImpact,
      cancelFee: cancelFee.optional(),
    }),
  },
})

export const askContract = defineContract({
  params: orderParams,
  // B-PR-25: every kind (the production asks beside change and cancel), the sample round's line and kind.
  body: askBody,
  response: { 201: output({ request: partnerRequest }) },
})

export const partnerListContract = defineContract({
  params: orderParams,
  response: { 200: output({ asOf: instant(), items: z.array(partnerRequest), live }) },
})

export const withdrawContract = defineContract({ params: requestParams, body: input({ version }), response: { 200: output({ request: partnerRequest }) } })

// ---- the office ---------------------------------------------------------------------------------------------------------------

const officeRequest = output({
  ...requestFields,
  companyId: id(),
  party: output({ id: id(), code: z.string(), name: z.string() }),
  /** The customer's person who asked. */
  askedBy: z.string().nullable(),
  answeredBy: z.string().nullable(),
  /** The amendment an accepted change made. */
  amendment: output({ id: id(), revision: z.number().int() }).nullable(),
  /** The reader may accept or refuse it now (orders.manage over the order, the request OPEN; B-PR-23: a CHANGE or a CANCEL — a production ask is answered in Approvals). */
  mayAnswer: z.boolean(),
})

export const officeListContract = defineContract({
  querystring: input({
    status: z.enum([...REQUEST_STATUSES, 'ALL']).default('OPEN'),
    orderId: id().optional(),
    partyId: id().optional(),
    companyId: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  response: {
    200: output({
      asOf: instant(),
      items: z.array(officeRequest),
      /** Rows in the status asked (and the filters). */
      count: z.number().int(),
      // B-PR-23: COUNTERED (our counter-offer waits for the customer).
      counts: output({ OPEN: z.number().int(), ACCEPTED: z.number().int(), REFUSED: z.number().int(), WITHDRAWN: z.number().int(), COUNTERED: z.number().int() }),
      live,
    }),
  },
})

export const officeRecordContract = defineContract({
  params: input({ requestId: id() }),
  response: {
    200: output({
      asOf: instant(),
      request: officeRequest,
      /** What the cut-off rules say of each line now (the customer saw them when asking). */
      rulesNow: z.array(output({ lineId: id(), seq: z.number().int(), change: verdict, cancel: verdict })),
      /**
       * What accepting would do, for a reader who may answer an OPEN request: the amendment W2a would make (lines old → new,
       * money by grain, whether the customer must accept again) or its problems in words; the whole order's cancel impact;
       * the lines a partial cancel closes; a problem with the delivery address. Null otherwise.
       */
      preview: output({
        ok: z.boolean(),
        problems: z.array(issue),
        amendment: diffView.nullable(),
        cancel: impactView.nullable(),
        /** A cancel of some lines: what W2a's close of lines closes (the pieces that will not be made or shipped). */
        closes: z.array(output({ lineId: id(), seq: z.number().int(), closedShortQuantity: z.number().int() })).nullable(),
        /** B-SA-042 (R1, Round 4): the pieces already cut beyond the new figures; Accept stays held until their outcome is chosen. */
        workOrders: extraPiecesView,
      }).nullable(),
      live,
    }),
  },
})

const answerBody = { version, answer: z.string().trim().max(MAX_ANSWER).nullable().optional() }

export const acceptContract = defineContract({
  params: input({ requestId: id() }),
  body: input({
    ...answerBody,
    /** The amendment's (or the cancel's) reason, kept with the order; default: the request's own words. */
    reason: z.string().trim().min(1).max(MAX_REASON).optional(),
    /** B-SA-042 (R1): what happens to the pieces already cut beyond the new figures; required when Accept leaves some. */
    extraOutcome: z.enum(EXTRA_OUTCOMES).nullish(),
  }),
  response: {
    200: output({
      request: officeRequest,
      orderCancelled: z.boolean(),
      /** B-W2b-F14: a cancel's fee as it stood when accepted (shown to the customer; no money moves); null: a change. */
      cancelFee: cancelFee.nullable(),
      /**
       * B-PR-27b: ship what is ready — the order ships as ready now, and the first part's date proposed to sales per line (each a
       * re-promise sales accepts), the lines left out with why; null: not a ship-what-is-ready.
       */
      split: output({
        shipComplete: z.boolean(),
        proposals: z.array(output({ id: id(), orderLineId: id(), seq: z.number().int(), sizes: z.array(output({ size: z.string().nullable(), from: day.nullable(), to: day })) })),
        skipped: z.array(output({ orderLineId: id(), seq: z.number().int(), words })),
        words,
      }).nullable(),
      /** B-SA-042: the work-order changes Accept proposed (held for who manages each work order) and the extra pieces it left. */
      workOrders: output({
        proposed: z.array(output({ id: id(), kind: z.enum(WORK_ORDER_CHANGE_KINDS), workOrderId: id().nullable(), number: z.string().nullable() })),
        extra: z.array(output({ workOrderSizeId: id(), salesOrderLineId: id(), size: z.string(), count: z.number().int(), words })),
        extraOutcome: z.enum(EXTRA_OUTCOMES).nullable(),
        /** B-OP-012 (R-17): the changes Accept carried out in its command (the review window never applies them again) and those that wait. */
        applied: followedView.shape.applied,
        waiting: followedView.shape.waiting,
      }),
      /** B-SA-047: the product change requests an accepted design change raised, one per style of the customer's own label. */
      styleChanges: z.array(output({ id: id(), number: z.string(), style: output({ id: id(), code: z.string(), name: z.string() }) })),
    }),
  },
})

export const refuseContract = defineContract({
  params: input({ requestId: id() }),
  body: input({ version, answer: z.string().trim().min(1).max(MAX_ANSWER) }),
  response: { 200: output({ request: officeRequest }) },
})

// ---- the cut-off settings ------------------------------------------------------------------------------------------------------

const cutoffs = output({
  cancelCutoffStatus: z.enum(CUTOFF_STATUSES).nullable(),
  cancelCutoffDays: z.number().int().nullable(),
  changeCutoffStatus: z.enum(CUTOFF_STATUSES).nullable(),
  /** B-W2b-F14: the cancel fee, percent of the cancelled lines' net value (decimal text, 0–100); null: free. */
  cancelFeePct: z.string().nullable(),
})

const settingsAnswer = output({
  /** The company asked (null: the tenant-wide row). */
  companyId: id().nullable(),
  /** Where the rules in force come from: the company's sales settings, the tenant's, or none (no rule). */
  source: z.enum(['COMPANY', 'TENANT', 'NONE']),
  inForce: cutoffs,
  /** The row asked for (the company's, or the tenant's), to save it; null: no sales settings saved there yet. */
  row: output({ id: id(), version: z.number().int(), cutoffs }).nullable(),
  /** B-W2b-F14: the fee in force in words ("Free to cancel", "Fee 15% of the cancelled lines' value"). */
  cancelFeeWords: words,
})

export const settingsContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: settingsAnswer } })

export const saveSettingsContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    version,
    cancelCutoffStatus: z.enum(CUTOFF_STATUSES).nullable(),
    cancelCutoffDays: z.number().int().min(1).max(MAX_CUTOFF_DAYS).nullable(),
    changeCutoffStatus: z.enum(CUTOFF_STATUSES).nullable(),
    /** B-W2b-F14: the cancel fee, percent 0–100 with at most 4 decimals ("15", "12.5"); null: free; left out: unchanged. */
    cancelFeePct: z.string().trim().max(20).nullable().optional(),
  }),
  response: { 200: settingsAnswer },
})

// ── B-SA-045 (sales page plan P5, P6', R1, R8; 13-backend B4a): the review window's apply plan, before and after Accept ──

const stepPerson = output({ id: id(), name: z.string() })

export const applyPlanContract = defineContract({
  params: input({ requestId: id() }),
  response: {
    200: output({
      asOf: instant(),
      request: output({ id: id(), kind: z.enum(ORDER_REQUEST_KINDS), status: z.enum(REQUEST_STATUSES), version: z.number().int(), orderId: id(), orderNumber: z.string() }),
      /** Why there are no steps (refused, withdrawn, a production ask answered in Home › Approvals); null: the steps say it. */
      words: words.nullable(),
      /** "On the floor now" (workorders.view over the order's customer; else null and named in `withheld`): the order's OWN cells. */
      floor: output({
        cells: z.array(
          output({
            lineId: id(),
            seq: z.number().int(),
            /** null: the line as a whole (a cancel or a design change names lines). */
            size: z.string().nullable(),
            ordered: z.number().int(),
            /** The pieces asked (null: a line as a whole). */
            asked: z.number().int().nullable(),
            inWorkOrders: z.number().int(),
            /** null: the step is not counted there (never a made-up 0). */
            cut: z.number().int().nullable(),
            sewn: z.number().int().nullable(),
            packed: z.number().int(),
          }),
        ),
        /** "In work now: 3 bundles at Sewing" — counts only, never a person or a station. */
        inWork: output({ bundles: z.number().int(), stage: z.enum(FLOOR_STAGES).nullable(), words: words.nullable() }),
        /** Work orders of these lines the reader does not reach: counted, never named. */
        workOrdersLeftOut: z.number().int(),
      }).nullable(),
      withheld: z.array(z.enum(['floor'])),
      /** Pieces already cut beyond the new figure, with the three outcomes and what each needs (R1; Round 4: none picked). */
      extra: output({
        pieces: z.array(output({ lineId: id(), seq: z.number().int(), size: z.string(), count: z.number().int(), words })),
        /** The extra pieces counted (the sum of `pieces[].count`), never money. */
        total: notMoney(z.number().int()),
        outcomes: z.array(output({ outcome: z.enum(EXTRA_OUTCOMES), words, needs: z.enum(OUTCOME_NEEDS).nullable(), needsWords: words.nullable(), mayChoose: z.boolean() })),
        /** The outcome Accept recorded (null: none yet, or no extra piece). */
        chosen: z.enum(EXTRA_OUTCOMES).nullable(),
        /** Accept stays held until one is chosen. */
        needsOutcome: z.boolean(),
        words: words.nullable(),
      }),
      /** What happens next, numbered (AMEND first). */
      next: z.array(
        output({
          seq: z.number().int(),
          kind: z.enum(APPLY_STEP_KINDS),
          state: z.enum(APPLY_STEP_STATES),
          team: z.enum(APPLY_TEAMS),
          /** The named person who acts (office only; a work order's supervisor). */
          person: stepPerson.nullable(),
          words,
          why: words.nullable(),
          mayDoNow: z.boolean(),
          /** The record the step is (a work-order change, the amendment, a style change request…); null: none yet. */
          ref: output({ type: z.string(), id: id(), number: z.string().nullable() }).nullable(),
          /** The work order, when the reader reaches it (null: a new one, or one not shown). */
          workOrder: output({ id: id(), number: z.string() }).nullable(),
          cells: z.array(output({ seq: z.number().int(), size: z.string(), from: z.number().int(), to: z.number().int() })),
          extra: z.number().int(),
          /**
           * F-SA-241 (14-change-flow §3.2 item 6): the work order's bundles in work (ACTIVE) on the step's own cells — the window offers
           * "Finish what is started" / "Stop now" for it. null: a new work order, or one the reader does not reach (never counted then).
           */
          bundles: z.number().int().nullable(),
        }),
      ),
      /**
       * B-OP-013 (order page plan N2, D1): before Accept, what each work order will do — in Accept's own command for this reader, or
       * waiting with why; [] once the request is answered (`next` says what was done).
       */
      workOrderPlan: z.array(workOrderPlanView),
      live,
    }),
  },
})
// ── end B-SA-045 ──
