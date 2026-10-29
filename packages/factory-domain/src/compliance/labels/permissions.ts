import type { Permission } from '../../core/permissions'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * The garment label builder's permissions (B-W1-19; A2 SCR-053 "Labels & marking"). Declared with their descriptions in
 * `auth/permissions/catalogue.ts` (COMPLIANCE_DEFINITIONS), checked with can() against the label template's company (a
 * tenant-wide template, company null, is written only by a grant over every company).
 *
 * Reading reuses the certificate register's view permission, as the style compliance tab does (B-W1-20): the label is
 * the marking of the certificate's class on the style, and whoever may see the register and the tab may see the label
 * that prints them. Writing is its own permission: the label is the maker's marking under Reg. (EU) 2016/425 art. 8(5)(6)
 * and art. 17, built once and frozen when activated.
 */

/** See the label templates, their revisions, rule checks and who uses them; preview a label for a style, colourway and size. */
export const LABELS_VIEW: Permission = CERTIFICATES_VIEW
/** Build label templates (DRAFT), activate, retire and revise them, print a test label, and name one on a draft style revision. */
export const LABELS_MANAGE = 'compliance.labels.manage' satisfies Permission
