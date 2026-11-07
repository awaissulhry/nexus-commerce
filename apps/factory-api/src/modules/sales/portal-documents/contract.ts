import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { RECEIVED_STATES } from '@nexus/factory-domain/sales/portal-documents/conformity'
import { DOCUMENT_GROUPS, LIBRARY_CHIPS, PORTAL_DOCUMENT_KINDS } from '@nexus/factory-domain/sales/portal-documents/library'

/**
 * Customer documents in the portal (B-W2b-178; SAL-086, SAL-087, SAL-092, QHS-111; design portal.customer.documents, the
 * order record's Documents tab, Home's New documents). Every kind, group and state comes with its words in Italian and
 * English. An invoice's amount is marked price: the API drops it for a role without the price grain (and such a role sees
 * no invoice at all). No cost, no margin, no person of the office or the floor.
 */

const words = output({ it: z.string(), en: z.string() })
const live = output({ events: z.array(z.string()) })
const fileParams = input({ fileId: id() })
const kind = z.enum(PORTAL_DOCUMENT_KINDS)

const replacement = output({ id: id().nullable(), title: words, version: z.number().int() })

const document = output({
  /** The document's main file (an invoice's PDF, else its XML). */
  id: id(),
  kind,
  kindWords: words,
  group: z.enum(DOCUMENT_GROUPS),
  title: words,
  /** The record it is of: Shipment, SalesOrder, Quote, Invoice (a credit note's invoice), Style, Party …; and its order. */
  for: output({
    type: z.string(),
    id: id(),
    label: z.string().nullable(),
    order: output({ id: id(), number: z.string(), customerRef: z.string().nullable() }).nullable(),
  }).nullable(),
  style: output({ code: z.string(), name: z.string() }).nullable(),
  /** When it was issued (stored, or the invoice issued). */
  date: instant(),
  /** Its fixed version: the file's version, the declaration's revision, the report's or the quote's version; 1 for an invoice. */
  version: z.number().int(),
  sha256: z.string(),
  /** The first 12 hex digits of the SHA-256 ("v3 · 3f9a1c2b0d4e…"). */
  fingerprint: z.string(),
  language: z.string().nullable(),
  /** False for an earlier version: `replacedBy` names the current one. */
  current: z.boolean(),
  replacedBy: replacement.nullable(),
  /** Arrived after the person's previous visit and not opened yet. */
  new: z.boolean(),
  /** A certificate's or declaration's last valid day, when the office set one. */
  expiresOn: businessDate().nullable(),
  /** Its files: one, or an invoice's PDF (courtesy copy) and XML (the legal e-invoice). */
  files: z.array(output({ fileId: id(), format: z.enum(['PDF', 'XML', 'FILE']), name: z.string(), contentType: z.string(), sizeBytes: z.number().int() })),
  /** An invoice's or credit note's total (price grain). */
  grossTotal: money.price(z.number().int().nullable()),
  currency: z.string().nullable(),
})

export const listContract = defineContract({
  querystring: input({
    group: z.enum(LIBRARY_CHIPS).default('ALL'),
    /** A title, a number (ours, their PO), a style's code or name, a file name. */
    q: z.string().trim().max(80).optional(),
    /** The order record's Documents tab: everything of one order (its shipments, quote, invoices and credit notes). */
    orderId: id().optional(),
    shipmentId: id().optional(),
    /** `all` lists earlier versions too, each naming the one that replaced it. */
    versions: z.enum(['current', 'all']).default('current'),
    /** Home's New documents. */
    new: z.enum(['true', 'false']).default('false'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  response: {
    200: output({
      asOf: instant(),
      seesPrices: notMoney(z.boolean()),
      group: z.enum(LIBRARY_CHIPS),
      /** ALL and the groups the person's role sees, with their counts (after the search). */
      chips: z.array(output({ chip: z.enum(LIBRARY_CHIPS), words, count: z.number().int() })),
      count: z.number().int(),
      newCount: z.number().int(),
      lastVisitAt: instant().nullable(),
      items: z.array(document),
      live,
    }),
  },
})

export const oneContract = defineContract({
  params: fileParams,
  response: {
    200: output({
      /** Null when the version was withdrawn (`withdrawn` names the newer one). */
      document: document.nullable(),
      withdrawn: output({ title: words, version: z.number().int(), replacedBy: replacement.nullable() }).nullable(),
      /** Every version of it the person sees, newest first (itself included). */
      versions: z.array(document),
      live,
    }),
  },
})

const docRef = output({ id: id(), kind, title: words, version: z.number().int(), language: z.string().nullable(), fingerprint: z.string(), new: z.boolean() })

export const conformityContract = defineContract({
  querystring: input({ q: z.string().trim().max(80).optional() }),
  response: {
    200: output({
      asOf: instant(),
      count: z.number().int(),
      styles: z.array(
        output({
          style: output({ code: z.string(), name: z.string() }),
          ppe: z.boolean(),
          /** Category II or III: a notified body's EU type-examination certificate. */
          certificateRequired: z.boolean(),
          standard: z.string().nullable(),
          ppeClass: z.string().nullable(),
          /** Per shipment that left, newest first. */
          received: z.array(
            output({
              shipment: output({ id: id(), number: z.string() }),
              order: output({ id: id(), number: z.string(), customerRef: z.string().nullable() }).nullable(),
              shippedOn: businessDate(),
              /** The style revision the work orders froze (the declaration's revision). */
              revision: z.number().int().nullable(),
              pieces: z.number().int(),
              state: z.enum(RECEIVED_STATES),
              words,
              declaration: docRef.nullable(),
              userInformation: docRef.nullable(),
              certificate: output({
                number: z.string(),
                standard: z.string(),
                ppeClass: z.string().nullable(),
                notifiedBody: output({ name: z.string(), number: z.string() }),
                validFrom: businessDate(),
                validTo: businessDate(),
                validOnShippingDate: z.boolean(),
              }).nullable(),
              /** The shipment's certificate of conformity, inspection and test reports shared with you. */
              reports: z.array(docRef),
            }),
          ),
        }),
      ),
      live,
    }),
  },
})

export const downloadContract = defineContract({
  params: fileParams,
  body: input({ mode: z.enum(['download', 'preview']).default('download') }),
  response: {
    200: output({
      document: output({ id: id(), kind, title: words, version: z.number().int(), format: z.enum(['PDF', 'XML', 'FILE']), name: z.string() }),
      /** A GET that lives 60 seconds: `inline` opens in place (a PDF or a picture), `download` saves it. */
      download: output({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})
