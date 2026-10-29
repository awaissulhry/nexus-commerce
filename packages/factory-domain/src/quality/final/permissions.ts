import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The final inspection and release of finished garments (apps/factory-api modules/quality/final; B-W1-45; QHS-050,
 * QHS-051, QHS-058, QHS-073, QHS-300, PLT-097; A2 SCR-075 Inspections, SCR-076 Inspection report, SCR-097 floor final
 * inspection), in the quality area. Each is checked with can() against the work order's company and site (and the cell's
 * customer); a floor device works at its own site only (can() pins it, row-level security too).
 *
 * Signing is a signing act: the decision of an inspection and a release ask the office's step-up (a fresh 6-digit code)
 * or, on the floor, the PIN (requireFloorStepUp). A reversal only protects (design ins-reverse): it asks for neither, and
 * is the office's. The four-eyes rule itself (Owner answer Q1) is quality.settings.manage (B-W1-34's): loosening it asks
 * for a reason and a fresh code.
 */
export const QUALITY_FINAL_DEFINITIONS = definePermissions('quality', {
  'inspections.view': {
    risk: 'read',
    description:
      "See final inspections with their defects and decisions, the garments released and taken back, a work order's release gate in words (who made the garments, labels, certificate, documents, lots on hold), and the evidence trail of a garment serial or a batch.",
  },
  'inspections.record': {
    risk: 'write',
    description:
      "Open a final inspection of a work order's finished garments, record its sample, garment and label checklist and defects, and sign the result (an override of the computed result only with a written reason) — never as a maker of the garments; a floor device at its own site, with the PIN.",
  },
  'garments.release': {
    risk: 'write',
    description:
      'Release inspected garments to be packed and shipped, with an e-signature: only when the certificate gate, the garment labels, the material lots and the DoC allow it; never garments one made, and as the second person where the four-eyes rule asks one (a floor device at its own site, with the PIN).',
  },
  'garments.reverse': {
    risk: 'write',
    description:
      'Take released garments back before they ship (corrective action) with the reason; their serials go back to rework or are scrapped, and a PPE register entry opens for the garments.',
  },
})

export const QUALITY_INSPECTIONS_VIEW = 'quality.inspections.view' satisfies Permission
export const QUALITY_INSPECTIONS_RECORD = 'quality.inspections.record' satisfies Permission
export const QUALITY_GARMENTS_RELEASE = 'quality.garments.release' satisfies Permission
export const QUALITY_GARMENTS_REVERSE = 'quality.garments.reverse' satisfies Permission

export const QUALITY_FINAL_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_INSPECTIONS_VIEW, QUALITY_INSPECTIONS_RECORD, QUALITY_GARMENTS_RELEASE, QUALITY_GARMENTS_REVERSE])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the bench's final inspection and release at its own site. */
export const QUALITY_FINAL_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([QUALITY_INSPECTIONS_VIEW, QUALITY_INSPECTIONS_RECORD, QUALITY_GARMENTS_RELEASE])
