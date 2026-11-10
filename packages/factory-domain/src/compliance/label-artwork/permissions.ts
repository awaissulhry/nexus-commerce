import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { LABELS_MANAGE, LABELS_VIEW } from '../labels/permissions'

/**
 * Label artwork, label lines and the label reconciliation (B-W2b-259; PRD-347, PRD-088, MES-140). One new permission:
 *
 *   artwork.approve   approve a label's artwork proof that someone else made (PRD-347: "approval by someone who is not
 *                     the author"; the database refuses the author too). Approving a version retires the one approved
 *                     before for the same label revision: one approved proof per label revision.
 *
 * Reading the artwork is the label's view (the certificate register's, as W1's labels); adding a draft proof, retiring one
 * and removing a draft is building the label (compliance.labels.manage). The label lines in the BOM are the BOM's
 * (product.bom.view | manage); the reconciliation and Log spoiled labels are the garment label step's (production.serials,
 * floor and office) and the work order's view (workorders.view, office). The quality inspector approves; the owner from
 * every().
 */
export const LABEL_ARTWORK_DEFINITIONS = definePermissions('compliance', {
  'artwork.approve': {
    risk: 'write',
    description: "Approve a label's artwork proof made by someone else (a second person); approving retires the proof approved before for the same label revision.",
  },
})

export const ARTWORK_VIEW: Permission = LABELS_VIEW
export const ARTWORK_MANAGE: Permission = LABELS_MANAGE
export const ARTWORK_APPROVE = 'compliance.artwork.approve' satisfies Permission

export const LABEL_ARTWORK_PERMISSIONS: readonly Permission[] = Object.freeze([ARTWORK_APPROVE])

/** Who holds it (auth/roles/templates): the quality inspector, beside compliance.labels.manage. */
export const LABEL_ARTWORK_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [ARTWORK_APPROVE],
})
