import { z } from 'zod'
import { FREIGHT_BILLINGS, type FreightBilling } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import type { ApiClient } from '../../../../../lib/api/client'
import { previewLink } from '../../../../../record-panels/files/api'
import { companyTermsSchema, type CompanyTerms } from '../../depth/api'

/**
 * F-CT-203 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 13-backend §6.2; 18-lead-settles Z2, Z24) — the tab's own calls, beside
 * the depth provider's (holds, company terms, requirements) and the commercial terms' (`cu/terms/api.ts`, which stays):
 *   R19 readCarrierAccount    GET  /shipping/customer-carrier-accounts/:id   the carrier, whether an account is ON FILE (never the number)
 *   R20 setCarrierAccount     PUT  /shipping/customer-carrier-accounts/:id   ONE command at the party's version (a number typed is sealed)
 *   R5  setCompanyTerms       PUT  /parties/:id/company-terms/:companyId      a company's own payment terms, list, deposit, PO rule
 *   R6  endCompanyTerms       POST /parties/:id/company-terms/:companyId/end  the company goes back to the customer's terms
 *       fileDoor              GET  /files/:id/preview                         a requirement's file (files.read; 60 s)
 * Answers are checked by the page's own zod schemas (unknown fields dropped); every write names the version it read and carries the
 * Idempotency-Key of its attempt.
 */

const enc = encodeURIComponent

/** The customer's carrier block (R19's answer; the server's words `freightBillingWords` are never drawn). */
export const carrierAccountSchema = z.object({
  partyId: z.string(),
  code: z.string(),
  name: z.string(),
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  accountOnFile: z.boolean(),
  freightBilling: z.enum(FREIGHT_BILLINGS),
  defaultCarrierService: z.string().nullable(),
  version: z.number(),
})
export type CarrierAccount = z.infer<typeof carrierAccountSchema>

/** R19: the customer's carrier, its default service, who pays the freight, and whether an account is on file (parties.view). */
export async function readCarrierAccount(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<CarrierAccount> {
  return (await api.get(`/shipping/customer-carrier-accounts/${enc(partyId)}`, { schema: z.object({ account: carrierAccountSchema }), ...(signal ? { signal } : {}) })).account
}

export interface CarrierAccountBody {
  /** The party's version (the edit guard of the carrier columns). */
  readonly version: number
  /** null clears the carrier (and the account and service with it); absent keeps it. */
  readonly carrierCode?: string | null
  /** A new number (sealed, the old one deleted); null removes it; absent keeps it. */
  readonly accountNumber?: string | null
  readonly freightBilling?: FreightBilling
  readonly defaultCarrierService?: string | null
}

/** R20: ONE command (parties.manage). The answer says the new number's last four characters once (`endsIn`), never again. */
export async function setCarrierAccount(api: ApiClient, partyId: string, body: CarrierAccountBody, key: string): Promise<{ account: CarrierAccount; endsIn: string | null }> {
  return api.request('PUT', `/shipping/customer-carrier-accounts/${enc(partyId)}`, { body, schema: z.object({ account: carrierAccountSchema, endsIn: z.string().nullable() }), idempotencyKey: key })
}

export interface CompanyTermsBody {
  /** The company's live row's version; absent: make the row. */
  readonly version?: number
  readonly paymentTermsId?: string | null
  readonly priceListId?: string | null
  readonly depositPct?: string | null
  readonly poNumberRequired?: boolean
}

/** R5: a company's own terms with this customer, made or changed at its version (parties.manage over the party AND the company). */
export async function setCompanyTerms(api: ApiClient, partyId: string, companyId: string, body: CompanyTermsBody, key: string): Promise<CompanyTerms> {
  return (await api.request('PUT', `/parties/${enc(partyId)}/company-terms/${enc(companyId)}`, { body, schema: companyTermsSchema, idempotencyKey: key })).terms
}

/** R6: the company goes back to the customer's own terms (a 409 while a credit limit is set on its row: never offered then). */
export async function endCompanyTerms(api: ApiClient, partyId: string, companyId: string, body: { readonly version: number }, key: string): Promise<CompanyTerms> {
  return (await api.post(`/parties/${enc(partyId)}/company-terms/${enc(companyId)}/end`, { body, schema: companyTermsSchema, idempotencyKey: key })).terms
}

/** A requirement's file as a door: the preview link of the customer's file (files.read), read on the click (60 seconds). */
export async function fileDoor(api: ApiClient, fileId: string): Promise<string> {
  return (await previewLink(api, fileId)).preview.url
}
