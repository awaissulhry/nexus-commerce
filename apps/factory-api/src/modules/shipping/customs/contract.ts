import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { COMMERCIAL_INVOICE_NOTES_MAX } from '@nexus/factory-domain/shipping/customs/commercial-invoice'
import { POSTAL_COMMENTS_MAX } from '@nexus/factory-domain/shipping/customs/postal-forms'
import { CN23_BECAUSE, CUSTOMS_REFUSALS, DECLARATION_STATUSES, DESTINATION_CLASSES, EXIT_ALERT_DAYS, EXPORT_REASONS, POSTAL_FORMS } from '@nexus/factory-domain/shipping/customs/rules'
import { SPECIAL_TERRITORIES } from '@nexus/factory-domain/tax/special-territories'

/**
 * Export and customs (B-W2b-409; LOG-086, LOG-087, LOG-088, LOG-089, LOG-095; design warehouse.shipments record › Export,
 * Warehouse › Shipping "EORI"). Codes and words; no amount (the papers' values are in their PDFs, behind the price grain).
 */

const shipmentParams = input({ shipmentId: id() })
const version = z.number().int().min(1)

const documentView = output({
  documentId: id(),
  kind: z.enum(['COMMERCIAL_INVOICE', 'CN22', 'CN23']),
  version: z.number().int(),
  /** The shipment's own number (a customs paper has no series of its own). */
  number: z.string(),
  language: z.enum(DOCUMENT_LANGUAGES),
  /** The PDF, office only: read through GET …/export/documents/:documentId/pdf (the price grain). */
  fileId: id(),
  createdAt: instant(),
  /** The newest version of its kind. */
  current: z.boolean(),
})

const declarationView = output({
  id: id(),
  status: z.enum(DECLARATION_STATUSES),
  /** Who files it: the broker (a party), or the shipment's carrier. */
  filedBy: z.enum(['BROKER', 'CARRIER']),
  broker: output({ id: id(), name: z.string() }).nullable(),
  mrn: z.string().nullable(),
  invoice: output({ id: id(), number: z.string(), date: businessDate().nullable() }).nullable(),
  exitConfirmedAt: instant().nullable(),
  /** The proof of exit (a file of the declaration). */
  exitFile: output({ id: id(), name: z.string() }).nullable(),
  alertAfterDays: z.number().int(),
  exitDueAt: instant().nullable(),
  daysLeft: z.number().int().nullable(),
  overdue: z.boolean(),
  /** The broker links of the pack: to whom, until, withdrawn, answered (the MRN came back), last opened. Never an address. */
  links: z.array(output({ id: id(), email: z.string().nullable(), expiresAt: instant(), revoked: z.boolean(), answered: z.boolean(), lastOpenedAt: instant().nullable(), createdAt: instant() })),
  version: z.number().int(),
  createdAt: instant(),
})

export const exportContract = defineContract({
  params: shipmentParams,
  response: {
    200: output({
      shipment: output({ id: id(), number: z.string(), status: z.string(), shippedAt: instant().nullable(), siteId: id(), companyId: id() }),
      // B-W2b-GF2: the EU special fiscal territory of the ship-to (Livigno, the Canary Islands …), or null.
      destination: output({
        country: z.string().nullable(),
        class: z.enum(DESTINATION_CLASSES).nullable(),
        territory: output({ key: z.enum(SPECIAL_TERRITORIES), vat: z.enum(['INSIDE', 'OUTSIDE']), customs: z.enum(['INSIDE', 'OUTSIDE']), law: z.string(), words: output({ en: z.string(), it: z.string() }) }).nullable(),
      }),
      needed: z.boolean(),
      eori: z.string().nullable(),
      deliveryTerms: z.string().nullable(),
      papers: output({
        held: z.enum(CUSTOMS_REFUSALS).nullable(),
        heldWords: z.string().nullable(),
        commercialInvoice: z.array(documentView),
        postalForm: output({
          suggested: z.enum(POSTAL_FORMS).nullable(),
          because: z.array(z.enum(CN23_BECAUSE)),
          becauseWords: z.array(z.string()),
          held: z.enum(CUSTOMS_REFUSALS).nullable(),
          heldWords: z.string().nullable(),
          versions: z.array(documentView),
        }),
      }),
      declaration: declarationView.nullable(),
      declarationHeld: z.enum(CUSTOMS_REFUSALS).nullable(),
      brokerPackOn: z.boolean(),
      invoices: z.array(output({ id: id(), number: z.string(), docType: z.string(), status: z.string(), date: businessDate().nullable(), ofShipment: z.boolean() })),
      alertDays: output({ default: z.number().int(), min: z.number().int(), max: z.number().int() }),
      mayManage: z.boolean(),
      seesValues: z.boolean(),
    }),
  },
})

