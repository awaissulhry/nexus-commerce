import { z } from 'zod'
import { businessDate, currency, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { CHANGE_REASONS, RATE_BASES, RATES_MAX, VERSION_REFUSALS, VERSION_STATES, VERSION_STATUSES } from '@nexus/factory-domain/people/piecerates/rates'
import { PRECONDITION_CODES, SWITCH_STATES } from '@nexus/factory-domain/people/piecerates/switch'

/**
 * Piece rates and the legal switch of piece pay (B-W2b-34; MES-254, MES-255, MES-262; design people.piecerates "Legal
 * switch", "Tiles", "Rate table", pop-ups "New rate version", "Publish rates", "Start piece pay"; c.c. arts. 2100-2101).
 * Every rate (per minute, per piece) is `money.pay`: the API drops it for a caller without the pay grain (HR and the
 * worker hold it) and refuses a body that sends one. No answer holds a figure about one person's work; a worker's name
 * appears only inside one version's record (who it was published to and who has read it: c.c. art. 2101) and in the
 * publish dialog's list of who will receive it. The floor reads only the signed-in worker's own publications.
 */

const version = () => z.number().int().min(1)
const text = (max: number) => z.string().max(max)
const reasonText = z.string().max(500)

const siteView = output({ id: id(), companyId: id(), code: z.string(), name: z.string() })
const refView = output({ id: id(), code: z.string(), name: z.string() })
const readBy = output({ read: z.number().int(), of: z.number().int() })

export const tableView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  code: z.string(),
  name: z.string(),
  /** The style its rates are for; null: the site's general rates. */
  style: refView.nullable(),
  /** The line it is for; null: every line of the site. */
  line: refView.nullable(),
  currency: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  note: z.string().nullable(),
  /** Its style, line and currency stay as they are once a version left DRAFT. */
  fixed: z.boolean(),
  version: z.number().int(),
})

export const versionSummary = output({
  id: id(),
  tableId: id(),
  versionNo: z.number().int(),
  status: z.enum(VERSION_STATUSES),
  /** The rate table's status: "Provisional until …", "Confirmed", "Superseded", with its words. */
  state: z.enum(VERSION_STATES),
  stateWords: z.string(),
  changeReason: z.enum(CHANGE_REASONS),
  changeReasonWords: z.string(),
  changeNote: z.string().nullable(),
  effectiveFrom: businessDate(),
  effectiveTo: businessDate().nullable(),
  provisional: z.boolean(),
  trialEndsOn: businessDate().nullable(),
  /** Pays today. */
  inForceToday: z.boolean(),
  rateCount: z.number().int(),
  /** The first publication to the workers (Europe/Rome day), null while none. */
  publishedOn: businessDate().nullable(),
  /** "Read by n of m": the distinct workers it was published to, and how many acknowledged it. */
  readBy,
  version: z.number().int(),
})

const operationView = output({ id: id(), code: z.string(), name: z.string() })

const rateView = output({
  id: id(),
  operation: operationView,
  sizeBand: z.string(),
  basis: z.enum(RATE_BASES),
  standardMinutes: z.string().nullable(),
  ratePerMinute: money.pay(unitPrice().nullable()),
  ratePerPiece: money.pay(unitPrice()),
  note: z.string().nullable(),
})

const refusalView = output({ code: z.enum(VERSION_REFUSALS), message: z.string() }).nullable()
const actionView = output({ allowed: z.boolean(), refusal: refusalView })

// ---- reads ----------------------------------------------------------------------------------------------------------

export const overviewContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional() }),
  response: {
    200: output({
      today: businessDate(),
      /** False: pay figures are hidden for this role (operations and standard minutes only). */
      payShown: z.boolean(),
      sites: z.array(
        output({
          site: siteView,
          switch: output({ state: z.enum(SWITCH_STATES), onFrom: businessDate().nullable(), offFrom: businessDate().nullable(), missing: z.number().int() }),
          /** What needs HR before the period runs (design "Tiles"; held scans and disputes come with B-W2b-43 and -12). */
          tiles: output({ trialEndingSoon: z.number().int(), trialEnded: z.number().int(), unread: z.number().int(), drafts: z.number().int() }),
        }),
      ),
    }),
  },
})

