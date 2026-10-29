import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { TRANSPORT_BY } from '@nexus/factory-domain/shipping/shipments'

/**
 * A site's shipping settings (LOG-117; A2 SCR-068). The settings are saved whole (PUT): a field left out is cleared.
 * Carrier and service are data (Sendcloud's carrier code and shipping method, B-W1-48), never a hard-coded list.
 */

const text = (max: number) => z.string().trim().max(max)

export const shippingAddress = z.strictObject({
  name: text(120),
  line1: text(200),
  line2: text(200).nullish(),
  postalCode: text(20),
  city: text(120),
  province: text(40).nullish(),
  /** ISO 3166-1 alpha-2, capitals. */
  country: text(2),
  phone: text(40).nullish(),
  email: text(200).nullish(),
})

const settingsView = output({
  id: id(),
  siteId: id(),
  companyId: id(),
  senderAddress: z.record(z.string(), z.unknown()),
  returnAddress: z.record(z.string(), z.unknown()).nullable(),
  integrationAccountId: id().nullable(),
  defaultCarrierCode: z.string().nullable(),
  defaultServiceCode: z.string().nullable(),
  defaultTransportBy: z.enum(TRANSPORT_BY),
  defaultGoodsAppearance: z.string().nullable(),
  labelPrinterId: id().nullable(),
  documentPrinterId: id().nullable(),
  cutOffTime: z.string().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})
export type SettingsView = z.infer<typeof settingsView>

const siteSettings = output({
  site: output({ id: id(), companyId: id(), code: z.string(), name: z.string() }),
  /** null: the site has no shipping settings yet. */
  settings: settingsView.nullable(),
})

export const listSettingsContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ sites: z.array(siteSettings) }) },
})

export const getSettingsContract = defineContract({
  params: input({ siteId: id() }),
  response: { 200: siteSettings },
})

export const saveSettingsContract = defineContract({
  params: input({ siteId: id() }),
  body: input({
    /** The version read (edit-conflict guard); left out when the site has none yet. */
    version: z.number().int().min(1).optional(),
    senderAddress: shippingAddress,
    /** null: returns go to the sender's address. */
    returnAddress: shippingAddress.nullish(),
    /** The site's company's (or a tenant-wide) Sendcloud account. */
    integrationAccountId: id().nullish(),
    defaultCarrierCode: text(64).nullish(),
    defaultServiceCode: text(128).nullish(),
    defaultTransportBy: z.enum(TRANSPORT_BY).optional(),
    /** The goods' appearance a DDT starts with ("Scatole di cartone"). */
    defaultGoodsAppearance: text(200).nullish(),
    /** The packing station's label printer (ZPL) and A4 printer, of this site. */
    labelPrinterId: id().nullish(),
    documentPrinterId: id().nullish(),
    /** HH:MM, the site's zone. */
    cutOffTime: text(5).nullish(),
  }),
  response: { 200: siteSettings, 201: siteSettings },
})
