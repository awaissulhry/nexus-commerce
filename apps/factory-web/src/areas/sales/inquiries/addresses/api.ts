import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * B-TH-285 (threads plan TH-8; O-SAL-INQ-LIST.band-F04/F05, L2-G09; the API is B-W2b-394): the inquiry addresses of Incoming's ⋯ —
 * the addresses whose mail becomes a request by itself — and what the band needs to say whether that door is open yet.
 *
 *   GET /sales/inquiries/addresses?companyId   in force for a company (its own list, else the tenant-wide one), sales.inquiries.view
 *   PUT /sales/inquiries/addresses             a company's own list, or the tenant-wide one, at the version read (sales.settings.manage)
 *   GET /email/identities                      the receiving domains (each identity's reply domain; email.send): an address
 *                                              elsewhere never reaches the factory
 *   GET /integrations/accounts?provider=SES    whether mail is received live (integrations.view): until then the door is not open
 *
 * Every answer is checked against its shape (zod drops unknown fields); the API's English is never shown (model.ts says the words).
 */

const addressesAnswer = z.object({
  addresses: z.array(z.string()),
  source: z.enum(['COMPANY', 'TENANT', 'NONE']),
  version: z.number().int().nullable(),
  hasOwnSettings: z.boolean(),
  mayManage: z.boolean(),
})
export type AddressesAnswer = z.infer<typeof addressesAnswer>

/** The addresses in force for a company (`companyId`), or the tenant-wide list (no `companyId`). */
export function readAddresses(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<AddressesAnswer> {
  return api.get('/sales/inquiries/addresses', { query: { companyId: companyId ?? undefined }, schema: addressesAnswer, signal })
}

/** Saves a company's own list (`companyId`) or the tenant-wide one, at the version read (none: the first save of the tenant's list). */
export function saveAddresses(api: ApiClient, body: { companyId: string | null; version: number | null; addresses: readonly string[] }, idempotencyKey: string = newIdempotencyKey()): Promise<AddressesAnswer> {
  return api.request('PUT', '/sales/inquiries/addresses', {
    body: { ...(body.companyId ? { companyId: body.companyId } : {}), ...(body.version !== null ? { version: body.version } : {}), addresses: [...body.addresses] },
    schema: addressesAnswer,
    idempotencyKey,
  })
}

const identities = z.object({ identities: z.array(z.object({ companyId: z.string(), replyDomain: z.string(), status: z.string() }).passthrough()) })

/** The receiving domains of a company (its sending identities' reply domains), lower case, each once. */
export async function receivingDomains(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<string[]> {
  const answer = await api.get('/email/identities', { schema: identities, signal })
  return [...new Set(answer.identities.filter((one) => companyId === null || one.companyId === companyId).map((one) => one.replyDomain.toLowerCase()))]
}

const accounts = z.object({ accounts: z.array(z.object({ provider: z.string(), mode: z.string(), status: z.string() }).passthrough()) })

/** Whether mail is received live: an ACTIVE SES account in LIVE mode (a FAKE or SANDBOX account receives nothing from outside). */
export async function receivingLive(api: ApiClient, signal?: AbortSignal): Promise<boolean> {
  const answer = await api.get('/integrations/accounts', { query: { provider: 'SES' }, schema: accounts, signal })
  return answer.accounts.some((account) => account.provider === 'SES' && account.mode === 'LIVE' && account.status === 'ACTIVE')
}
