import type { WorkCentreKind } from '../../product/routing/operations'

/**
 * A department of the factory by the work centre kind a step stands on (owb- order workflow, PL-schema § 2). The Department
 * table (number, names, tone, icon, ONE WorkCentreKind each; seeded 1 Pattern … 9 Assembly) is the truth for every NEW route
 * step: `RoutingOperation.departmentId` is copied when the step is made and freezes with the revision. An OLD released
 * routing keeps `departmentId = null` (no backfill: a frozen row is never touched), so its steps show the department this
 * table gives their kind — the kind's default department until a new revision names one. Pure.
 *
 *   CUTTING → 2 Cutting (1 Pattern shares the kind; a step names Pattern only by its departmentId)
 *   SEWING → 4 Stitching · ASSEMBLY → 9 Assembly (8 Molding shares it) · FINISHING → 3 Patch & print (7 Design shares it)
 *   INSPECTION → 5 Quality · PACKING → 6 Packing · SUBCONTRACT → OUTSIDE (a step done by a workshop, no department here)
 */

export const OUTSIDE = 'OUTSIDE' as const
export type DepartmentOfKind = number | typeof OUTSIDE

export const DEPARTMENT_OF_KIND: Readonly<Record<WorkCentreKind, DepartmentOfKind>> = Object.freeze({
  CUTTING: 2,
  SEWING: 4,
  ASSEMBLY: 9,
  FINISHING: 3,
  INSPECTION: 5,
  PACKING: 6,
  SUBCONTRACT: OUTSIDE,
})

/** The default department number of a work centre kind, or OUTSIDE for a subcontracted step. */
export function departmentOfKind(kind: WorkCentreKind): DepartmentOfKind {
  return DEPARTMENT_OF_KIND[kind]
}
