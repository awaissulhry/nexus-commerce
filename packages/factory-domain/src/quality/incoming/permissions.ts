import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The incoming inspection of a lot, hide by hide (apps/factory-api modules/quality/incoming; B-W2b-98; QHS-025, QHS-028,
 * QHS-034, MES-054; B-W2b-111: rolls, components and goods back from a workshop, QHS-032, QHS-033, QHS-036; design
 * floor.incoming SCR-175, quality.inspections "Incoming"), in the quality area. Each is checked
 * with can() against the lot's company and site; a floor device works at its own site only (can() pins it, row-level
 * security too). The decision is a signing act: the office's step-up (a fresh 6-digit code) or, on the floor, the PIN.
 *
 * Neither releases the lot: a lot is released or rejected by a person with the quality role who types its code, never the
 * person who received it (Owner answer W3; quality.lots.release | reject, B-W1-34), after the inspection is decided.
 */
export const QUALITY_INCOMING_DEFINITIONS = definePermissions('quality', {
  'incoming.view': {
    risk: 'read',
    description:
      'See the incoming inspections of lots and of goods back from a workshop: the sample of whole hides (area against the tannery, shade group, grade, defect marks), fabric rolls by the 4-point system, component checks against spec and certificate, the plan checks, and the decision (accepted, rejected, to sort).',
  },
  'incoming.record': {
    risk: 'write',
    description:
      'Open an incoming inspection of a lot or of goods back from a workshop on its approved plan, record the sample (hide by hide, fabric rolls by the 4-point system, components against spec and certificate, the defect counter), answer the plan checks, and sign the decision (accepted, rejected and to sort adding up to the lot; for a workshop, the bundles rejected) — a floor device at its own site, with the PIN. It never releases or rejects the lot itself.',
  },
})

export const QUALITY_INCOMING_VIEW = 'quality.incoming.view' satisfies Permission
export const QUALITY_INCOMING_RECORD = 'quality.incoming.record' satisfies Permission

export const QUALITY_INCOMING_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_INCOMING_VIEW, QUALITY_INCOMING_RECORD])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the inspection tablet at the dock, at its own site. */
export const QUALITY_INCOMING_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_INCOMING_VIEW, QUALITY_INCOMING_RECORD])
