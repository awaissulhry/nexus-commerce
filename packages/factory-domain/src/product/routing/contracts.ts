import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { fitsDecimal } from '../../core/money'
import { bomRevisionView } from '../bom/contracts'
import { localisedNames } from '../materials/contracts'
import { REVISION_STATUSES } from '../styles/revisions'
import { STYLE_STATUSES } from '../styles/rules'
import { MAX_INSTRUCTIONS, MINUTES_INPUT_SCALE, MINUTES_PRECISION, MINUTES_SCALE, OPERATION_CODE, OPERATION_CODE_RULE, OPERATION_STATUSES, WORK_CENTRE_KINDS } from './operations'
import { MAX_ROUTING_STEPS, ROUTING_ISSUE_CODES } from './rules'

/**
 * The operation library's and the routing's contracts (plan A1 D2; A2 SCR-049 "Libraries: operations", SCR-043
 * "Style › Routing & minutes"): what apps/factory-api's modules/product/operations and modules/product/routing accept
 * and answer, and what the web's typed client reads. No money: the labour cost of the minutes is the cost sheet's
 * (B-W1-16). Minutes travel as plain decimal strings ("96.5"); a typed value with more than 3 decimals is rounded half
 * up to 3 (factory-domain product/routing/operations minutesOf). Every routing write sends the REVISION's `version`
 * (COL-078): a revision's BOM and routing are one versioned record.
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const version = () => z.number().int().min(1)
const code = () => z.string().trim().toUpperCase().regex(OPERATION_CODE, { message: `Expected ${OPERATION_CODE_RULE}.` })
/** Typed standard minutes per garment: above 0 (checked by the rules), at most 7 digits and 6 decimals (rounded to 3). */
const minutes = () =>
  z.string().refine((value) => /^\d+(?:\.\d+)?$/.test(value) && fitsDecimal(value, MINUTES_PRECISION - MINUTES_SCALE + MINUTES_INPUT_SCALE, MINUTES_INPUT_SCALE), {
    message: `Expected minutes with at most ${MINUTES_PRECISION - MINUTES_SCALE} digits and ${MINUTES_INPUT_SCALE} decimals.`,
  })
const kind = () => z.enum(WORK_CENTRE_KINDS)

// ---- the operation library (SCR-049) -----------------------------------------------------------------------------------

const editable = {
  name: text(200),
  /** The name per language (it, en): the floor screen shows the worker's. */
  nameI18n: localisedNames().nullish(),
  /** The department: the kind of work centre it runs at. */
  workCentreKind: kind(),
  /** Flat-bed, post-bed, twin-needle, skiving, press, laser … */
  machineType: text(60).nullish(),
  skill: text(60).nullish(),
  /** Per garment (SMV). */
  standardMinutes: minutes(),
  /** How it is done, for the traveller and the floor screen. */
  instructions: text(MAX_INSTRUCTIONS).nullish(),
}

export const createOperationBody = input({
  /** The company it belongs to; left out or null: tenant-wide (every company of the tenant). */
  companyId: id().nullish(),
  code: code(),
  ...editable,
})
export type CreateOperationBody = z.output<typeof createOperationBody>

/** A change: only the fields sent change (null clears an optional one). The code changes only while no routing uses it. */
export const updateOperationBody = input(editable)
  .partial()
  .extend({ version: version(), code: code().optional() })
export type UpdateOperationBody = z.output<typeof updateOperationBody>

export const operationStatusBody = input({ version: version(), reason: text(500).optional() })
export type OperationStatusBody = z.output<typeof operationStatusBody>

/** The list's filters (SCR-049): a search over code, name, machine and skill; kinds as `CUTTING,SEWING`. */
export const listOperationsQuery = input({
  q: z.string().trim().max(100).optional(),
  kind: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return undefined
      const kinds = [...new Set(value.split(',').map((part) => part.trim().toUpperCase()))]
      if (kinds.some((entry) => !(WORK_CENTRE_KINDS as readonly string[]).includes(entry))) {
        ctx.addIssue({ code: 'custom', message: `Expected kinds from ${WORK_CENTRE_KINDS.join(', ')}.` })
        return z.NEVER
      }
      return kinds as (typeof WORK_CENTRE_KINDS)[number][]
    }),
  status: z.enum([...OPERATION_STATUSES, 'ALL']).default('ACTIVE'),
  /** UNUSED: in no routing; DIFFERS: a draft or released routing has other minutes than the library. */
  usage: z.enum(['UNUSED', 'DIFFERS']).optional(),
  /** Exactly this company's operations and the tenant-wide ones (null: every company the caller sees). */
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** `nextCursor` of the previous page, as it came. */
  cursor: z.string().max(200).optional(),
})
export type ListOperationsQuery = z.output<typeof listOperationsQuery>

const operationFields = {
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: localisedNames().nullable(),
  workCentreKind: kind(),
  machineType: z.string().nullable(),
  skill: z.string().nullable(),
  standardMinutes: z.string(),
  status: z.enum(OPERATION_STATUSES),
  /** Style revisions (any status) whose routing names it. */
  usedIn: z.number().int(),
  /** Draft or released revisions where a step of it has other minutes than the library. */
  differing: z.number().int(),
  version: z.number().int(),
  updatedAt: instant(),
}

/** A row of the operation list. */
export const operationRow = output(operationFields)
export type OperationRow = z.infer<typeof operationRow>