export const ratesContract = defineContract({
  querystring: input({
    siteId: id(),
    tableId: id().optional(),
    styleId: id().optional(),
    /** CURRENT (default): per table the version in force today, those to come and the drafts; ALL: every version. */
    view: z.enum(['CURRENT', 'ALL']).optional(),
    state: z.enum(VERSION_STATES).optional(),
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
  }),
  response: {
    200: output({
      today: businessDate(),
      payShown: z.boolean(),
      /** Rows grouped by style on the screen: one per rate of the versions shown. */
      rows: z.array(
        output({
          table: output({ id: id(), code: z.string(), name: z.string(), currency: z.string() }),
          style: refView.nullable(),
          line: refView.nullable(),
          rate: rateView,
          version: versionSummary,
        }),
      ),
      complete: z.boolean(),
    }),
  },
})

export const tablesContract = defineContract({
  querystring: input({ siteId: id().optional(), companyId: id().optional(), includeArchived: z.enum(['true', 'false']).optional() }),
  response: { 200: output({ tables: z.array(output({ table: tableView, current: versionSummary.nullable(), next: versionSummary.nullable(), drafts: z.number().int() })) }) },
})

const tableDetail = output({ table: tableView, site: siteView, versions: z.array(versionSummary), canManage: z.boolean() })
export const tableContract = defineContract({ params: input({ tableId: id() }), response: { 200: tableDetail } })

const publicationView = output({
  id: id(),
  status: z.enum(['PUBLISHED', 'WITHDRAWN']),
  line: refView.nullable(),
  onFloor: z.boolean(),
  printed: z.boolean(),
  publishedAt: instant(),
  publishedByName: z.string().nullable(),
  withdrawnAt: instant().nullable(),
  withdrawReason: z.string().nullable(),
  /** AckTracker: each worker it went to (inside this one record), and their reading. */
  workers: z.array(
    output({
      workerId: id(),
      name: z.string(),
      employeeId: id().nullable(),
      read: output({ at: instant(), channel: z.enum(['DEVICE', 'PAPER']) }).nullable(),
    }),
  ),
  readBy,
  version: z.number().int(),
})

const versionDetail = output({
  table: tableView,
  site: siteView,
  version: versionSummary.extend({
    confirmedAt: instant().nullable(),
    confirmedByName: z.string().nullable(),
    supersededAt: instant().nullable(),
    cancelledAt: instant().nullable(),
    cancelReason: z.string().nullable(),
    createdAt: instant(),
    createdByName: z.string().nullable(),
  }),
  rates: z.array(rateView),
  publications: z.array(publicationView),
  /** What may be done now, and why not (in words). */
  actions: output({ edit: actionView, publish: actionView, putInForce: actionView, confirm: actionView, cancel: actionView }),
  payShown: z.boolean(),
  canManage: z.boolean(),
})
export type VersionDetail = z.infer<typeof versionDetail>

export const versionContract = defineContract({ params: input({ versionId: id() }), response: { 200: versionDetail } })

export const publishPreviewContract = defineContract({
  params: input({ versionId: id() }),
  querystring: input({ lineId: id().optional() }),
  response: {
    200: output({
      version: output({ id: id(), versionNo: z.number().int(), status: z.enum(VERSION_STATUSES) }),
      line: refView.nullable(),
      /** Who would receive it: the ACTIVE workers of the site (of the line: those whose home line it is). */
      workers: z.array(output({ workerId: id(), name: z.string(), employeeId: id().nullable(), alreadyTold: z.boolean() })),
      count: z.number().int(),
      newCount: z.number().int(),
      /** Workers with no employee record: they are told, but their reading is recorded only once they are linked. */
      withoutEmployee: z.number().int(),
      refusal: refusalView,
    }),
  },
})

// ---- writes ---------------------------------------------------------------------------------------------------------

const rateInput = input({
  operationId: id(),
  sizeBand: z.string().max(24).nullish(),
  basis: z.enum(RATE_BASES),
  /** SMV_RATE: left out, the operation's standard minutes (Products › Operations). */
  standardMinutes: z.string().max(20).nullish(),
  ratePerMinute: money.pay(unitPrice().nullish()),
  ratePerPiece: money.pay(unitPrice().nullish()),
  note: text(500).nullish(),
})

export const createTableContract = defineContract({
  body: input({ siteId: id(), code: z.string().max(20), name: text(120), styleId: id().nullish(), lineId: id().nullish(), currency: currency().optional(), note: text(500).nullish() }),
  response: { 201: tableDetail, 200: tableDetail },
})

