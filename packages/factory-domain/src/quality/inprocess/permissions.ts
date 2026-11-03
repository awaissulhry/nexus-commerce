import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * In-process checks (apps/factory-api modules/quality/inprocess; B-W2b-99; QHS-039 first piece, QHS-040 cutting, QHS-041
 * roving, QHS-042 end of line and DHU, MES-127 a defect charged to its operation; design floor.inline SCR-176, floor.reasons
 * "Which operation caused it?"), in the quality area. A check is of a site and its company: each is checked with can()
 * against them; a floor device works at its own site only (can() pins it, row-level security too).
 *
 *   view     the checks of a line, a work order or an operation (per line and operation, never per person in a list),
 *            one check with its plan results, the line's DHU of a day, the defects charged to each operation, and
 *            whether a run waits for its first piece
 *   record   open a check (a first piece holds its run until one is approved), record its plan results and
 *            measurements, decide it (a first piece is signed: the floor's PIN or the office's fresh code), cancel an
 *            open one; record a roving result or an end-of-line pass or defect in one step
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): results are per line and operation. A check names its operator only
 * where the site's PERFORMANCE legal gate is in force, written by the API in the tenant's system scope; no list, filter,
 * group or total carries a person.
 */
export const QUALITY_INPROCESS_DEFINITIONS = definePermissions('quality', {
  'inprocess.view': {
    risk: 'read',
    description:
      "See the in-process checks (first piece, cutting, roving, end of line) of a line, a work order or an operation with their plan results, the line's DHU of a day, the defects charged to each operation and whether a run waits for its first piece; per line and operation, never per person.",
  },
  'inprocess.record': {
    risk: 'write',
    description:
      'Record in-process checks: open a first piece (its run waits until one is approved), a cutting or a roving check, record the plan results, decide and sign a first piece (PIN on the floor, a fresh code in the office), cancel an open check, record a roving result or an end-of-line pass or defect charged to the operation that caused it.',
  },
})

export const QUALITY_INPROCESS_VIEW = 'quality.inprocess.view' satisfies Permission
export const QUALITY_INPROCESS_RECORD = 'quality.inprocess.record' satisfies Permission

export const QUALITY_INPROCESS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_INPROCESS_VIEW, QUALITY_INPROCESS_RECORD])

/**
 * What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the floor inspector and the team leader check at their
 * own site (design floor.inline, modes inspection and supervisor).
 */
export const QUALITY_INPROCESS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_INPROCESS_VIEW, QUALITY_INPROCESS_RECORD])
