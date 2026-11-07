import { ConflictError } from '@nexus/factory-domain/core/errors'
import type { CommandTx } from '../../../core/command'
import { noticeInForce } from '../../privacy/read'

/**
 * GATE-PRIVACY for the portal (W2b-3 plan, gates; B-W2b-152 notes): live portal use waits for the company's published
 * portal terms (a PrivacyNotice of kind PORTAL_TERMS, published in Admin › Privacy). Enforced in three places:
 *
 *   1. sign-in (auth/portal/sign-in.ts): no portal session opens while the company whose portal it is has no PORTAL_TERMS
 *      notice in force — the person is told so in words after the code (every environment: local and test databases carry
 *      made-up terms, so the build goes on, and a live database without published terms lets nobody in);
 *   2. the first visit (auth/portal/account.ts): a session holds no permission until its person acknowledged the version in
 *      force (PartnerNoticeAck), and a newer published version asks again;
 *   3. invitations (B-W2b-162): the command that sends a PARTNER invitation calls `requirePortalTerms` first, so no
 *      invitation for live use goes out before the terms are published.
 */

export const PORTAL_TERMS_MISSING = 'The portal terms of this company are not published yet (Admin › Privacy & notices): nobody outside can sign in to its portal before they are.'

/** The company's PORTAL_TERMS notice in force, or null (any client of the office scope, or a command's transaction). */
export async function portalTermsInForce(db: Pick<CommandTx, 'privacyNotice'>, companyId: string) {
  return noticeInForce(db, companyId, 'PORTAL_TERMS')
}

/** For B-W2b-162's invitation command: a 409 in words while the company has no portal terms in force. */
export async function requirePortalTerms(db: Pick<CommandTx, 'privacyNotice'>, companyId: string): Promise<void> {
  if (!(await portalTermsInForce(db, companyId))) throw new ConflictError(PORTAL_TERMS_MISSING)
}
