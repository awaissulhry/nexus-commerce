import { CERTIFICATES_VIEW } from '../../compliance/certificates/permissions'
import type { Permission } from '../../core/permissions'

/**
 * The style compliance tab's permissions (B-W1-20; A2 SCR-045). Declared with their descriptions in
 * `auth/permissions/catalogue.ts` (COMPLIANCE_DEFINITIONS), checked with can() against the style's company (a
 * tenant-wide style is written only by a grant over every company).
 *
 * Reading reuses the certificate register's view permission: the tab is the style's certificate coverage, its PPE class
 * and the paperwork that cites the certificate, and whoever may see the register may see this. Writing is its own
 * permission: a signed EU Declaration of Conformity and the user information leaflet are the maker's declarations that
 * travel with the goods (Reg. (EU) 2016/425 art. 8(7)(8), art. 15), not a notified body's certificate, and the W2b
 * declaration generator (PRD-292) extends the same area.
 */

/** See a style's PPE class, its certificate coverage per colourway and size, its DoC and leaflet files. */
export const STYLE_COMPLIANCE_VIEW: Permission = CERTIFICATES_VIEW
/** Upload a style revision's signed DoC and user information leaflet per language, and replace them with a new version. */
export const DECLARATIONS_MANAGE = 'compliance.declarations.manage' satisfies Permission
