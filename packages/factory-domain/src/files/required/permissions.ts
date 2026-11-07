import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Required documents (COL-048; B-W2b-177; design admin.documents › Required documents): which documents a record type must
 * have before a status move, per company, and whether a missing one blocks the move or only warns. Reading the rules is
 * documents.view (the page's own permission); changing them is this permission, checked with can() against the rule's
 * company. A rule is switched off, never deleted. What a record has and lacks is files.read (the record's Files panel).
 */
export const REQUIRED_DOCUMENTS_DEFINITIONS = definePermissions('documents', {
  'required.manage': {
    risk: 'write',
    description: 'Say which documents a record type must have before a status move (a supplier certificate before a purchase order is confirmed), whether a missing one blocks the move or only warns, and switch a rule off.',
  },
})

export const REQUIRED_DOCUMENTS_MANAGE = 'documents.required.manage' satisfies Permission

export const REQUIRED_DOCUMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([REQUIRED_DOCUMENTS_MANAGE])
