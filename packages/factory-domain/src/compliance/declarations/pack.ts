import type { BusinessDate } from '../../core/time'
import { dayWords } from './rules'

/**
 * The shipment compliance pack (B-W2b-257; PRD-300; Reg. (EU) 2016/425 art. 8(8), art. 10: the DoC, or the address where it
 * is found, and the user information go with the goods), pure. One pack per shipment version: what travels with its PPE
 * garments, per style and the revision their work orders froze — the signed DoC and leaflet shipping chose in the buyer's
 * language (B-W1-49's choice: the order's language, then English, then Italian), the EU type-examination certificate in
 * summary (the one the DoC cites when valid on the day, else one covering the style: B-W2b-178's rule), and the batches
 * with the public DoC address their labels' QR holds (B-W2b-166). Never a price, a cost or a person's name but the
 * signatory printed on the DoC itself.
 *
 * The PDF is the pack's summary (cover, contents with each document's SHA-256, per style the documents, the certificate and
 * the batches); the ZIP holds that PDF, every document's PDF as it was stored, and SHA256SUMS.txt (no PDF merge: no new
 * package). The same contents make the same fingerprint: the newest version comes back instead of a new one.
 */

export type PackLocale = 'it' | 'en'

/** The pack's own words are the factory's two languages: Italian for an Italian buyer, English otherwise. */
export const packLocaleOf = (language: string | null | undefined): PackLocale => (language === 'it' ? 'it' : 'en')

export interface PackDocument {
  readonly documentId: string
  readonly kind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'
  readonly language: string
  readonly revision: number
  readonly number: string | null
  readonly issuedAt: string | null
  /** A language other than the buyer's (shipping's fallback). */
  readonly fallback: boolean
  readonly file: { readonly id: string; readonly originalName: string; readonly sha256: string; readonly sizeBytes: number }
}

export interface PackCertificate {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly ppeClass: string | null
  readonly bodyName: string
  readonly bodyNumber: string
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
  readonly validOnDay: boolean
}

export interface PackBatch {
  readonly workOrderId: string
  readonly batchNumber: string
  readonly garments: number
  readonly publicDocAddress: string
  readonly publicDocCode: string
}

export interface PackStyle {
  readonly styleId: string
  readonly code: string
  readonly name: string
  readonly revision: number | null
  readonly category: string
  readonly garments: number
  readonly documents: readonly PackDocument[]
  readonly certificate: PackCertificate | null
  readonly batches: readonly PackBatch[]
}

export interface PackFacts {
  readonly shipment: { readonly id: string; readonly number: string; readonly status: string; readonly shippedOn: BusinessDate | null }
  readonly customer: { readonly name: string } | null
  readonly order: { readonly number: string; readonly customerRef: string | null } | null
  /** The buyer's language (the order's). */
  readonly wantedLanguage: string | null
  /** The day the certificates are judged on: the shipping day, or today before it leaves. */
  readonly day: BusinessDate
  readonly styles: readonly PackStyle[]
  /** Who sends it: the company that ships (name only). */
  readonly sender: string
}

export interface PackProblem {
  readonly code: string
  readonly message: string
}

/** Why no pack can be built, in words (empty: it can). */
export function packRefusals(facts: PackFacts, blockers: readonly string[]): PackProblem[] {
  const out: PackProblem[] = []
  if (facts.shipment.status === 'CANCELLED') out.push({ code: 'CANCELLED', message: `Shipment ${facts.shipment.number} is cancelled.` })
  if (facts.styles.length === 0) out.push({ code: 'NO_PPE', message: `Shipment ${facts.shipment.number} carries no PPE garment: there is nothing to declare.` })
  for (const blocker of blockers) out.push({ code: 'DOCUMENT_MISSING', message: blocker })
  return out
}

/** What the pack warns about, in words (it is still built). */
export function packWarnings(facts: PackFacts): PackProblem[] {
  const out: PackProblem[] = []
  for (const style of facts.styles) {
    for (const document of style.documents.filter((entry) => entry.fallback)) {
      out.push({ code: 'FALLBACK_LANGUAGE', message: `${style.code}: the ${document.kind === 'DECLARATION_OF_CONFORMITY' ? 'DoC' : 'user information'} travels in ${document.language}, not in ${facts.wantedLanguage ?? 'the buyer’s language'}.` })
    }
    if (style.category !== 'CATEGORY_I' && !style.certificate) out.push({ code: 'NO_CERTIFICATE', message: `${style.code}: no certificate on record.` })
    else if (style.certificate && !style.certificate.validOnDay) out.push({ code: 'CERTIFICATE_NOT_VALID', message: `${style.code}: certificate ${style.certificate.number} was not valid on ${facts.day}.` })
    if (style.batches.length === 0) out.push({ code: 'NO_BATCH', message: `${style.code}: no batch number on its work orders yet.` })
  }
  return out
}

