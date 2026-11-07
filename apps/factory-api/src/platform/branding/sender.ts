import type { FactoryClient } from '@nexus/factory-db'

/**
 * The name a company's mail to partners is sent under (B-W2b-161; PLT-228): its branding's sender name, when it has one,
 * in place of the sending identity's own display name. platform/email-out reads every partner mail's identity through
 * here: `sendingIdentity` (the From line written when a mail is queued, for every module's record mail) and the queued
 * mail's identity in `deliverOutbound` (the company's name under the signature). Office mail (sign-in, digests, exports)
 * keeps the identity's own name. Read in the office or system scope, as the identity itself (the email tables and the
 * branding are both office-only).
 */
export async function brandedIdentity<Identity extends { readonly companyId: string; readonly displayName: string }>(client: Pick<FactoryClient, 'companyBranding'>, identity: Identity): Promise<Identity> {
  const branding = await client.companyBranding.findUnique({ where: { id: identity.companyId }, select: { companyId: true, senderDisplayName: true } })
  return branding && branding.companyId === identity.companyId && branding.senderDisplayName ? { ...identity, displayName: branding.senderDisplayName } : identity
}
