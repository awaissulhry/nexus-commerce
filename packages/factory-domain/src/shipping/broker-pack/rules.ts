import type { BusinessDate } from '../../core/time'

/**
 * The document pack for the broker (B-W2b-409; LOG-097 "one click sends the broker the invoice, packing list, origin papers
 * and DoC as a link and collects the MRN back"; LOG-088 the data pack to the broker or the carrier who files the export
 * declaration), pure. apps/factory-api's modules/shipping/broker-pack serves it.
 *
 *   parts        COMMERCIAL_INVOICE (the newest; required: the broker values the goods from it), PACKING_LIST (the newest
 *                that matches the parcels), POSTAL_FORM (the newest CN 22 or CN 23, when made), CONFORMITY (each PPE style's
 *                declaration of conformity on file) and ORIGIN (the papers of origin the office adds: files of the shipment)
 *   download     always: the parts as ONE PDF (the office hands it to the broker or the carrier itself); its values need
 *                the price grain
 *   by link      only while the declaration's site has its switch ON (ShippingSettings.brokerPackOn, OFF by default, the
 *                Owner's rule of 11-13; the database refuses the link otherwise) and the declaration has a broker: a one-off
 *                link of purpose BROKER_PACK of the CustomsDeclaration for the broker party, its papers as LinkFile rows,
 *                mailed to the broker's contact (FAKE mail locally) or passed on once. The broker downloads each paper
 *                (evidence, never a use) and types the MRN back once (SUBMITTED, the link's one use): the declaration is
 *                FILED in the tenant's system scope (the link session writes nothing itself)
 *
 * Nothing reaches customs: the broker files the declaration in its own system; the MRN is only recorded here.
 */

export const PACK_PARTS = ['COMMERCIAL_INVOICE', 'PACKING_LIST', 'POSTAL_FORM', 'CONFORMITY', 'ORIGIN'] as const
export type PackPart = (typeof PACK_PARTS)[number]

/** A part's state: READY (its files go), MISSING (needed or expected, not there: words), NONE (nothing of the kind is due). */
export const PACK_PART_STATES = ['READY', 'MISSING', 'NONE'] as const
export type PackPartState = (typeof PACK_PART_STATES)[number]

/** The parts that print values (only a holder of the price grain downloads them). */
export const PRICED_PARTS: readonly PackPart[] = Object.freeze(['COMMERCIAL_INVOICE', 'POSTAL_FORM'])

/** The most papers of origin the office adds to one pack. */
export const ORIGIN_FILES_MAX = 10

/** A broker pack's link: how long it lives (the purpose's default and most), and the note it carries. */
export const BROKER_PACK_LINK = Object.freeze({ expiryDays: 14, maxExpiryDays: 30, note: 'Export declaration pack' })

/** The mail that carries the link (EmailOutbound templateKey). */
export const BROKER_PACK_MAIL_TEMPLATE = 'shipping.broker_pack_link'

export interface BrokerMailFacts {
  readonly locale: 'it' | 'en'
  readonly companyName: string
  readonly shipmentNumber: string
  readonly destination: string
  readonly openUntil: BusinessDate
}

/** The mail to the broker in its language: what the pack is for, until when the link opens, and the link (null: not yet). */
export function brokerPackMail(facts: BrokerMailFacts, url: string | null): { readonly subject: string; readonly body: string } {
  const until = facts.openUntil.split('-').reverse().join('/')
  if (facts.locale === 'it') {
    return {
      subject: `Documenti per la dichiarazione di esportazione - spedizione ${facts.shipmentNumber}`,
      body: [
        'Buongiorno,',
        '',
        `${facts.companyName} le invia i documenti per la dichiarazione di esportazione della spedizione ${facts.shipmentNumber} (destinazione ${facts.destination}): fattura commerciale, distinta colli, documenti di origine e dichiarazioni di conformità.`,
        `Il link è valido fino al ${until}. Dopo aver presentato la dichiarazione, inserisca l'MRN nella stessa pagina.`,
        ...(url ? ['', url] : []),
        '',
        'Grazie.',
      ].join('\n'),
    }
  }
  return {
    subject: `Export declaration papers - shipment ${facts.shipmentNumber}`,
    body: [
      'Hello,',
      '',
      `${facts.companyName} sends you the papers for the export declaration of shipment ${facts.shipmentNumber} (to ${facts.destination}): the commercial invoice, the packing list, the papers of origin and the declarations of conformity.`,
      `The link opens until ${until}. Once you have filed the declaration, type the MRN on the same page.`,
      ...(url ? ['', url] : []),
      '',
      'Thank you.',
    ].join('\n'),
  }
}

/** The refusals of the broker pack (409 `refusal/<CODE>`), with their words. */
export const BROKER_PACK_REFUSALS = ['SWITCH_OFF', 'NO_BROKER', 'NO_RECIPIENT', 'NOT_WAITING', 'NO_COMMERCIAL_INVOICE', 'ORIGIN_FILE', 'PRICE_GRAIN', 'FILES_GONE'] as const
export type BrokerPackRefusal = (typeof BROKER_PACK_REFUSALS)[number]
export const brokerPackRefusalPath = (code: BrokerPackRefusal): string => `refusal/${code}`

export const BROKER_PACK_REFUSAL_WORDS: Readonly<Record<BrokerPackRefusal, string>> = Object.freeze({
  SWITCH_OFF: "Sending the broker's pack by link is switched off for this site (shipping settings): download the pack and hand it over yourself.",
  NO_BROKER: 'The carrier files this declaration: there is no broker to send a link to. Download the pack for the carrier.',
  NO_RECIPIENT: 'The broker has no active contact with an e-mail address: pass the link on instead.',
  NOT_WAITING: 'The declaration is filed already: its pack is no longer sent by link.',
  NO_COMMERCIAL_INVOICE: 'Make the commercial invoice first: the broker values the goods from it.',
  ORIGIN_FILE: 'A paper of origin is an available file of this shipment (a PDF or a picture) of its company.',
  PRICE_GRAIN: "The pack carries the commercial invoice's values: it needs the price grain.",
  FILES_GONE: "A paper of the pack is missing from the file store: make it again, then send the pack.",
})

/** What the broker's page refuses (the link's own words). */
export const BROKER_LINK_REFUSALS = ['MRN_FORMAT', 'FILED'] as const
export type BrokerLinkRefusal = (typeof BROKER_LINK_REFUSALS)[number]

export const BROKER_LINK_REFUSAL_WORDS: Readonly<Record<BrokerLinkRefusal, string>> = Object.freeze({
  MRN_FORMAT: 'An MRN has 18 characters: two digits of the year, the country (two letters), then 14 letters or digits.',
  FILED: 'The declaration has its MRN already.',
})
