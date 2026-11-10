import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { FREQUENCIES, PLAN_STAGES } from '../../quality/plans/rules'
import { RECORD_KINDS } from '../../quality/triggers/rules'
import { REVISION_STATUSES } from '../styles/revisions'
import { STYLE_STATUSES } from '../styles/rules'
import { OPERATION_STATUSES, WORK_CENTRE_KINDS } from '../routing/operations'
import { DAYS_FROM, SETTING_LIMITS, VARIANT_LIMITS } from './rules'

/**
 * A routing in depth (B-W2b-225; PRD-118, PRD-119, PRD-124, PRD-128): what apps/factory-api's modules/product/routing-depth
 * accepts and answers, and what the screens (B-W2b-235 Operations and routing in depth, B-W2b-232 the floor's Spec &
 * instructions) read. No money. Every write to a step sends the REVISION's `version` (a revision's routing is one
 * versioned record, as W1's); a library operation's settings send the OPERATION's `version`.
 */

const version = () => z.number().int().min(1)
const words = () => output({ it: z.string(), en: z.string() })
const text = (max: number) => z.string().trim().min(1).max(max)

// ---- machine and stitch settings (PRD-118) ---------------------------------------------------------------------------------

/** One setting; left out or null: not said. Stitches per cm as a decimal string ("3.5"). */
export const settingInput = input({
  machineClassId: id().nullish(),
  stitchType: text(SETTING_LIMITS.stitchType).nullish(),
  needle: text(SETTING_LIMITS.text).nullish(),
  thread: text(SETTING_LIMITS.text).nullish(),
  stitchesPerCm: z.string().trim().max(12).nullish(),
  tension: text(SETTING_LIMITS.text).nullish(),
  foot: text(SETTING_LIMITS.text).nullish(),
  notes: text(SETTING_LIMITS.notes).nullish(),
})
export type SettingInputBody = z.output<typeof settingInput>

/** A library operation's default settings, the whole list in order (empty: none). */
export const librarySettingsBody = input({ version: version(), settings: z.array(settingInput).max(SETTING_LIMITS.perList) })
export type LibrarySettingsBody = z.output<typeof librarySettingsBody>

/** A draft step's settings: the whole list, or `fromLibrary` (a copy of its library operation's list now). */
export const stepSettingsBody = input({
  version: version(),
  settings: z.array(settingInput).max(SETTING_LIMITS.perList).optional(),
  fromLibrary: z.literal(true).optional(),
}).refine((body) => (body.settings === undefined) !== (body.fromLibrary === undefined), { message: 'Send the settings or fromLibrary, one of the two.', path: ['settings'] })
export type StepSettingsBody = z.output<typeof stepSettingsBody>

export const settingView = output({
  id: id(),
  seq: z.number().int(),
  machineClass: output({ id: id(), code: z.string(), label: words(), active: z.boolean() }).nullable(),
  stitchType: z.string().nullable(),
  needle: z.string().nullable(),
  thread: z.string().nullable(),
  stitchesPerCm: z.string().nullable(),
  tension: z.string().nullable(),
  foot: z.string().nullable(),
  notes: z.string().nullable(),
  /** One line for the tablet: "Post-bed · 301 · 134 LR Nm 110 · Tkt 40 · 3.5 per cm". */
  line: words(),
})
export type SettingView = z.infer<typeof settingView>

/** The Machine & settings tab of a library operation. */
export const librarySettingsView = output({
  operation: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(OPERATION_STATUSES), version: z.number().int() }),
  settings: z.array(settingView),
  /** Draft routing steps of this operation with no settings of their own ("Copy from library" is offered there). */
  draftStepsWithout: z.number().int(),
  may: output({ manage: z.boolean() }),
})
export type LibrarySettingsView = z.infer<typeof librarySettingsView>

// ---- variants and checkpoints of a step ----------------------------------------------------------------------------------------

/** What a draft step is for (PRD-128): every list empty = every cell. Option values: active options of a group the style offers (B-W2b-229). */
export const stepVariantsBody = input({
  version: version(),
  sizes: z.array(z.string().trim().min(1).max(20)).max(VARIANT_LIMITS.sizes).default([]),
  colourwayIds: z.array(id()).max(VARIANT_LIMITS.colourways).default([]),
  optionValueIds: z.array(id()).max(VARIANT_LIMITS.optionValues).default([]),
})
export type StepVariantsBody = z.output<typeof stepVariantsBody>

/** A draft step's quality checkpoint (PRD-119): a cutting, in-line or end-of-line plan; null takes it off. */
export const stepCheckpointBody = input({ version: version(), inspectionPlanId: id().nullable() })
export type StepCheckpointBody = z.output<typeof stepCheckpointBody>

export const checkpointView = output({
  plan: output({ id: id(), code: z.string(), name: z.string(), stage: z.enum(PLAN_STAGES), companyId: id() }),
  approvedVersion: output({ id: id(), number: z.number().int(), frequency: z.enum(FREQUENCIES).nullable(), frequencyValue: z.number().int().nullable() }).nullable(),
  /** The record it opens at a bundle's first report; null: none (no approved version). */
  kind: z.enum(RECORD_KINDS).nullable(),
  does: words(),
  warning: words().nullable(),
})
export type CheckpointView = z.infer<typeof checkpointView>

export const variantsView = output({
  sizes: z.array(output({ code: z.string(), label: z.string() })),
  colourways: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  optionValueIds: z.array(id()),
  /** "Only for sizes 54, 56 · colourway BLK"; null: every cell. */
  words: words().nullable(),
})

