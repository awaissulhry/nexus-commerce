import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * The DoC generator (B-W2b-257; PRD-292, PRD-293, PRD-295, PRD-300; design compliance.declarations). Office only (area
 * `compliance`). Reading the declarations, their sources, the language coverage and the versions by batch reuses the
 * certificate register's view permission (as W1's style compliance tab, the labels and Rules & markets do). W1's
 * `compliance.declarations.manage` (upload the signed DoC and leaflet) also records which signed revision went with which
 * batch and shipment: the signed document is the live one (GATE-PPE-TEXTS). Three new writes:
 *
 *   declarations.generate  make a generated DoC draft of a style revision from its records (Annex IX: every point with
 *                          where its value came from), refresh it from the records, type a point's words, start its
 *                          translations from the phrase library, type a translation's words and move it between draft and
 *                          in translation, withdraw a draft. A generated DoC stays a draft until GATE-PPE-TEXTS (the
 *                          database refuses anything else). The quality inspector; the owner from every().
 *   declarations.check     check a translation (a second person: never its author nor anyone who typed its words), or
 *                          undo the check to change its words. The quality inspector.
 *   declarations.pack      build a shipment's compliance pack (PRD-300): its signed DoCs and leaflets, the certificate
 *                          summary and the batches with their public DoC addresses, as one PDF (kept) and one ZIP, and
 *                          share the PDF with the shipment's party. The warehouse (the documents go with the goods) and the
 *                          quality inspector.
 */
export const DECLARATIONS_DEFINITIONS = definePermissions('compliance', {
  'declarations.generate': {
    risk: 'write',
    description:
      "Make a generated EU Declaration of Conformity draft of a style revision from its records (every Annex IX point with its source), refresh it, type a point's words, start its translations from the phrase library and type their words, withdraw a draft. A generated DoC stays a draft until a PPE consultant has checked the texts.",
  },
  'declarations.check': {
    risk: 'write',
    description: "Check a generated DoC's translation (never one's own nor one whose words one typed), or undo the check to change its words.",
  },
  'declarations.pack': {
    risk: 'write',
    description: "Build a shipment's compliance pack (its signed DoCs and leaflets, the certificate summary, the batches with their public DoC addresses) as a PDF and a ZIP, and share the PDF with the shipment's customer.",
  },
})

/** Read declarations, their sources, the language coverage, the versions by batch (the certificate register's view). */
export const DECLARATIONS_VIEW: Permission = CERTIFICATES_VIEW
/** W1's: upload the signed DoC and leaflet; here also record which signed revision went with which batch and shipment. */
export const DECLARATIONS_RECORD = 'compliance.declarations.manage' satisfies Permission
export const DECLARATIONS_GENERATE = 'compliance.declarations.generate' satisfies Permission
export const DECLARATIONS_CHECK = 'compliance.declarations.check' satisfies Permission
export const DECLARATIONS_PACK = 'compliance.declarations.pack' satisfies Permission

export const DECLARATIONS_PERMISSIONS: readonly Permission[] = Object.freeze([DECLARATIONS_GENERATE, DECLARATIONS_CHECK, DECLARATIONS_PACK])

/** Who holds them (auth/roles/templates). */
export const DECLARATIONS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [DECLARATIONS_GENERATE, DECLARATIONS_CHECK, DECLARATIONS_PACK],
  warehouse: [DECLARATIONS_PACK],
})
