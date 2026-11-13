import { z } from 'zod'
import { SUBSTITUTE_KINDS, SUBSTITUTION_STATUSES } from '@nexus/factory-domain/inventory/substitutions/rules'
import { ALTERNATE_USES } from '@nexus/factory-domain/product/bom-lines/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * B-W2b-320 — every call of "Use a substitute" (design warehouse.picking pop:pk-sub, production.workorders Materials
 * "Substitute…"; MES-139) on B-W2b-298's API (apps/factory-api modules/inventory/substitutions), and the work order's BOM
 * lines (W1's pick read, `GET /inventory/picking/work-orders/:id`: each material's lines by BOM line). Quantities are decimal
 * text; no money; no list names a person (an approver's name is said inside one request). The API's English sentences
 * (`held`, `answer.message`, a lot's `words`, `statusWords`) are never drawn: model.ts says them from codes and facts.
 */

export type SubstituteKind = (typeof SUBSTITUTE_KINDS)[number]
export type SubstitutionStatus = (typeof SUBSTITUTION_STATUSES)[number]
export type AlternateUse = (typeof ALTERNATE_USES)[number]

const itemRef = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string().optional(), tracking: z.string(), baseUom: z.string(), isPpeComponent: z.boolean() })
const colour = z.object({ id: z.string(), code: z.string(), name: z.string() })

const substitutionSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string() }),
  line: z.object({ id: z.string(), seq: z.number(), placement: z.string().nullable(), material: z.object({ id: z.string(), code: z.string(), name: z.string(), baseUom: z.string() }) }),
  kind: z.enum(SUBSTITUTE_KINDS),
  substitute: z.object({
    item: itemRef,
    colour: colour.nullable(),
    lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
    alternate: z.object({ id: z.string(), priority: z.number(), allowedWhen: z.enum(ALTERNATE_USES) }).nullable(),
  }),
  quantity: z.string(),
  uom: z.string(),
  replaces: z.object({ quantity: z.string(), uom: z.string() }).nullable(),
  reasonCode: z.string().nullable(),
  status: z.enum(SUBSTITUTION_STATUSES),
  approval: z.object({ taskId: z.string(), status: z.string(), dueAt: z.string().nullable() }).nullable(),
  asked: z.enum(['OFFICE', 'FLOOR']),
  decidedAt: z.string().nullable(),
  issuedAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
})
export type Substitution = z.infer<typeof substitutionSchema>

const stockLotSchema = z.object({
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string(), crViStatus: z.string(), requiresCrViTest: z.boolean() }).nullable(),
  colour: colour.nullable(),
  onHand: z.string(),
  hides: z.number(),
  places: z.array(z.string()),
  usable: z.boolean(),
})
export type StockLot = z.infer<typeof stockLotSchema>

const choiceSchema = z.object({
  kind: z.enum(SUBSTITUTE_KINDS),
  alternate: z.object({ id: z.string(), priority: z.number(), allowedWhen: z.enum(ALTERNATE_USES), certificateCheck: z.boolean(), qty: z.string().nullable(), note: z.string().nullable(), colourId: z.string().nullable() }).nullable(),
  item: itemRef,
  answer: z.object({ may: z.boolean(), held: z.array(z.string()) }),
  needsPerson: z.boolean(),
  refusal: z.object({ code: z.string() }).nullable(),
  certificateRequired: z.boolean(),
  certificate: z.object({ id: z.string(), number: z.string(), standard: z.string(), validTo: z.string() }).nullable(),
  max: z.string().nullable(),
  stock: z.object({ onHand: z.string(), lots: z.array(stockLotSchema) }),
  approval: z.object({
    asks: z.boolean(),
    active: z.number(),
    rule: z.object({ id: z.string(), name: z.string(), signatureMeaning: z.string().nullable(), requireStepUp: z.boolean(), dueHours: z.number().nullable() }).nullable(),
    approver: z.object({ kind: z.enum(['ROLE', 'PERSON']), id: z.string(), name: z.string() }).nullable(),
    namedSelf: z.boolean(),
  }),
  mayAsk: z.boolean(),
  /** Present when the choice is held (its words are the API's English: model.ts says it from the facts). */
  held: z.string().nullable(),
})
export type SubstituteChoice = z.infer<typeof choiceSchema>

