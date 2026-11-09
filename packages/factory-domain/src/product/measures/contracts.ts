import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { bomRevisionView } from '../bom/contracts'
import { STYLE_STATUSES } from '../styles/rules'
import { POM_KINDS, POM_LIMITS, POM_STATUSES, POM_UOMS, POM_ZONES, SPEC_LIMITS, SPEC_STATUSES, VALUE_SOURCES } from './rules'

/**
 * The points of measure and the measurement spec's contracts (B-W2b-224; design products.sizes "Points of measure",
 * products.styles › Sizes & measurements › "Measurement spec"): what apps/factory-api's modules/product/measures accepts
 * and answers, and what the web's typed client reads. No money. Measures travel as plain decimal strings ("58.5") in
 * the point's unit. A point's writes send the point's `version`; a spec's writes send the SPEC's `version`.
 */

const version = () => z.number().int().min(1)
const text = (max: number) => z.string().max(max)
const words = (max: number) => z.record(z.string().max(16), z.string().max(max))
const measure = () => z.string().trim().max(12)
const sizeCode = () => z.string().trim().min(1).max(40)

// ---- points of measure ------------------------------------------------------------------------------------------------

export const listPomsQuery = input({
  /** Over code and name. */
  q: z.string().trim().max(100).optional(),
  kind: z.enum(POM_KINDS).optional(),
  zone: z.enum(POM_ZONES).optional(),
  status: z.enum([...POM_STATUSES, 'ALL']).default('ACTIVE'),
  /** Exactly this company's points and the tenant-wide ones. */
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
})
export type ListPomsQuery = z.output<typeof listPomsQuery>

export const createPomBody = input({
  /** The company it belongs to; left out or null: tenant-wide (every company of the tenant). */
  companyId: id().nullish(),
  code: z.string().trim().min(1).max(40),
  name: text(POM_LIMITS.name),
  nameI18n: words(POM_LIMITS.name).nullish(),
  description: text(POM_LIMITS.description).nullish(),
  howTo: text(POM_LIMITS.howTo).nullish(),
  howToI18n: words(POM_LIMITS.howTo).nullish(),
  kind: z.enum(POM_KINDS),
  bodyZone: z.enum(POM_ZONES),
  uom: z.enum(POM_UOMS).default('CM'),
  /** Plus and minus, in its unit; null: typed per spec. */
  defaultTolerance: measure().nullish(),
  /** A GARMENT point's BODY point (PRD-069). */
  bodyPointId: id().nullish(),
})
export type CreatePomBody = z.output<typeof createPomBody>

/** A change to a point (a cell of the list, autosaved): only what it names; null clears an optional field. Kind and unit only while nothing names it. */
export const updatePomBody = input({
  version: version(),
  code: z.string().trim().min(1).max(40).optional(),
  name: text(POM_LIMITS.name).optional(),
  nameI18n: words(POM_LIMITS.name).nullable().optional(),
  description: text(POM_LIMITS.description).nullable().optional(),
  howTo: text(POM_LIMITS.howTo).nullable().optional(),
  howToI18n: words(POM_LIMITS.howTo).nullable().optional(),
  kind: z.enum(POM_KINDS).optional(),
  bodyZone: z.enum(POM_ZONES).optional(),
  uom: z.enum(POM_UOMS).optional(),
  defaultTolerance: measure().nullable().optional(),
  bodyPointId: id().nullable().optional(),
  /** ARCHIVED takes it out of new specs and rules (they keep it); ACTIVE restores it. */
  status: z.enum(POM_STATUSES).optional(),
})
export type UpdatePomBody = z.output<typeof updatePomBody>

/** The list's selection (Owner rule 2026-10-29): several points archived or restored in one write, each at the version read. */
export const pomStatusBody = input({ points: z.array(input({ id: id(), version: version() })).min(1).max(200), status: z.enum(POM_STATUSES) })
export type PomStatusBody = z.output<typeof pomStatusBody>

/** The how-to picture announced (a PHOTO): then PUT to the address, then complete. */
export const pomPictureBody = input({ originalName: z.string().min(1).max(255), contentType: z.string().min(1).max(100), sizeBytes: z.number().int().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), version: version() })
export type PomPictureBody = z.output<typeof pomPictureBody>

export const pomVersionQuery = input({ version: z.coerce.number().int().min(1) })

const pointRef = output({ id: id(), code: z.string(), name: z.string() })

export const pomRow = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()).nullable(),
  description: z.string().nullable(),
  howTo: z.string().nullable(),
  howToI18n: z.record(z.string(), z.string()).nullable(),
  kind: z.enum(POM_KINDS),
  bodyZone: z.enum(POM_ZONES),
  uom: z.enum(POM_UOMS),
  defaultTolerance: z.string().nullable(),
  bodyPoint: pointRef.nullable(),
  /** Its how-to picture is on file (GET …/picture gives a look at it). */
  hasPicture: z.boolean(),
  status: z.enum(POM_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})
export type PomRow = z.infer<typeof pomRow>

