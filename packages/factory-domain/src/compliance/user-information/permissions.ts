import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * The user information builder (B-W2b-258; PRD-350 to PRD-354; design compliance.declarations, the user-information kind).
 * Office only (area `compliance`). Reading the leaflets, their sections and sources, the language packs per market and the
 * versions per batch reuses the certificate register's view permission (as the DoC generator, W1's style compliance tab and
 * the labels do). The signed leaflet stays W1's (`compliance.declarations.manage` uploads it; GATE-PPE-TEXTS) and recording
 * which signed leaflet went with which batch is the DoC generator's (B-W2b-257). Two new writes:
 *
 *   userInformation.generate  make a generated user-information draft of a style revision from its records (Annex II 1.4:
 *                             every section with where its words came from, the protector positions, the spare
 *                             protectors that fit), refresh it, type a section's words, start its translations (a market's
 *                             language pack) from the phrase library, move a translation between draft and in
 *                             translation, withdraw a draft. A generated leaflet stays a draft until GATE-PPE-TEXTS (the
 *                             database refuses anything else). The quality inspector; the owner from every().
 *   userInformation.check     check a translation (a second person: never its author nor anyone who typed its words). The
 *                             quality inspector.
 */
export const USER_INFORMATION_DEFINITIONS = definePermissions('compliance', {
  'userInformation.generate': {
    risk: 'write',
    description:
      "Make a generated user-information draft of a style revision from its records (every Annex II 1.4 section with its source, the protector positions, the spare protectors that fit), refresh it, type a section's words, start its translations for a market's language pack and type their words, withdraw a draft. A generated leaflet stays a draft until a PPE consultant has checked the texts.",
  },
  'userInformation.check': {
    risk: 'write',
    description: "Check a generated user-information translation (never one's own nor one whose words one typed).",
  },
})

/** Read the leaflets, their sources, the language packs and the versions per batch (the certificate register's view). */
export const USER_INFORMATION_VIEW: Permission = CERTIFICATES_VIEW
export const USER_INFORMATION_GENERATE = 'compliance.userInformation.generate' satisfies Permission
export const USER_INFORMATION_CHECK = 'compliance.userInformation.check' satisfies Permission

export const USER_INFORMATION_PERMISSIONS: readonly Permission[] = Object.freeze([USER_INFORMATION_GENERATE, USER_INFORMATION_CHECK])

/** Who holds them (auth/roles/templates). */
export const USER_INFORMATION_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [USER_INFORMATION_GENERATE, USER_INFORMATION_CHECK],
})
