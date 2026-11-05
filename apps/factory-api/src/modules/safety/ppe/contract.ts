import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { PPE_CATEGORIES, PPE_ISSUE_REASONS, PPE_ITEM_STATUSES, PPE_LIMITS, PPE_RECEIPT_METHODS, RECEIPT_STATES } from '@nexus/factory-domain/safety/ppe/rules'
import { leaverOut } from '../../people/leavers/contract'

/**
 * PPE for workers (B-W2b-134; QHS-259, QHS-260, QHS-261; design plant.ppe SCR-211: the tiles, the four lenses Gaps | Issues |
 * Kits per role | Catalogue, the pop-ups Issue PPE, PPE item, Void an issue, the new tabs Receipt (PDF) and Person PPE card;
 * floor.training SCR-231 "Receive PPE"; people.employees › Safety "PPE issued"). The only money is a PPE item's unit cost (the
 * cost grain: dropped from an answer, refused in a request without it); never on the floor. A list names people (a legal
 * register of receipts names the person, art. 77 c.4) but no figure about a person beyond their own PPE.
 */

const L = PPE_LIMITS
const words = (max: number) => z.string().trim().min(1).max(max)
const maybeWords = (max: number) => z.string().trim().max(max)
const version = () => z.number().int().min(1)
const names = z.record(z.string(), z.string()).nullable()
const codeName = output({ code: z.string(), name: z.string() })
const law = output({ issue: z.string(), receipt: z.string(), catalogue: z.string(), categoryIII: z.string() })
const category = z.enum(PPE_CATEGORIES)
const reason = z.enum(PPE_ISSUE_REASONS)
const method = z.enum(PPE_RECEIPT_METHODS)
const receiptState = z.enum(RECEIPT_STATES)
const person = output({ id: id(), name: z.string(), employeeCode: z.string().nullable() })
const placeQuery = { companyId: id().optional(), siteId: id().optional() }

// ---- the catalogue ----------------------------------------------------------------------------------------------------------

export const itemOut = output({
  id: id(),
  companyId: id(),
  company: codeName,
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  category,
  standard: z.string().nullable(),
  sizes: z.array(z.string()),
  /** Replaced after this many months; null: when worn. */
  lifeMonths: z.number().int().nullable(),
  supplier: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  unitCost: money.cost(z.number().int().nullable()),
  status: z.enum(PPE_ITEM_STATUSES),
  note: z.string().nullable(),
  /** ACTIVE role sheets whose kit names it; lines handed over. */
  inKits: z.number().int(),
  issued: z.number().int(),
  version: z.number().int(),
  updatedAt: instant(),
  canManage: z.boolean(),
})

export const listItemsContract = defineContract({
  querystring: input({ companyId: id().optional(), status: z.enum(['ACTIVE', 'ARCHIVED', 'all']).optional(), q: z.string().trim().max(100).optional() }),
  response: { 200: output({ items: z.array(itemOut), complete: z.boolean(), canAdd: z.boolean(), law }) },
})

export const itemRecordContract = defineContract({
  params: input({ ppeItemId: id() }),
  response: { 200: output({ item: itemOut, kits: z.array(output({ roleSheetId: id(), code: z.string(), name: z.string(), site: codeName, quantity: z.number().int(), whenToWear: z.string() })), law }) },
})

const itemFields = {
  name: words(L.name),
  nameI18n: z.record(z.string().regex(/^[a-z]{2,3}$/), maybeWords(L.name)).nullish(),
  category,
  standard: maybeWords(L.standard).nullish(),
  sizes: z.array(z.string().max(L.size)).max(L.sizes).optional(),
  lifeMonths: z.number().int().min(1).max(L.lifeMonths).nullish(),
  supplierPartyId: id().nullish(),
  unitCost: money.cost(z.number().int().min(0).max(L.unitCost).nullish()),
  note: maybeWords(L.note).nullish(),
}

export const createItemContract = defineContract({
  body: input({ companyId: id(), code: words(L.code), ...itemFields }),
  response: { 200: output({ item: itemOut }), 201: output({ item: itemOut }) },
})

export const editItemContract = defineContract({
  params: input({ ppeItemId: id() }),
  body: input({
    version: version(),
    name: words(L.name).optional(),
    nameI18n: itemFields.nameI18n,
    category: category.optional(),
    standard: itemFields.standard,
    sizes: itemFields.sizes,
    lifeMonths: itemFields.lifeMonths,
    supplierPartyId: itemFields.supplierPartyId,
    unitCost: money.cost(z.number().int().min(0).max(L.unitCost).nullish()),
    note: itemFields.note,
  }),
  response: { 200: output({ item: itemOut, changed: z.boolean() }) },
})

export const itemStatusContract = defineContract({
  params: input({ ppeItemId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ item: itemOut }) },
})