/** A file name safe in a zip and on every disk. */
export const safeName = (value: string): string => value.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'document'

export interface ContentsEntry {
  readonly title: string
  readonly sha256: string
  readonly recordType: string
  readonly recordId: string
  readonly fileId: string
  readonly path: string
}

const KIND_WORDS: Readonly<Record<PackLocale, Readonly<Record<PackDocument['kind'], string>>>> = Object.freeze({
  it: { DECLARATION_OF_CONFORMITY: 'Dichiarazione di conformità UE', USER_INFORMATION: 'Nota informativa' },
  en: { DECLARATION_OF_CONFORMITY: 'EU declaration of conformity', USER_INFORMATION: 'User information' },
})

/** Each document of the pack, in order (style, kind, language), with its path in the zip. */
export function packContents(facts: PackFacts, locale: PackLocale): ContentsEntry[] {
  const out: ContentsEntry[] = []
  const paths = new Set<string>()
  for (const style of facts.styles) {
    for (const document of style.documents) {
      let path = `documents/${safeName(`${style.code}-r${document.revision}-${document.kind === 'DECLARATION_OF_CONFORMITY' ? 'DoC' : 'user-information'}-${document.language}`)}.pdf`
      for (let n = 2; paths.has(path); n++) path = path.replace(/(-\d+)?\.pdf$/, `-${n}.pdf`)
      paths.add(path)
      out.push({
        title: `${KIND_WORDS[locale][document.kind]} ${document.number ?? style.code} (${document.language}, ${locale === 'it' ? 'revisione' : 'revision'} ${document.revision})`,
        sha256: document.file.sha256,
        recordType: 'ComplianceDocument',
        recordId: document.documentId,
        fileId: document.file.id,
        path,
      })
    }
  }
  return out
}

/** What the fingerprint covers: everything the pack says, in a fixed order (no time, no person). */
export function packFingerprintText(facts: PackFacts, locale: PackLocale): string {
  return JSON.stringify({
    pack: 'compliance-pack.1',
    locale,
    shipment: facts.shipment.number,
    customer: facts.customer?.name ?? null,
    order: facts.order,
    day: facts.day,
    sender: facts.sender,
    styles: facts.styles.map((style) => ({
      code: style.code,
      name: style.name,
      revision: style.revision,
      category: style.category,
      garments: style.garments,
      documents: style.documents.map((document) => [document.kind, document.language, document.revision, document.number, document.file.sha256]),
      certificate: style.certificate ? [style.certificate.number, style.certificate.standard, style.certificate.ppeClass, style.certificate.bodyName, style.certificate.bodyNumber, style.certificate.validFrom, style.certificate.validTo, style.certificate.validOnDay] : null,
      batches: style.batches.map((batch) => [batch.batchNumber, batch.garments, batch.publicDocAddress]),
    })),
  })
}

