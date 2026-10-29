import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The quality step's permissions for incoming lots (apps/factory-api modules/quality/lab; B-W1-34; QHS-029, QHS-030,
 * SCM-117, QHS-073; A2 SCR-054 Tests & substances, SCR-075 Lot release), in the quality area. Each is checked with can()
 * against the lot's company and site. Office only: a floor device never releases a lot (A1 §2.5 "Lot").
 *
 * Releasing is the quality role's (design answer W3, Owner question Q14): a person who holds quality.lots.release, who
 * is not the person who received the lot, and who types the lot's code. Changing the Cr VI evidence rule is
 * quality.settings.manage; loosening it (a lab report for every lot → a supplier report covering the article and the
 * period) also asks for a fresh code (the API's requireStepUp), tightening never does.
 */
export const QUALITY_LAB_DEFINITIONS = definePermissions('quality', {
  'lots.view': {
    risk: 'read',
    description: "See a lot's quality record: its chromium VI results with their reports, its supplier documents, the release checklist with each open check in words, and the Cr VI evidence rule in force.",
  },
  'lots.test': { risk: 'write', description: "Record a lot's chromium VI result with the lab's or the supplier's report (the verdict is computed against the lot's limit, never typed)." },
  'lots.documents': { risk: 'write', description: "Attach a lot's supplier documents: the PPE component's certificate or declaration, the LWG certificate, a fabric test report." },
  'lots.release': {
    risk: 'write',
    description: 'Release a lot in quarantine when every check passes (typing its code; never a lot one received oneself), clear the hold the receiver placed, and release a blocked lot again.',
  },
  'lots.reject': { risk: 'write', description: 'Reject a lot (final: back to the supplier or scrapped; typing its code), and block a released lot, with the reason.' },
  'settings.manage': { risk: 'write', description: 'Change what counts as chromium VI evidence (Q14): a supplier report covering the article and the period, or a lab report for every lot (loosening asks for a fresh code).' },
})

export const QUALITY_LOTS_VIEW = 'quality.lots.view' satisfies Permission
export const QUALITY_LOTS_TEST = 'quality.lots.test' satisfies Permission
export const QUALITY_LOTS_DOCUMENTS = 'quality.lots.documents' satisfies Permission
export const QUALITY_LOTS_RELEASE = 'quality.lots.release' satisfies Permission
export const QUALITY_LOTS_REJECT = 'quality.lots.reject' satisfies Permission
export const QUALITY_SETTINGS_MANAGE = 'quality.settings.manage' satisfies Permission

export const QUALITY_LAB_PERMISSIONS: readonly Permission[] = Object.freeze([
  QUALITY_LOTS_VIEW,
  QUALITY_LOTS_TEST,
  QUALITY_LOTS_DOCUMENTS,
  QUALITY_LOTS_RELEASE,
  QUALITY_LOTS_REJECT,
  QUALITY_SETTINGS_MANAGE,
])
