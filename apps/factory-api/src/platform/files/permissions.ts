import type { Permission } from '@nexus/factory-domain/core/permissions'

/**
 * The files platform's permissions (plan A1 §3.11), each checked with can() against the file's company (and, for a
 * floor or partner caller, the site or party it is shared with). Declared here until the roles step assembles every
 * module's list; they are not in the office owner's placeholder grants (platform/auth/sessions/grants.ts).
 */

/** See a record's files and download them (office, floor, portal and link sessions, each within what is shared). */
export const FILES_READ = 'files.read' satisfies Permission
/** Upload a file to a record and confirm the upload. */
export const FILES_UPLOAD = 'files.upload' satisfies Permission
/** Delete a file (refused while it is retained or on legal hold). */
export const FILES_DELETE = 'files.delete' satisfies Permission
/** Share a file with a floor, a portal or links; set its retention date and legal hold. */
export const FILES_MANAGE = 'files.manage' satisfies Permission

export const FILES_PERMISSIONS = [FILES_READ, FILES_UPLOAD, FILES_DELETE, FILES_MANAGE] as const