/** The operation record: its definition and minutes, and every routing step made from it (where used). */
export const operationView = output({
  ...operationFields,
  instructions: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
  whereUsed: z.array(
    output({
      style: output({ id: id(), code: z.string(), name: z.string() }),
      revision: output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) }),
      stepId: id(),
      seq: z.number().int(),
      /** The step's minutes, and how far they are from the library's (step − library). */
      standardMinutes: z.string(),
      difference: z.string(),
    }),
  ),
})
export type OperationView = z.infer<typeof operationView>

// ---- a revision's routing (SCR-043) ------------------------------------------------------------------------------------

const stepInput = {
  /** For this style; left out: the library's. */
  standardMinutes: minutes(),
  /** The floor scans every bundle at it; left out on a new step: scanned. */
  scanRequired: z.boolean(),
  /** For this style; left out on a new step: the library's; null clears it. */
  instructions: text(MAX_INSTRUCTIONS).nullable(),
}

/** Operations from the library, added at the end of the draft's routing in the order sent. */
export const addStepsBody = input({
  version: version(),
  operations: z
    .array(input({ operationId: id(), standardMinutes: stepInput.standardMinutes.optional(), scanRequired: stepInput.scanRequired.optional(), instructions: stepInput.instructions.optional() }))
    .min(1)
    .max(50),
})
export type AddStepsBody = z.output<typeof addStepsBody>

/** A change to a step: only what it names. */
export const updateStepBody = input({
  version: version(),
  standardMinutes: stepInput.standardMinutes.optional(),
  scanRequired: stepInput.scanRequired.optional(),
  instructions: stepInput.instructions.optional(),
})
export type UpdateStepBody = z.output<typeof updateStepBody>

/** A step out of the draft's routing: the revision's version in the query. */
export const removeStepQuery = input({ version: z.coerce.number().int().min(1) })
export type RemoveStepQuery = z.output<typeof removeStepQuery>

/** The new order: every step of the routing once; they are numbered 10, 20, 30 … in it. */
export const reorderStepsBody = input({ version: version(), stepIds: z.array(id()).min(1).max(MAX_ROUTING_STEPS) })
export type ReorderStepsBody = z.output<typeof reorderStepsBody>

/** The steps of a style's RELEASED routing copied into this draft: after its steps, or instead of them. */
export const copyStepsBody = input({
  version: version(),
  fromStyleId: id(),
  /** A released revision of that style; left out: its current (released) one. */
  fromRevisionId: id().optional(),
  /** true: the draft's steps are removed first. */
  replace: z.boolean().default(false),
})
export type CopyStepsBody = z.output<typeof copyStepsBody>

/** Two revisions of one style: what changed in the routing from the first to the second. */
export const compareRoutingQuery = input({ from: id(), to: id() })
export type CompareRoutingQuery = z.output<typeof compareRoutingQuery>

const issue = output({ code: z.enum(ROUTING_ISSUE_CODES), stepId: id().nullable(), message: z.string() })

export const stepView = output({
  id: id(),
  seq: z.number().int(),
  /** The library operation it was copied from, as the library has it now. */
  operation: output({
    id: id(),
    code: z.string(),
    name: z.string(),
    status: z.enum(OPERATION_STATUSES),
    machineType: z.string().nullable(),
    skill: z.string().nullable(),
    standardMinutes: z.string(),
  }),
  code: z.string(),
  name: z.string(),
  nameI18n: localisedNames().nullable(),
  workCentreKind: kind(),
  standardMinutes: z.string(),
  /** The step's minutes are not the library's now ('Library: 4.20 · Use library value'). */
  differsFromLibrary: z.boolean(),
  scanRequired: z.boolean(),
  /** The final operation: the last scanned step, where the batch or serial is given (B-W1-44). */
  final: z.boolean(),
  instructions: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type StepView = z.infer<typeof stepView>

/** The routing's minutes (the "Minutes" strip and the department subtotals). */
export const routingMinutesView = output({
  perGarment: z.string(),
  byKind: z.array(output({ workCentreKind: kind(), minutes: z.string(), steps: z.number().int() })),
  bySize: z.array(output({ size: z.string(), minutes: z.string() })),
  steps: z.number().int(),
  scanPoints: z.number().int(),
})

/** The routing of one revision (SCR-043): its steps in order, its minutes, and what the release check will say. */
export const routingView = output({
  revision: bomRevisionView,
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES) }),
  /** The style's range, in the scale's order. */
  sizes: z.array(output({ code: z.string(), label: z.string() })),
  steps: z.array(stepView),
  minutes: routingMinutesView,
  finalStepId: id().nullable(),
  /** What the release check reports (a draft only; a frozen routing is not checked again). */
  issues: z.array(issue),
  warnings: z.array(issue),
  /** A DRAFT revision of a style that is not archived: its routing may be changed. */
  editable: z.boolean(),
})
export type RoutingView = z.infer<typeof routingView>

const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()])
const stepRef = output({ stepId: id(), seq: z.number().int(), operationId: id(), code: z.string(), standardMinutes: z.string() })
const revisionRef = output({ id: id(), revision: z.number().int(), status: z.enum(REVISION_STATUSES) })

/** What changed from one revision's routing to another's. */
export const routingDiffView = output({
  from: revisionRef,
  to: revisionRef,
  added: z.array(stepRef),
  removed: z.array(stepRef),
  changed: z.array(output({ from: stepRef, to: stepRef, fields: z.array(output({ field: z.string(), from: fieldValue, to: fieldValue })) })),
  unchanged: z.number().int(),
  minutes: output({ from: z.string(), to: z.string() }),
})
export type RoutingDiffView = z.infer<typeof routingDiffView>