/** SHA256SUMS.txt: one line per file in the zip ("<sha256>  <path>"), the pack's PDF first. */
export function sumsText(entries: readonly { readonly sha256: string; readonly path: string }[]): string {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`
}

// ---- the paper ------------------------------------------------------------------------------------------------------------

export interface PackPaper {
  readonly title: string
  readonly subtitle: string
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly contentsHeading: string
  readonly contents: readonly { readonly title: string; readonly sha256: string }[]
  readonly styles: readonly {
    readonly heading: string
    readonly lines: readonly string[]
    readonly certificate: readonly string[]
    readonly batchesHeading: string
    readonly batches: readonly { readonly line: string; readonly address: string; readonly code: string }[]
  }[]
  readonly footer: string
  readonly fingerprintLabel: string
}

const WORDS = {
  it: {
    title: 'Pacchetto di conformità della spedizione',
    subtitle: 'Dichiarazioni di conformità UE, note informative e certificati delle merci DPI di questa spedizione (Reg. (UE) 2016/425, art. 8, par. 8).',
    shipment: 'Spedizione',
    shippedOn: 'Spedita il',
    notShipped: 'non ancora spedita',
    customer: 'Cliente',
    order: 'Ordine',
    yourRef: 'vostro rif.',
    sender: 'Mittente',
    contents: 'Contenuto (impronta SHA-256 di ogni file)',
    revision: 'revisione',
    garments: 'capi',
    category: { CATEGORY_I: 'DPI di categoria I', CATEGORY_II: 'DPI di categoria II', CATEGORY_III: 'DPI di categoria III' } as Record<string, string>,
    certificate: 'Certificato di esame UE del tipo',
    noCertificate: 'Categoria I: nessun organismo notificato (controllo interno della produzione, modulo A).',
    noCertificateOnRecord: 'Nessun certificato registrato.',
    body: 'organismo notificato',
    valid: 'valido dal',
    to: 'al',
    validOn: 'valido il',
    notValidOn: 'NON valido il',
    batches: 'Lotti e indirizzo della dichiarazione pubblica (il QR sull’etichetta)',
    noBatches: 'Nessun numero di lotto ancora.',
    batch: 'Lotto',
    fallback: 'in una lingua diversa da quella del cliente',
    footer: 'Generato da Nexus Factory. Nessun prezzo, costo o dato personale: solo i documenti che accompagnano le merci.',
    fingerprint: 'Impronta del pacchetto',
  },
  en: {
    title: 'Shipment compliance pack',
    subtitle: 'EU declarations of conformity, user information and certificates of the PPE goods on this shipment (Reg. (EU) 2016/425, art. 8(8)).',
    shipment: 'Shipment',
    shippedOn: 'Shipped on',
    notShipped: 'not shipped yet',
    customer: 'Customer',
    order: 'Order',
    yourRef: 'your ref.',
    sender: 'Sender',
    contents: 'Contents (SHA-256 fingerprint of each file)',
    revision: 'revision',
    garments: 'garments',
    category: { CATEGORY_I: 'Category I PPE', CATEGORY_II: 'Category II PPE', CATEGORY_III: 'Category III PPE' } as Record<string, string>,
    certificate: 'EU type-examination certificate',
    noCertificate: 'Category I: no notified body (internal production control, Module A).',
    noCertificateOnRecord: 'No certificate on record.',
    body: 'notified body',
    valid: 'valid from',
    to: 'to',
    validOn: 'valid on',
    notValidOn: 'NOT valid on',
    batches: 'Batches and their public declaration address (the QR on the label)',
    noBatches: 'No batch number yet.',
    batch: 'Batch',
    fallback: 'in another language than the customer’s',
    footer: 'Made by Nexus Factory. No price, cost or personal data: only the documents that go with the goods.',
    fingerprint: 'Pack fingerprint',
  },
} as const

/** The pack's summary as it prints, in the pack's locale. */
export function packPaper(facts: PackFacts, locale: PackLocale, contents: readonly ContentsEntry[], fingerprint: string, version: number): PackPaper {
  const words = WORDS[locale]
  const day = (value: BusinessDate) => dayWords(value, locale)
  return {
    title: words.title,
    subtitle: words.subtitle,
    facts: [
      { label: words.shipment, value: `${facts.shipment.number} · v${version}` },
      { label: words.shippedOn, value: facts.shipment.shippedOn ? day(facts.shipment.shippedOn) : words.notShipped },
      ...(facts.customer ? [{ label: words.customer, value: facts.customer.name }] : []),
      ...(facts.order ? [{ label: words.order, value: `${facts.order.number}${facts.order.customerRef ? ` (${words.yourRef} ${facts.order.customerRef})` : ''}` }] : []),
      { label: words.sender, value: facts.sender },
    ],
    contentsHeading: words.contents,
    contents: contents.map((entry) => ({ title: entry.title, sha256: entry.sha256 })),
    styles: facts.styles.map((style) => ({
      heading: `${style.code} ${style.name}${style.revision !== null ? ` · ${words.revision} ${style.revision}` : ''} · ${style.garments} ${words.garments}`,
      lines: [
        words.category[style.category] ?? style.category,
        ...style.documents.map((document) => `${KIND_WORDS[locale][document.kind]} ${document.number ?? ''} (${document.language}, ${words.revision} ${document.revision})${document.fallback ? ` — ${words.fallback}` : ''}`.replace(/  +/g, ' ')),
      ],
      certificate: style.certificate
        ? [
            `${words.certificate} ${style.certificate.number}: ${style.certificate.standard}${style.certificate.ppeClass ? `, ${style.certificate.ppeClass}` : ''}`,
            `${words.body} ${style.certificate.bodyName} (${style.certificate.bodyNumber}); ${words.valid} ${day(style.certificate.validFrom)} ${words.to} ${day(style.certificate.validTo)}; ${style.certificate.validOnDay ? words.validOn : words.notValidOn} ${day(facts.day)}`,
          ]
        : [style.category === 'CATEGORY_I' ? words.noCertificate : words.noCertificateOnRecord],
      batchesHeading: words.batches,
      batches: style.batches.map((batch) => ({ line: `${words.batch} ${batch.batchNumber} · ${batch.garments} ${words.garments}`, address: batch.publicDocAddress, code: batch.publicDocCode })),
    })),
    footer: words.footer,
    fingerprintLabel: `${words.fingerprint}: ${fingerprint}`,
  }
}

/** The pack's file name: "<shipment> compliance pack v<n>". */
export const packFileName = (shipmentNumber: string, version: number, locale: PackLocale): string =>
  `${safeName(shipmentNumber)} ${locale === 'it' ? 'pacchetto conformita' : 'compliance pack'} v${version}`
