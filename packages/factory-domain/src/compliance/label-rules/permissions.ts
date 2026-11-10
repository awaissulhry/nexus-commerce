import type { Permission } from '../../core/permissions'
import { LABELS_MANAGE, LABELS_VIEW } from '../labels/permissions'

/**
 * What a PPE label must say (B-W2b-253): no permission of its own. The checks are the label's Rule checks (design
 * compliance.labels › lb-checks), so reading them is reading the label (the certificate register's view, as W1's label
 * builder and B-W2b-208's textile checks); setting a draft label's kind, GPSR contact and QR is editing the label
 * (compliance.labels.manage over its company; a tenant-wide label: a grant over every company).
 */

/** Read a label's marking checks and what it must print, per market. */
export const LABEL_RULES_VIEW: Permission = LABELS_VIEW
/** Set a draft label's kind, GPSR contact and QR target. */
export const LABEL_RULES_MANAGE: Permission = LABELS_MANAGE
