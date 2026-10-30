import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Carriers & shipping (SCR-068), with the answer's shape checked (zod; unknown fields are dropped, so a
 * new API field never breaks the page). The shapes mirror apps/factory-api modules/shipping/settings (a site's shipping
 * settings, saved whole), platform/print (the site's printers) and platform/admin/connections (the Sendcloud accounts:
 * only for a person who holds integrations.view). No money anywhere. The API's English words are never drawn: the page
 * says its own words from the issue paths.
 */

export const TRANSPORT_BY = ['SENDER', 'RECIPIENT', 'CARRIER'] as const
export type TransportBy = (typeof TRANSPORT_BY)[number]
export const PRINTER_KINDS = ['LABEL_ZPL', 'A4_PDF'] as const
export type PrinterKind = (typeof PRINTER_KINDS)[number]
export const PRINTER_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const
export const ACCOUNT_MODES = ['LIVE', 'SANDBOX', 'FAKE'] as const
export type AccountMode = (typeof ACCOUNT_MODES)[number]
export const ACCOUNT_STATUSES = ['ACTIVE', 'PAUSED', 'DISABLED'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

const text = z.string()
const optionalText = z.string().nullable().optional()

/** An address as the settings keep it (ShippingSettings.senderAddress / returnAddress). */
export const addressSchema = z.object({
  name: text.optional().default(''),
  line1: text.optional().default(''),
  line2: optionalText,
  postalCode: text.optional().default(''),
  city: text.optional().default(''),
  province: optionalText,
  country: text.optional().default(''),
  phone: optionalText,
  email: optionalText,
})
export type ShippingAddress = z.infer<typeof addressSchema>

export const settingsSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  companyId: z.string(),
  senderAddress: addressSchema,
  returnAddress: addressSchema.nullable(),
  integrationAccountId: z.string().nullable(),
  defaultCarrierCode: z.string().nullable(),
  defaultServiceCode: z.string().nullable(),
  defaultTransportBy: z.enum(TRANSPORT_BY),
  defaultGoodsAppearance: z.string().nullable(),
  labelPrinterId: z.string().nullable(),
  documentPrinterId: z.string().nullable(),
  cutOffTime: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
})
export type ShippingSettings = z.infer<typeof settingsSchema>

export const siteSettingsSchema = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }),
  /** null: the site has no shipping settings yet. */
  settings: settingsSchema.nullable(),
})
export type SiteSettings = z.infer<typeof siteSettingsSchema>

/** GET /shipping/settings (shipping.settings.view): every site the person's grants reach in the company, with its settings. */
export function listSiteSettings(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<SiteSettings[]> {
  return api.get('/shipping/settings', { query: { companyId: companyId ?? undefined }, schema: z.object({ sites: z.array(siteSettingsSchema) }), signal }).then((answer) => answer.sites)
}

/** What PUT /shipping/settings/:siteId takes: the settings WHOLE (a field left out is cleared). */
export interface SaveBody {
  version?: number
  senderAddress: SaveAddress
  returnAddress: SaveAddress | null
  integrationAccountId: string | null
  defaultCarrierCode: string | null
  defaultServiceCode: string | null
  defaultTransportBy: TransportBy
  defaultGoodsAppearance: string | null
  labelPrinterId: string | null
  documentPrinterId: string | null
  cutOffTime: string | null
}

export interface SaveAddress {
  name: string
  line1: string
  line2: string | null
  postalCode: string
  city: string
  province: string | null
  country: string
  phone: string | null
  email: string | null
}

/** PUT /shipping/settings/:siteId (shipping.settings.manage): 201 the first time, then 200; 409 when the version moved. */
export function saveSiteSettings(api: ApiClient, siteId: string, body: SaveBody, idempotencyKey: string = newIdempotencyKey()): Promise<SiteSettings> {
  return api.request('PUT', `/shipping/settings/${encodeURIComponent(siteId)}`, { body, schema: siteSettingsSchema, idempotencyKey })
}

// ---- the site's printers (print.view) ------------------------------------------------------------------------------------

export const printerSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(PRINTER_KINDS),
  status: z.enum(PRINTER_STATUSES),
})
export type Printer = z.infer<typeof printerSchema>

/** GET /print/printers?siteId= (print.view): the site's printers that are not archived. */
export function listPrinters(api: ApiClient, siteId: string, signal?: AbortSignal): Promise<Printer[]> {
  return api.get('/print/printers', { query: { siteId }, schema: z.object({ printers: z.array(printerSchema) }), signal }).then((answer) => answer.printers)
}

// ---- the Sendcloud accounts (integrations.view) --------------------------------------------------------------------------

export const accountSchema = z.object({
  id: z.string(),
  /** Null: tenant-wide. */
  companyId: z.string().nullable(),
  provider: z.string(),
  code: z.string(),
  label: z.string(),
  mode: z.enum(ACCOUNT_MODES),
  status: z.enum(ACCOUNT_STATUSES),
  credentials: z.object({ saved: z.boolean(), savedAt: z.string().nullable() }),
  lastOkAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
})
export type CarrierAccount = z.infer<typeof accountSchema>

/** GET /integrations/accounts?provider=SENDCLOUD (integrations.view): the carrier accounts the person's grants reach. */
export function listCarrierAccounts(api: ApiClient, signal?: AbortSignal): Promise<CarrierAccount[]> {
  return api.get('/integrations/accounts', { query: { provider: 'SENDCLOUD' }, schema: z.object({ accounts: z.array(accountSchema) }), signal }).then((answer) => answer.accounts)
}