const paperAnswer = output({ document: documentView.extend({ made: z.boolean() }) })

export const commercialInvoiceContract = defineContract({
  params: shipmentParams,
  body: input({
    /** Default the order's language. */
    language: z.enum(DOCUMENT_LANGUAGES).optional(),
    /** Default SALE_OF_GOODS (a sales shipment). */
    reason: z.enum(EXPORT_REASONS).optional(),
    reasonText: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(COMMERCIAL_INVOICE_NOTES_MAX).optional(),
  }),
  response: { 200: paperAnswer, 201: paperAnswer },
})

export const postalFormContract = defineContract({
  params: shipmentParams,
  body: input({
    /** Default the form the parcels need; CN23 is always accepted, CN22 only within its limits. */
    form: z.enum(POSTAL_FORMS).optional(),
    language: z.enum(DOCUMENT_LANGUAGES).optional(),
    reason: z.enum(EXPORT_REASONS).optional(),
    reasonText: z.string().trim().max(200).optional(),
    comments: z.string().trim().max(POSTAL_COMMENTS_MAX).optional(),
  }),
  response: { 200: paperAnswer, 201: paperAnswer },
})

export const customsPaperPdfContract = defineContract({ params: input({ shipmentId: id(), documentId: id() }), response: {} })

const changeAnswer = output({ changed: z.boolean(), declarationId: id() })

export const openDeclarationContract = defineContract({
  params: shipmentParams,
  body: input({
    /** The customs broker (a carrier or supplier party); null: the shipment's carrier files it. */
    brokerPartyId: id().nullable(),
    alertAfterDays: z.number().int().min(EXIT_ALERT_DAYS.min).max(EXIT_ALERT_DAYS.max).optional(),
  }),
  response: { 201: output({ declarationId: id() }) },
})

export const recordMrnContract = defineContract({ params: shipmentParams, body: input({ mrn: z.string().trim().min(1).max(40), version: version.optional() }), response: { 200: changeAnswer } })

export const nameInvoiceContract = defineContract({ params: shipmentParams, body: input({ invoiceId: id(), version: version.optional() }), response: { 200: changeAnswer } })

export const confirmExitContract = defineContract({
  params: shipmentParams,
  body: input({ exitConfirmedAt: instant(), fileId: id(), version: version.optional() }),
  response: { 200: changeAnswer },
})

export const removeDeclarationContract = defineContract({
  params: shipmentParams,
  querystring: input({ version: z.coerce.number().int().min(1).optional(), reason: z.string().max(500).optional() }),
  response: { 200: output({ removed: z.boolean(), linksRevoked: z.number().int() }) },
})

const settingsView = output({
  company: output({ id: id(), name: z.string(), eori: z.string().nullable(), version: z.number().int(), mayManage: z.boolean() }),
  sites: z.array(output({ siteId: id(), code: z.string(), name: z.string(), hasSettings: z.boolean(), brokerPackOn: z.boolean(), version: z.number().int().nullable(), mayManage: z.boolean() })),
})

export const customsSettingsContract = defineContract({ params: input({ companyId: id() }), response: { 200: settingsView } })

export const setEoriContract = defineContract({
  params: input({ companyId: id() }),
  body: input({ eori: z.string().trim().max(40).nullable(), version }),
  response: { 200: output({ changed: z.boolean(), settings: settingsView }) },
})

export const brokerPackSwitchContract = defineContract({
  params: input({ siteId: id() }),
  /** on true = send the broker's pack by link from then on (a fresh step-up); false = downloads only. `version`: the settings'. */
  body: input({ on: z.boolean(), version }),
  response: { 200: output({ changed: z.boolean(), settings: settingsView }) },
})