export const updateTableContract = defineContract({
  params: input({ tableId: id() }),
  body: input({ version: version(), name: text(120).optional(), note: text(500).nullish(), styleId: id().nullish(), lineId: id().nullish(), currency: currency().optional() }),
  response: { 200: tableDetail },
})

export const archiveTableContract = defineContract({ params: input({ tableId: id() }), body: input({ version: version() }), response: { 200: tableDetail } })

export const createVersionContract = defineContract({
  params: input({ tableId: id() }),
  body: input({
    changeReason: z.enum(CHANGE_REASONS),
    changeNote: text(500).nullish(),
    effectiveFrom: businessDate(),
    provisional: z.boolean().optional(),
    trialEndsOn: businessDate().nullish(),
    /** LATEST (default): start from the rates of the table's latest version; NONE: empty. `rates` replaces them. */
    copy: z.enum(['LATEST', 'NONE']).optional(),
    rates: z.array(rateInput).max(RATES_MAX).optional(),
  }),
  response: { 201: versionDetail, 200: versionDetail },
})

export const updateVersionContract = defineContract({
  params: input({ versionId: id() }),
  body: input({
    version: version(),
    changeReason: z.enum(CHANGE_REASONS).optional(),
    changeNote: text(500).nullish(),
    effectiveFrom: businessDate().optional(),
    provisional: z.boolean().optional(),
    trialEndsOn: businessDate().nullish(),
  }),
  response: { 200: versionDetail },
})

export const setRatesContract = defineContract({
  params: input({ versionId: id() }),
  body: input({ version: version(), rates: z.array(rateInput).max(RATES_MAX) }),
  response: { 200: versionDetail },
})

export const cancelVersionContract = defineContract({ params: input({ versionId: id() }), body: input({ version: version(), reason: reasonText }), response: { 200: versionDetail } })

export const publishContract = defineContract({
  params: input({ versionId: id() }),
  body: input({
    version: version(),
    /** The line it is published on (its workers by home line); null: the site's. */
    lineId: id().nullish(),
    /** The floor sign-ins it goes to; left out: every ACTIVE worker of the site (of the line) not told yet. */
    workerIds: z.array(id()).min(1).max(1000).optional(),
    onFloor: z.boolean().optional(),
    printed: z.boolean().optional(),
    /** A DRAFT is put in force in the same step (default true). */
    putInForce: z.boolean().optional(),
  }),
  response: { 201: versionDetail, 200: versionDetail },
})

export const putInForceContract = defineContract({ params: input({ versionId: id() }), body: input({ version: version() }), response: { 200: versionDetail } })

export const confirmContract = defineContract({ params: input({ versionId: id() }), body: input({ version: version() }), response: { 200: versionDetail } })

export const confirmManyContract = defineContract({
  body: input({ items: z.array(input({ id: id(), version: version() })).min(1).max(200) }),
  response: {
    200: output({
      confirmed: z.array(output({ id: id(), versionNo: z.number().int(), tableId: id() })),
    }),
  },
})

export const confirmPreviewContract = defineContract({
  body: input({ ids: z.array(id()).min(1).max(200) }),
  response: {
    200: output({
      rows: z.array(
        output({
          id: id(),
          table: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
          versionNo: z.number().int().nullable(),
          from: z.string().nullable(),
          to: z.literal('CONFIRMED'),
          trialEndsOn: businessDate().nullable(),
          refusal: refusalView,
          version: z.number().int().nullable(),
        }),
      ),
      canConfirm: z.number().int(),
    }),
  },
})

export const withdrawContract = defineContract({ params: input({ publicationId: id() }), body: input({ version: version(), reason: reasonText }), response: { 200: versionDetail } })

export const paperReceiptsContract = defineContract({
  params: input({ publicationId: id() }),
  body: input({ workerIds: z.array(id()).min(1).max(1000), paperFileId: id().nullish() }),
  response: { 200: versionDetail.extend({ recorded: z.number().int(), already: z.number().int() }) },
})

// ---- the legal switch -------------------------------------------------------------------------------------------------

const schemeView = output({ id: id(), name: z.string(), kind: z.string(), status: z.string(), validFrom: businessDate(), validTo: businessDate().nullable(), lineId: id().nullable() })
const noticeView = output({ id: id(), label: z.string(), status: z.string() })
const dpiaView = output({ id: id(), versionNo: z.number().int(), status: z.string() })