export const pomView = output({
  ...pomRow.shape,
  /** What names it: while nothing does, its kind and unit may change. */
  use: output({ specValues: z.number().int(), specs: z.number().int(), gradeSteps: z.number().int(), gradeRules: z.number().int(), templatePoints: z.number().int(), garmentPoints: z.array(pointRef), words: z.string() }),
  picture: output({ fileId: id(), status: z.string(), originalName: z.string() }).nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
})
export type PomView = z.infer<typeof pomView>

// ---- the measurement spec ---------------------------------------------------------------------------------------------

/** A spec started on a draft revision: its base size (the style's by default), a grade rule of the style's scale, or a copy of another spec's cells. */
export const startSpecBody = input({
  baseSize: sizeCode().optional(),
  gradeRuleId: id().nullish(),
  /** Another spec (of any style the caller may see) whose cells of the style's range are copied, as they are typed or graded. */
  copyFromSpecId: id().optional(),
})
export type StartSpecBody = z.output<typeof startSpecBody>

/** A draft spec's base size or grade rule (null: typed by hand). */
export const updateSpecBody = input({ version: version(), baseSize: sizeCode().optional(), gradeRuleId: id().nullable().optional() })
export type UpdateSpecBody = z.output<typeof updateSpecBody>

const cellInput = input({
  pointOfMeasureId: id(),
  size: sizeCode(),
  /** null: the cell taken out. */
  nominal: measure().nullable(),
  /** Left out: the cell's, else the point's in this spec, else the library's default. */
  toleranceMinus: measure().nullish(),
  tolerancePlus: measure().nullish(),
})

/** Cells typed (a cell of the grid, a pasted sheet): written TYPED (on another size than the base: a manual override). */
export const specCellsBody = input({ version: version(), cells: z.array(cellInput).min(1).max(SPEC_LIMITS.cells) })
export type SpecCellsBody = z.output<typeof specCellsBody>

/** Points added from the library (at the end), each with its base size value. */
export const addSpecPointsBody = input({
  version: version(),
  points: z.array(input({ pointOfMeasureId: id(), nominal: measure(), toleranceMinus: measure().nullish(), tolerancePlus: measure().nullish() })).min(1).max(SPEC_LIMITS.points),
})
export type AddSpecPointsBody = z.output<typeof addSpecPointsBody>

/** Points out of the spec (every size of each), or the new order of every point. */
export const specPointsBody = input({ version: version(), pointOfMeasureIds: z.array(id()).min(1).max(SPEC_LIMITS.points) })
export type SpecPointsBody = z.output<typeof specPointsBody>

/** Approve, reopen or archive: the spec's version, and a reason for a reopen or an archive. */
export const specMoveBody = input({ version: version(), reason: z.string().trim().min(1).max(500).optional() })
export type SpecMoveBody = z.output<typeof specMoveBody>

const valueView = output({ id: id(), nominal: z.string(), toleranceMinus: z.string(), tolerancePlus: z.string(), source: z.enum(VALUE_SOURCES), words: z.string() })

export const measurementSpecView = output({
  revision: bomRevisionView,
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES), baseSize: z.string().nullable(), sizeScaleId: id() }),
  /** The style's range in its order (base size first marked by `spec.baseSize`). */
  sizes: z.array(output({ code: z.string(), label: z.string().nullable(), fitCode: z.string().nullable() })),
  /** The live spec (DRAFT or APPROVED); null: none yet ("No points of measure yet"). */
  spec: output({
    id: id(),
    status: z.enum(SPEC_STATUSES),
    baseSize: z.string(),
    gradeRule: output({ id: id(), code: z.string(), name: z.string(), format: z.string(), status: z.string() }).nullable(),
    approvedAt: instant().nullable(),
    approvedById: id().nullable(),
    /** Sent back with every write to this spec. */
    version: z.number().int(),
    createdAt: instant(),
    updatedAt: instant(),
  }).nullable(),
  points: z.array(
    output({
      pointOfMeasureId: id(),
      code: z.string(),
      name: z.string(),
      nameI18n: z.record(z.string(), z.string()).nullable(),
      kind: z.enum(POM_KINDS),
      bodyZone: z.enum(POM_ZONES),
      uom: z.enum(POM_UOMS),
      howTo: z.string().nullable(),
      hasPicture: z.boolean(),
      status: z.enum(POM_STATUSES),
      seq: z.number().int(),
      /** One per size of the range, in its order; null: missing. */
      cells: z.array(output({ size: z.string(), value: valueView.nullable() })),
    }),
  ),
  /** The cells the range asks that the spec does not have, per point. */
  missing: z.array(output({ pointOfMeasureId: id(), code: z.string(), sizes: z.array(z.string()) })),
  /** Earlier specs of this revision, kept. */
  archived: z.array(output({ id: id(), baseSize: z.string(), createdAt: instant(), approvedAt: instant().nullable() })),
  /** Cells may be written now (the revision a draft, the spec DRAFT); else `refusal` says why. */
  editable: z.boolean(),
  refusal: z.string().nullable(),
  words: z.string(),
})
export type MeasurementSpecView = z.infer<typeof measurementSpecView>
