import type { Permission } from '../../core/permissions'

/**
 * The certificate register's permissions (plan A1 §3.11; QHS-103). Declared with their descriptions in
 * `auth/permissions/catalogue.ts` (COMPLIANCE_DEFINITIONS), checked with can() against the certificate's company and
 * holder party (a brand-held certificate has no company: every company of the tenant).
 */

/** See the certificates, their coverage and their expiry; ask the certificate gate whether a garment is covered. */
export const CERTIFICATES_VIEW = 'compliance.certificates.view' satisfies Permission
/** Type in, register, suspend, reinstate and withdraw certificates; record and end what they cover. */
export const CERTIFICATES_MANAGE = 'compliance.certificates.manage' satisfies Permission

export const CERTIFICATES_PERMISSIONS = [CERTIFICATES_VIEW, CERTIFICATES_MANAGE] as const
