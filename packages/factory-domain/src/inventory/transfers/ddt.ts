import type { BusinessDate } from '../../core/time'
import type { DdtReason, DocumentInput, DocumentLanguage, DocumentParty, PostalAddress } from '../../documents/model'
import { materialDescription } from '../../shipping/ddt/sources'
import type { TransferTransport } from './rules'

/**
 * A transfer's DDT as a document (B-W2b-326; DPR 472/1996 art. 1 c. 3, with DPR 627/1978; factory-domain documents, type
 * DDT): the goods travel between two sites of the tenant with a DDT of the SENDING company's DDT series (one numbering
 * with its shipments' DDTs). The DDT lives on the transfer (factory-db TransferOrder: its number, date, reason, carrier,
 * packages, weight and appearance never change once shipped); its PDF is a file of the transfer, printed from those
 * frozen columns, so a copy printed again says what was issued.
 *
 *   sender       the sending company (the letterhead: composeDocument reads its Company row)
 *   recipient    the receiving company (its registered office; the same company between two of its own sites)
 *   destination  the receiving site's address, when it has one
 *   lines        the transfer's lines that left, in their order: the material, its colour, lot and hide, the quantity
 *   transport    the reason (TRANSFER by default), who carries the goods, the start (when it left), the appearance, the
 *                packages and the gross weight
 *   notes        "Transfer TRF-… between sites: <from> → <to>" in the DDT's language
 */

export interface TransferDdtLine {
  readonly code: string
  readonly name: string
  readonly colour: string | null
  readonly lot: string | null
  readonly hide: string | null
  readonly quantity: string
  readonly uom: string
}

export interface TransferDdtFacts {
  readonly number: string
  readonly date: BusinessDate
  readonly language: DocumentLanguage
  readonly currency: string
  readonly transferNumber: string
  readonly fromSite: { readonly code: string; readonly name: string }
  readonly toSite: { readonly code: string; readonly name: string; readonly address: PostalAddress | null }
  readonly recipient: { readonly name: string; readonly address: PostalAddress | null; readonly vatNumber: string | null; readonly fiscalCode: string | null }
  readonly reason: DdtReason
  readonly reasonText: string | null
  readonly transportBy: TransferTransport
  readonly carrier: { readonly name: string; readonly vatNumber?: string | null } | null
  /** When the goods left (ISO 8601 UTC). */
  readonly startAt: string
  readonly appearance: string
  readonly packages: number
  readonly grossWeightKg: string
  readonly lines: readonly TransferDdtLine[]
}

const NOTE: Readonly<Record<DocumentLanguage, (number: string, from: string, to: string) => string>> = {
  it: (number, from, to) => `Trasferimento ${number} tra sedi: ${from} → ${to}.`,
  en: (number, from, to) => `Transfer ${number} between sites: ${from} → ${to}.`,
}

const site = (value: { readonly code: string; readonly name: string }) => (value.name.trim() && value.name.trim() !== value.code ? `${value.code} ${value.name.trim()}` : value.code)

/** The transfer's DDT as factory-domain documents composes it (the company is added by the API from its Company row). */
export function transferDdtDocument(facts: TransferDdtFacts): Omit<DocumentInput, 'company' | 'sample'> {
  // The recipient's address on the DDT is its registered office; a receiving company without one prints the site's.
  const party: DocumentParty = { name: facts.recipient.name, address: facts.recipient.address ?? facts.toSite.address, vatNumber: facts.recipient.vatNumber, fiscalCode: facts.recipient.fiscalCode }
  return {
    type: 'DDT',
    language: facts.language,
    number: facts.number,
    date: facts.date,
    currency: facts.currency,
    party,
    references: [],
    lines: facts.lines.map((line) => ({ code: line.code, description: materialDescription({ name: line.name, colour: line.colour, lot: line.lot, hide: line.hide }, facts.language), quantity: line.quantity, uom: line.uom })),
    transport: {
      reason: facts.reason,
      reasonText: facts.reasonText,
      transportBy: facts.transportBy,
      carrier: facts.carrier ? { name: facts.carrier.name, vatNumber: facts.carrier.vatNumber ?? null } : null,
      startAt: facts.startAt,
      appearance: facts.appearance,
      packages: facts.packages,
      grossWeightKg: facts.grossWeightKg,
      destination: facts.toSite.address ? { ...facts.toSite.address, name: site(facts.toSite) } : null,
    },
    notes: NOTE[facts.language](facts.transferNumber, site(facts.fromSite), site(facts.toSite)),
  }
}

/** The goods' appearance a DDT prints when the site sets none (aspetto esteriore dei beni). */
export const DEFAULT_APPEARANCE: Readonly<Record<DocumentLanguage, string>> = { it: 'colli', en: 'packages' }