const switchView = output({
  site: siteView,
  today: businessDate(),
  state: z.enum(SWITCH_STATES),
  /** The latest window: from (and who, when), and the first day it no longer counted (and who, when, why). */
  onFrom: businessDate().nullable(),
  switchedOnAt: instant().nullable(),
  switchedOnByName: z.string().nullable(),
  offFrom: businessDate().nullable(),
  switchedOffAt: instant().nullable(),
  switchedOffByName: z.string().nullable(),
  offReason: z.string().nullable(),
  earlierWindows: z.array(output({ from: businessDate(), to: businessDate() })),
  recorded: output({
    ccnlName: z.string().nullable(),
    ccnlArticle: z.string().nullable(),
    workerNotice: noticeView.nullable(),
    dpia: dpiaView.nullable(),
    consultantName: z.string().nullable(),
    consultantAgreedOn: businessDate().nullable(),
    scheme: schemeView.nullable(),
    preconditionsNote: z.string().nullable(),
  }),
  /** The design's LegalGate rows: each precondition, met or not, in words, with its law and the page that keeps it. */
  preconditions: z.array(output({ code: z.enum(PRECONDITION_CODES), met: z.boolean(), law: z.string(), page: z.string().nullable(), words: z.string() })),
  canStart: z.boolean(),
  /** The recorded worker notice: how many of the site's active workers acknowledged it (shown, never a block). */
  noticeReadBy: readBy.nullable(),
  /** What the preconditions may name: the company's worker notices, impact assessments and schemes. */
  candidates: output({ notices: z.array(noticeView), dpias: z.array(dpiaView), schemes: z.array(schemeView) }),
  /** null while the site has no switch row (OFF, nothing recorded). */
  version: z.number().int().nullable(),
  canManage: z.boolean(),
  canSwitch: z.boolean(),
})
export type SwitchView = z.infer<typeof switchView>

const switchParams = input({ siteId: id() })

export const switchContract = defineContract({ params: switchParams, querystring: input({ onFrom: businessDate().optional() }), response: { 200: switchView } })

export const preconditionsContract = defineContract({
  params: switchParams,
  body: input({
    version: version().optional(),
    ccnlName: text(200).nullish(),
    ccnlArticle: text(200).nullish(),
    workerNoticeId: id().nullish(),
    dpiaId: id().nullish(),
    consultantName: text(200).nullish(),
    consultantAgreedOn: businessDate().nullish(),
    schemeId: id().nullish(),
    preconditionsNote: text(2000).nullish(),
  }),
  response: { 200: switchView },
})

const switchResult = switchView.extend({ words: z.array(z.string()) })

export const startContract = defineContract({ params: switchParams, body: input({ version: version(), onFrom: businessDate(), reason: reasonText }), response: { 200: switchResult } })

export const stopContract = defineContract({ params: switchParams, body: input({ version: version(), reason: reasonText }), response: { 200: switchResult } })

// ---- the floor ------------------------------------------------------------------------------------------------------

export const floorMineContract = defineContract({
  response: {
    200: output({
      today: businessDate(),
      /** The publications to the signed-in worker of versions that pay now or later (their own records only). */
      publications: z.array(
        output({
          publicationId: id(),
          versionId: id(),
          versionNo: z.number().int(),
          table: output({ code: z.string(), name: z.string(), currency: z.string() }),
          style: refView.nullable(),
          state: z.enum(VERSION_STATES),
          stateWords: z.string(),
          effectiveFrom: businessDate(),
          effectiveTo: businessDate().nullable(),
          provisional: z.boolean(),
          trialEndsOn: businessDate().nullable(),
          publishedAt: instant(),
          read: output({ at: instant(), channel: z.enum(['DEVICE', 'PAPER']) }).nullable(),
          rates: z.array(output({ operation: output({ code: z.string(), name: z.string() }), sizeBand: z.string(), basis: z.enum(RATE_BASES), standardMinutes: z.string().nullable(), ratePerPiece: money.pay(unitPrice()) })),
        }),
      ),
    }),
  },
})

export const floorReadContract = defineContract({
  params: input({ publicationId: id() }),
  body: input({ clientEventId: z.string().min(8).max(64).optional(), deviceTime: instant().optional() }),
  response: { 200: output({ publicationId: id(), read: output({ at: instant(), channel: z.enum(['DEVICE', 'PAPER']) }), changed: z.boolean() }) },
})