export const commonItemsContract = defineContract({
  body: input({ companyId: id(), codes: z.array(z.string().trim().min(1).max(L.code)).max(20).optional() }),
  response: { 200: output({ items: z.array(itemOut), added: z.number().int(), skipped: z.array(z.string()) }) },
})

// ---- gaps, kits, counts, the person -----------------------------------------------------------------------------------------

const gapLineOut = output({
  ppeItemId: id(),
  item: output({ code: z.string(), name: z.string(), nameI18n: names, category: z.string(), sizes: z.array(z.string()), status: z.string() }),
  quantity: z.number().int(),
  held: z.number().int(),
  missing: z.number().int(),
  /** Units in use whose life (lifeMonths) is over. */
  replace: z.number().int(),
  whenToWear: z.string(),
})

const roleRef = output({ id: id(), code: z.string(), name: z.string() }).nullable()

export const gapRowOut = output({
  employee: person,
  companyId: id(),
  siteId: id(),
  site: codeName,
  role: roleRef,
  /** The kit lines the person misses units of (all kit lines with `view=all`). */
  lines: z.array(gapLineOut),
  missing: z.number().int(),
  replace: z.number().int(),
  lastIssueAt: instant().nullable(),
  canIssue: z.boolean(),
})

export const gapsContract = defineContract({
  querystring: input({ ...placeQuery, roleSheetId: id().optional(), view: z.enum(['missing', 'all']).optional(), q: z.string().trim().max(100).optional() }),
  response: { 200: output({ people: z.array(gapRowOut), complete: z.boolean(), withoutRole: z.number().int(), today: z.string(), law }) },
})

export const countsContract = defineContract({
  querystring: input(placeQuery),
  response: {
    200: output({
      /** People missing at least one unit of their role's kit. */
      peopleMissingKit: z.number().int(),
      /** Paper receipts whose signed scan is not on file. */
      receiptsNotSigned: z.number().int(),
      /** People with a unit in use past its life (the design's "Replacements due", Later). */
      replacementsDue: z.number().int(),
      /** PPE stock is not linked to the warehouse yet (the design's "Items below minimum", Later). */
      itemsBelowMinimum: z.null(),
      complete: z.boolean(),
      today: z.string(),
    }),
  },
})

export const kitsContract = defineContract({
  querystring: input(placeQuery),
  response: {
    200: output({
      roles: z.array(output({ id: id(), code: z.string(), name: z.string(), companyId: id(), siteId: id(), site: codeName, people: z.number().int() })),
      items: z.array(output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, category: z.string(), status: z.string() })),
      /** One cell per role and item of its kit. */
      cells: z.array(output({ roleSheetId: id(), ppeItemId: id(), quantity: z.number().int(), whenToWear: z.string() })),
      complete: z.boolean(),
    }),
  },
})

// ---- issues and receipts ----------------------------------------------------------------------------------------------------

const issuedBy = output({ kind: z.enum(['USER', 'WORKER', 'NONE']), name: z.string().nullable(), hidden: z.boolean() })
const deviceRef = output({ id: id(), name: z.string() }).nullable()

export const issueLineOut = output({
  id: id(),
  receiptId: id(),
  issuedAt: instant(),
  companyId: id(),
  siteId: id(),
  site: codeName,
  employee: person,
  item: output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, category: z.string() }),
  size: z.string().nullable(),
  quantity: z.number().int(),
  reason,
  method,
  issuedBy,
  receipt: output({ id: id(), state: receiptState, scanFileId: id().nullable(), documentFileId: id().nullable() }),
  device: deviceRef,
  voided: output({ voidId: id(), at: instant(), reason: z.string().nullable(), by: z.string().nullable() }).nullable(),
  canVoid: z.boolean(),
})

export const receiptOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  site: codeName,
  employee: person,
  issuedAt: instant(),
  method,
  state: receiptState,
  issuedBy,
  signature: output({ workerId: id(), worker: z.string().nullable(), device: deviceRef, sha256: z.string() }).nullable(),
  scan: output({ fileId: id(), name: z.string() }).nullable(),
  document: output({ id: id(), version: z.number().int(), language: z.string(), fileId: id(), createdAt: instant() }).nullable(),
  lines: z.array(issueLineOut),
  /** Units handed over, voided lines aside. */
  units: z.number().int(),
  canIssue: z.boolean(),
})

export const listIssuesContract = defineContract({
  querystring: input({
    ...placeQuery,
    employeeId: id().optional(),
    ppeItemId: id().optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    view: z.enum(['all', 'notSigned', 'voided']).optional(),
    limit: z.coerce.number().int().min(1).max(L.list).optional(),
  }),
  response: { 200: output({ issues: z.array(issueLineOut), complete: z.boolean(), law }) },
})

