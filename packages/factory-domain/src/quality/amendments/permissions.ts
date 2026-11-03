import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Amendments of signed results (apps/factory-api modules/quality/amendments; B-W2b-123; QHS-145 "Locked results with
 * amendments"; design quality.inspections "Amend signed result" ins-amend and the Decision tab's "Amendments"), in the
 * quality area. A signed final inspection, a decided incoming inspection or a decided in-process check never changes: a
 * correction is a request with its reason, and it counts only once a second person signs it. Each record is checked with
 * can() against its company and site; seeing it stays the record's own view permission. Office only.
 *
 *   request   ask for a correction of a signed record (its note, a result's value or note, a measured value, a defect's
 *             zone, note, description or cause, a hide's note), with the reason; it waits for a second signature
 *   sign      sign or refuse a correction someone else asked (never one's own): signing needs a fresh step-up code
 */
export const QUALITY_AMENDMENTS_DEFINITIONS = definePermissions('quality', {
  'amendments.request': {
    risk: 'write',
    description:
      'Ask for a correction of a signed inspection or check (a note, a recorded value, a measured value, a defect\'s zone, description or cause) with the reason; nothing changes until a second person signs it.',
  },
  'amendments.sign': {
    risk: 'stepUp',
    description:
      'Sign or refuse a correction of a signed inspection or check that another person asked for (never one\'s own); signing asks for a fresh step-up code.',
  },
})

export const QUALITY_AMENDMENTS_REQUEST = 'quality.amendments.request' satisfies Permission
export const QUALITY_AMENDMENTS_SIGN = 'quality.amendments.sign' satisfies Permission

export const QUALITY_AMENDMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_AMENDMENTS_REQUEST, QUALITY_AMENDMENTS_SIGN])