const optionsSchema = z.object({
  asOf: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string(), status: z.string(), siteId: z.string(), companyId: z.string() }),
  line: z.object({
    id: z.string(),
    seq: z.number(),
    placement: z.string().nullable(),
    material: itemRef,
    qty: z.string(),
    uom: z.string(),
    planned: z.string(),
    issued: z.string(),
    toIssue: z.string(),
    short: z.string(),
    ownShort: z.boolean(),
    standing: z.string(),
    open: z.string(),
  }),
  substitutions: z.array(substitutionSchema),
  choices: z.array(choiceSchema),
})
export type SubstituteOptions = z.infer<typeof optionsSchema>

const seg = (value: string) => encodeURIComponent(value)
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export const substituteOptions = (api: ApiClient, workOrderId: string, bomLineId: string, signal?: AbortSignal) => api.get('/inventory/substitutions/options', { query: { workOrderId, bomLineId }, schema: optionsSchema, signal })

export interface AskBody {
  workOrderId: string
  bomLineId: string
  toItemId: string
  toLotId?: string
  quantity: string
  uom?: string
  reasonCode?: string
  reason: string
  note?: string
}
const askAnswerSchema = z.object({
  substitution: substitutionSchema,
  approval: z.object({ asked: z.boolean(), taskId: z.string().nullable(), approverRoleId: z.string().nullable(), approverUserId: z.string().nullable(), dueAt: z.string().nullable() }),
  approvedAtOnce: z.boolean(),
})
export type AskAnswer = z.infer<typeof askAnswerSchema>
export const askSubstitute = (api: ApiClient, body: AskBody) => api.post('/inventory/substitutions', { body, schema: askAnswerSchema, ...key() })

export const listSubstitutions = (api: ApiClient, query: { siteId?: string | null; workOrderId?: string | null; status?: 'OPEN' | 'ALL' | SubstitutionStatus; limit?: number }, signal?: AbortSignal) =>
  api.get('/inventory/substitutions', {
    query: Object.fromEntries(Object.entries({ siteId: query.siteId, workOrderId: query.workOrderId, status: query.status, limit: query.limit }).filter(([, value]) => value !== undefined && value !== null)),
    schema: z.object({ asOf: z.string(), tiles: z.object({ waiting: z.number(), approved: z.number() }), substitutions: z.array(substitutionSchema), more: z.boolean() }),
    signal,
  })

export const withdrawSubstitute = (api: ApiClient, substitution: Pick<Substitution, 'id' | 'version'>, reason: string) =>
  api.post(`/inventory/substitutions/${seg(substitution.id)}/withdraw`, { body: { version: substitution.version, reason }, schema: z.object({ substitution: substitutionSchema }), ...key() }).then((answer) => answer.substitution)

// ---- the work order's BOM lines (W1's pick read, inventory.issue) -------------------------------------------------------------

const bomRowsSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string().optional() }).passthrough(),
  lines: z.array(
    z.object({
      itemId: z.string(),
      itemCode: z.string(),
      itemName: z.string(),
      itemColourId: z.string().nullable(),
      colourCode: z.string().nullable(),
      baseUom: z.string(),
      toIssue: z.string(),
      covered: z.boolean(),
      rows: z.array(z.object({ bomLineId: z.string(), bomSeq: z.number(), placement: z.string().nullable(), planned: z.string(), issued: z.string(), toIssue: z.string() })),
    }),
  ),
})
export type BomRows = z.infer<typeof bomRowsSchema>

/** One BOM line of the work order (a material and colour may come from several lines, one per placement). */
export interface BomLineChoice {
  bomLineId: string
  seq: number
  placement: string | null
  itemId: string
  itemCode: string
  itemName: string
  itemColourId: string | null
  colourCode: string | null
  baseUom: string
  planned: number
  toIssue: number
}

export const workOrderBomLines = (api: ApiClient, workOrderId: string, signal?: AbortSignal) => api.get(`/inventory/picking/work-orders/${seg(workOrderId)}`, { schema: bomRowsSchema, signal })
