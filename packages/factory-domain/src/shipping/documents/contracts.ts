import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { LINK_STATES } from '../../links/purposes'
import { complianceCheckView } from '../../product/compliance/contracts'
import { SHIPMENT_STATUSES } from '../shipments'
import { LINK_DOCUMENT_KINDS, LINK_EXPIRY_DAYS, SHIPMENT_DOCUMENT_KINDS, SHIPMENT_DOCUMENT_STATES } from './documents'

/**
 * The contracts of a shipment's documents (B-W1-49; A2 SCR-067 Documents tab, SCR-101 the link page): what apps/factory-api's
 * modules/shipping/documents answers and accepts. No money, no token: a link's token is in its mail only, never in an
 * answer, a command's result, a stored row or a log.
 */

const issue = output({ path: z.string(), message: z.string() })

export const travelFileView = output({ id: id(), originalName: z.string(), sha256: z.string(), sizeBytes: z.number().int() })
export const sharedFileView = travelFileView.extend({ contentType: z.string(), availableAt: instant() })

export const shipmentDocumentView = output({
  key: z.string(),
  kind: z.enum(SHIPMENT_DOCUMENT_KINDS),
  state: z.enum(SHIPMENT_DOCUMENT_STATES),
  /** It travels by the party's link (the packing list travels in the parcels only). */
  byLink: z.boolean(),
  style: output({ id: id(), code: z.string(), name: z.string(), revision: z.number().int().nullable() }).nullable(),
  wantedLanguage: z.string().nullable(),
  language: z.string().nullable(),
  fallback: z.boolean(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  documentId: id().nullable(),
  /** The file that travels. */
  source: travelFileView.nullable(),
  /** Its copy on the shipment, shared with the party. */
  copy: sharedFileView.nullable(),
  message: z.string(),
})

/** A link made for the shipment's documents (never its token). */
export const documentLinkView = output({
  id: id(),
  email: z.string().nullable(),
  state: z.enum(LINK_STATES),
  expiresAt: instant(),
  maxUses: z.number().int(),
  uses: z.number().int(),
  lastUsedAt: instant().nullable(),
  revokedAt: instant().nullable(),
  createdAt: instant(),
  /** Made by the system when the goods left, or when the party asked for a new one. */
  automatic: z.boolean(),
})

export const recipientView = output({ contactId: id(), name: z.string(), email: z.string() })

export const shipmentDocumentsView = output({
  shipment: output({ id: id(), number: z.string(), status: z.enum(SHIPMENT_STATUSES), partyId: id(), shippedAt: instant().nullable() }),
  /** The buyer's language, then the fallbacks. */
  languages: z.array(z.string()),
  documents: z.array(shipmentDocumentView),
  /** The DoC and the leaflet in the compliance step's words (they block SHIPPING). */
  checks: z.array(complianceCheckView),
  blockers: z.array(complianceCheckView),
  warnings: z.array(issue),
  counts: output({ attached: z.number().int(), toAttach: z.number().int(), missing: z.number().int() }),
  /** Who the link goes to by default: the party's ACTIVE ORDERS and QUALITY contacts with an address. */
  recipients: z.array(recipientView),
  links: z.array(documentLinkView),
})
export type ShipmentDocumentsView = z.infer<typeof shipmentDocumentsView>

export const attachDocumentsAnswer = output({
  /** The copies made now (0 when everything was attached already). */
  attached: z.number().int(),
  /** Files whose retention moved to ten years after the shipment left. */
  retained: z.number().int(),
  documents: shipmentDocumentsView,
})

export const sendLinkBody = input({
  /** Contacts of the shipment's party (default: its ORDERS and QUALITY contacts with an address). */
  contactIds: z.array(id()).min(1).max(20).optional(),
  /** Default and most: the purpose's longest. */
  expiresInDays: z.number().int().min(1).max(LINK_EXPIRY_DAYS).optional(),
})

export const sentLinkView = output({
  linkId: id(),
  email: z.string(),
  expiresAt: instant(),
  maxUses: z.number().int(),
  outboundId: id(),
  /** Where its mail is: SENT, or FAILED (send again), QUEUED when the sender stopped before sending. */
  delivery: z.string(),
})

export const sendLinkAnswer = output({ links: z.array(sentLinkView), attached: z.number().int(), documents: shipmentDocumentsView })

export const linkDocumentView = output({
  fileId: id(),
  kind: z.enum(LINK_DOCUMENT_KINDS),
  title: z.string(),
  style: output({ code: z.string(), name: z.string(), revision: z.number().int().nullable() }).nullable(),
  language: z.string().nullable(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  availableAt: instant(),
})

export const linkDocumentsView = output({
  shipment: output({ number: z.string(), status: z.enum(SHIPMENT_STATUSES), shippedAt: instant().nullable(), deliveredAt: instant().nullable() }),
  link: output({ expiresAt: instant(), usesLeft: z.number().int() }),
  documents: z.array(linkDocumentView),
})

export const renewAnswer = output({ status: z.literal('requested'), message: z.string() })