export const receiptRecordContract = defineContract({
  params: input({ receiptId: id() }),
  response: { 200: output({ receipt: receiptOut, statement: z.string().nullable(), verified: z.boolean(), law }) },
})

const linesIn = z
  .array(input({ ppeItemId: id(), size: z.string().trim().max(L.size).nullish(), quantity: z.number().int().min(1).max(L.quantity), reason }))
  .min(1)
  .max(L.lines)

export const issuePaperContract = defineContract({
  body: input({
    employeeId: id(),
    lines: linesIn,
    /** When the person signed the paper (default: now); never in the future, within PPE_LIMITS.lateDays. */
    issuedAt: instant().optional(),
  }),
  response: {
    200: output({ receipt: receiptOut, scan: output({ recordType: z.literal('PpeIssue'), recordId: id(), companyId: id() }) }),
    201: output({ receipt: receiptOut, scan: output({ recordType: z.literal('PpeIssue'), recordId: id(), companyId: id() }) }),
  },
})

export const voidIssueContract = defineContract({
  params: input({ issueId: id() }),
  body: input({ reason: words(L.reason) }),
  response: { 200: output({ receipt: receiptOut }) },
})

export const receiptPdfContract = defineContract({
  params: input({ receiptId: id() }),
  querystring: input({ language: z.enum(['it', 'en']).optional() }),
  response: {},
})

export const keepReceiptContract = defineContract({
  params: input({ receiptId: id() }),
  body: input({ language: z.enum(['it', 'en']).optional() }),
  response: { 200: output({ document: output({ id: id(), version: z.number().int(), language: z.string(), fileId: id(), createdAt: instant() }), made: z.boolean() }) },
})

export const personCardContract = defineContract({
  params: input({ employeeId: id() }),
  response: {
    200: output({
      employee: output({ id: id(), name: z.string(), employeeCode: z.string().nullable(), status: z.string(), companyId: id(), siteId: id(), site: codeName }),
      role: roleRef,
      kit: z.array(gapLineOut),
      receipts: z.array(receiptOut),
      /** The leaver step "PPE returned" of an open or closed leaving, when there is one. */
      returned: output({ caseId: id(), status: z.string(), doneAt: instant().nullable(), issueId: id().nullable() }).nullable(),
      canIssue: z.boolean(),
      today: z.string(),
      law,
    }),
  },
})

// ---- the floor --------------------------------------------------------------------------------------------------------------

const floorItem = output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, category, standard: z.string().nullable(), sizes: z.array(z.string()) })
const credentials = { badgeCode: z.string().max(64).optional(), workerId: id().optional() }

export const floorItemsContract = defineContract({
  response: { 200: output({ items: z.array(floorItem) }) },
})

export const floorPersonContract = defineContract({
  body: input(credentials),
  response: {
    200: output({
      worker: output({ id: id(), displayName: z.string() }),
      role: output({ code: z.string(), name: z.string() }).nullable(),
      /** The person's kit with what they hold (the tiles the tablet prefills). */
      kit: z.array(output({ ppeItemId: id(), quantity: z.number().int(), held: z.number().int(), missing: z.number().int(), whenToWear: z.string() })),
      /** What they sign, in their language. */
      statement: z.string(),
    }),
  },
})

export const floorReceiveContract = defineContract({
  body: input({ ...credentials, pin: z.string().min(1).max(12), lines: linesIn }),
  response: {
    200: output({
      receipt: output({ id: id(), issuedAt: instant(), issueIds: z.array(id()), units: z.number().int(), worker: output({ id: id(), displayName: z.string() }), statement: z.string(), sha256: z.string() }),
    }),
  },
})

// ---- the leaver step --------------------------------------------------------------------------------------------------------

export const leaverPpeContract = defineContract({
  params: input({ caseId: id() }),
  response: {
    200: output({
      employee: output({ id: id(), name: z.string() }),
      step: output({ id: id(), status: z.string(), version: z.number().int(), recordType: z.string().nullable(), recordId: id().nullable() }).nullable(),
      /** What the person holds (standing issues), per item. */
      held: z.array(output({ ppeItemId: id(), code: z.string(), name: z.string(), units: z.number().int(), lastIssuedAt: instant(), issueIds: z.array(id()) })),
      /** Their receipts, newest first (the step names one). */
      receipts: z.array(output({ receiptId: id(), issuedAt: instant(), method, units: z.number().int() })),
      canManage: z.boolean(),
    }),
  },
})

export const leaverPpeReturnedContract = defineContract({
  params: input({ caseId: id(), stepId: id() }),
  /** The step's version and the issue the returned PPE was handed over with (one of the person's, not voided). */
  body: input({ version: version(), issueId: id() }),
  response: { 200: output({ leaver: leaverOut }) },
})
