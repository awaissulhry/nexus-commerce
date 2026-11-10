import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { CERTIFICATES_VIEW } from '../certificates/permissions'

/**
 * Technical files (B-W2b-251; PRD-296, PRD-299, PRD-301, PRD-302, QHS-048, QHS-110; design compliance.techfiles, SCR-120;
 * PPE Reg. (EU) 2016/425 Annex III, art. 8(3) and (9)). Office only (area `compliance`). Reading the technical files, their
 * Annex III evidence, the risk assessments, the production-control tests, conformity to type per batch and the evidence
 * packs reuses the certificate register's view permission (as Rules & markets and the labels do): the same people read the
 * certificates the files support. Checked with can() against the record's company (a company is a column here, not a policy
 * key: the API keeps staff to their companies).
 *
 *   techfiles.manage  keep a style's technical file: open it (numbered from the company's TECHNICAL_FILE series), name the
 *                     certificate it supports and who keeps it, link each Annex III point's evidence (a record or a file,
 *                     never a copy), review it or mark a point not applicable (the reviewer is recorded), complete,
 *                     reopen and archive the file; draft the product risk assessment and its hazards; plan and record
 *                     production-control tests with their lab report; build an evidence pack.
 *   techfiles.sign    sign a product risk assessment with one's typed name and function, with a fresh code (step-up): a
 *                     signing act (it supersedes the revision signed before).
 *   techfiles.share   send a built evidence pack to an authority or a customer by a DOCUMENT_VIEW link with a password and
 *                     an end date, with a fresh code (step-up), and withdraw such a link.
 *
 * The quality inspector holds all three; the owner from every().
 */
export const TECHFILES_DEFINITIONS = definePermissions('compliance', {
  'techfiles.manage': {
    risk: 'write',
    description:
      "Keep a style's technical file (PPE Reg. Annex III): open it, name its certificate and keeper, link each point's evidence (a record or a file, never a copy), review it or mark a point not applicable, complete, reopen and archive it; draft the product risk assessment; plan and record production-control tests with their lab report; build evidence packs.",
  },
  'techfiles.sign': {
    risk: 'stepUp',
    description: 'Sign a product risk assessment yourself, with your typed name and function and a fresh code from your authenticator app; it supersedes the revision signed before.',
  },
  'techfiles.share': {
    risk: 'stepUp',
    description: 'Send a built evidence pack to a market surveillance authority or a customer by a read-only link with a password and an end date (with a fresh code), and withdraw such a link.',
  },
})

/** Reading: the certificate register's view permission. */
export const TECHFILES_VIEW: Permission = CERTIFICATES_VIEW
export const TECHFILES_MANAGE = 'compliance.techfiles.manage' satisfies Permission
export const TECHFILES_SIGN = 'compliance.techfiles.sign' satisfies Permission
export const TECHFILES_SHARE = 'compliance.techfiles.share' satisfies Permission

export const TECHFILES_PERMISSIONS: readonly Permission[] = Object.freeze([TECHFILES_MANAGE, TECHFILES_SIGN, TECHFILES_SHARE])

/** Who holds them (auth/roles/templates): the quality inspector, beside compliance.certificates.manage. */
export const TECHFILES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [TECHFILES_MANAGE, TECHFILES_SIGN, TECHFILES_SHARE],
})
