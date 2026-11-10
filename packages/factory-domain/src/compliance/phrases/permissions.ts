import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The phrase library (B-W2b-249; PRD-343; design compliance.settings › Phrases & translations, compliance.labels ›
 * Languages). Office only (area `compliance`). Reading is compliance.certificates.view (as the labels). Two writes, so
 * that a translation is approved by a second person who may approve (the database also refuses the author):
 *
 *   phrases.manage    add a phrase (key, kind, source words), change its source words (the next revision: every approved
 *                     translation is then stale until translated again), archive it, and propose a translation (a draft)
 *                     or withdraw a draft. The quality inspector and the production manager (who writes instructions).
 *   phrases.approve   approve a proposed translation of the phrase's current words (never one's own proposal); the
 *                     approved one before it is superseded. The quality inspector; the owner from every().
 */
export const PHRASES_DEFINITIONS = definePermissions('compliance', {
  'phrases.manage': {
    risk: 'write',
    description: 'Add phrases to the library (warnings, care, marking, DoC, user information, claims), change their source words, archive them, and propose or withdraw a translation.',
  },
  'phrases.approve': {
    risk: 'write',
    description: "Approve a proposed translation of a phrase's current words (never one's own proposal); the translation approved before it is superseded.",
  },
})

export const PHRASES_MANAGE = 'compliance.phrases.manage' satisfies Permission
export const PHRASES_APPROVE = 'compliance.phrases.approve' satisfies Permission

export const PHRASES_PERMISSIONS: readonly Permission[] = Object.freeze([PHRASES_MANAGE, PHRASES_APPROVE])

/** Who holds them (auth/roles/templates). */
export const PHRASES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [PHRASES_MANAGE, PHRASES_APPROVE],
  production_manager: [PHRASES_MANAGE],
})