export const stepDepthView = output({
  stepId: id(),
  seq: z.number().int(),
  operationId: id(),
  code: z.string(),
  name: z.string(),
  workCentreKind: z.enum(WORK_CENTRE_KINDS),
  scanRequired: z.boolean(),
  variants: variantsView,
  checkpoint: checkpointView.nullable(),
  settings: z.array(settingView),
  /** The library operation's settings now (shown when the step has none: "Copy from library"). */
  librarySettings: z.number().int(),
  version: z.number().int(),
  updatedAt: instant(),
})
export type StepDepthView = z.infer<typeof stepDepthView>

export const revisionDaysView = output({
  id: id(),
  revision: z.number().int(),
  status: z.enum(REVISION_STATUSES),
  /** First day it applies to new work orders (its release day; for a revision released before effective days: that day). */
  effectiveFrom: businessDate().nullable(),
  /** First day it no longer applies; null: it still applies (or was never released). */
  effectiveTo: businessDate().nullable(),
  fromSource: z.enum(DAYS_FROM).nullable(),
})

/** A revision's routing in depth (the Routing tab's W2b columns and the operation drawer's variants). */
export const routingDepthView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES) }),
  revision: revisionDaysView,
  sizes: z.array(output({ code: z.string(), label: z.string() })),
  colourways: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  steps: z.array(stepDepthView),
  /** The options a step may be limited to (B-W2b-229: the style's offered active options); none offered: unavailable, with the words. */
  options: output({ available: z.boolean(), words: words() }),
  /** A DRAFT revision of a style that is not archived, and the caller may change its routing. */
  editable: z.boolean(),
})
export type RoutingDepthView = z.infer<typeof routingDepthView>

// ---- effectivity (PRD-124) -----------------------------------------------------------------------------------------------------

export const effectivityQuery = input({ on: businessDate().optional() })
export type EffectivityQuery = z.output<typeof effectivityQuery>

export const effectivityView = output({
  style: output({ id: id(), code: z.string(), name: z.string() }),
  today: businessDate(),
  /** The day asked (?on=), else today. */
  on: businessDate(),
  /** The revision whose routing applied to new work orders on that day. */
  inEffect: output({ id: id(), revision: z.number().int() }).nullable(),
  revisions: z.array(
    revisionDaysView.extend({
      inEffect: z.boolean(),
      /** Work orders made to it that are not closed or cancelled: released ones keep its frozen routing; drafts wait for the current revision. */
      workOrders: output({
        open: z.number().int(),
        drafts: z.number().int(),
        /** Their numbers (at most 20), only with workorders.view. */
        numbers: z.array(z.string()).nullable(),
      }),
    }),
  ),
  words: words(),
})
export type EffectivityView = z.infer<typeof effectivityView>

// ---- a work order's routing copy ----------------------------------------------------------------------------------------------

const cellRef = output({ id: id(), label: z.string(), colourwayId: id(), size: z.string(), quantity: z.number().int() })

export const workOrderOperationDepth = output({
  /** The stored operation (null: a draft's planned one). */
  id: id().nullable(),
  seq: z.number().int(),
  routingSeq: z.number().int().nullable(),
  stepId: id().nullable(),
  code: z.string(),
  name: z.string(),
  standardMinutes: z.string(),
  scanRequired: z.boolean(),
  /** An operation added to a released work order (no routing step). */
  unplanned: z.boolean(),
  /** The cells of the work order it is done on (every one when the step is for every cell). */
  forCells: z.array(z.string()),
  variants: words().nullable(),
  /** Minutes per garment of each size of the work order: the step's run plus the size's extra minutes. */
  minutesBySize: z.array(output({ size: z.string(), minutes: z.string() })),
  setupMinutes: z.string().nullable(),
  waitMinutes: z.string().nullable(),
  moveMinutes: z.string().nullable(),
  checkpoint: checkpointView.nullable(),
  settings: z.array(settingView),
  instructions: z.string().nullable(),
})

export const workOrderRoutingView = output({
  workOrder: output({ id: id(), number: z.string(), status: z.string(), kind: z.string() }),
  /** The routing is the work order's frozen copy (released) or what its release would copy (a draft). */
  frozen: z.boolean(),
  revision: revisionDaysView.extend({
    /** The style's revision for new work orders today, when it is another one. */
    current: output({ id: id(), revision: z.number().int(), since: businessDate().nullable() }).nullable(),
    words: words(),
  }).nullable(),
  cells: z.array(cellRef),
  operations: z.array(workOrderOperationDepth),
  /** The revision's steps this work order does not take: none of its cells is one they are for. */
  leftOut: z.array(output({ stepId: id(), seq: z.number().int(), code: z.string(), name: z.string(), words: words() })),
})
export type WorkOrderRoutingView = z.infer<typeof workOrderRoutingView>

// ---- the tablet --------------------------------------------------------------------------------------------------------------

/** What the tablet shows with the instruction at an operation of a work order (B-W2b-232 reads it). */
export const floorSettingsView = output({
  operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
  workOrder: output({ id: id(), number: z.string() }),
  instructions: z.string().nullable(),
  settings: z.array(settingView),
  checkpoint: output({ code: z.string(), name: z.string(), kind: z.enum(RECORD_KINDS).nullable(), does: words() }).nullable(),
  /** The cells of the work order the operation is done on, in words (null: every cell). */
  variants: words().nullable(),
})
export type FloorSettingsView = z.infer<typeof floorSettingsView>
