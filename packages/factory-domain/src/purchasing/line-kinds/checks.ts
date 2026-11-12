import type { BusinessDate } from '../../core/time'
import type { DocumentLanguage } from '../../documents/model'
import type { Uom } from '../../product/units/units'
import { Dec } from '../../tax/decimal'
import { certificateWords, endsBefore, type LineCertificateCheck, type NamedCertificate } from './certificates'
import type { LineKindCheck } from './codes'
import { rollsQuantity, rollsWords, type Rolls } from './rolls'

/**
 * What a send checks of the lines by kind (B-W2b-328; SCM-076, SCM-077, SCM-186), and what the supplier reads of them on the
 * order's PDF, pure. The facts are read by apps/factory-api's modules/purchasing/line-kinds (store.ts).
 */

export interface KindCheckLine {
  readonly seq: number
  readonly itemCode: string
  readonly quantity: string
  readonly uom: Uom
  readonly needDate: BusinessDate
  readonly rolls: Rolls | null
  /** A PPE component's line (a protector). */
  readonly ppe: boolean
  readonly certificateId: string | null
  /** The named certificate's check today, and the certificate (null when none is named). */
  readonly certificate: { readonly check: LineCertificateCheck; readonly facts: NamedCertificate | null } | null
  /** The register has a certificate that covers the material from this supplier today (one could be named). */
  readonly coverable: boolean
  /** The variant the line buys and why it no longer may (null: it may), or null when it buys none. */
  readonly variant: { readonly code: string; readonly problem: string | null } | null
}

/** The send checks of the lines by kind; `sample`: the order buys for development (kind SAMPLE). */
export function lineKindChecks(lines: readonly KindCheckLine[], sample: boolean): LineKindCheck[] {
  const checks: LineKindCheck[] = []
  for (const line of lines) {
    const at = `lines/${line.seq}`
    if (line.rolls) {
      const made = rollsQuantity(line.rolls, line.uom)
      if (made !== null && !new Dec(made).equals(line.quantity)) {
        checks.push({
          code: 'ROLLS_NOT_THE_QUANTITY',
          severity: 'BLOCKS',
          path: `${at}/rolls`,
          message: `Line ${line.seq} (${line.itemCode}) is ${rollsWords(line.rolls)} = ${new Dec(made).toString()} ${line.uom}, but asks for ${new Dec(line.quantity).toString()} ${line.uom}: change its rolls or clear them.`,
        })
      }
    }
    if (line.ppe && line.certificateId === null) {
      const blocks = line.coverable && !sample
      checks.push({
        code: 'PPE_NO_CERTIFICATE',
        severity: blocks ? 'BLOCKS' : 'WARNING',
        path: `${at}/certificateId`,
        message: blocks
          ? `Line ${line.seq} (${line.itemCode}) is a PPE component: name the certificate the supplier delivers it against (the register has one that covers it from this supplier).`
          : sample
            ? `Line ${line.seq} (${line.itemCode}) is a PPE component on a sample order and names no certificate: its lots are checked at receipt.`
            : `Line ${line.seq} (${line.itemCode}) is a PPE component, and no certificate of the register covers it from this supplier: its lots are checked at receipt only.`,
      })
    }
    if (line.certificate) {
      const { check, facts } = line.certificate
      if (check.state !== 'HOLDS') {
        checks.push({ code: 'PPE_CERTIFICATE_NOT_VALID', severity: 'BLOCKS', path: `${at}/certificateId`, message: `Line ${line.seq}: ${certificateWords(check, facts, line.itemCode)} Name a certificate that holds.` })
      } else if (facts && endsBefore(facts, line.needDate)) {
        checks.push({
          code: 'PPE_CERTIFICATE_ENDS_EARLY',
          severity: 'WARNING',
          path: `${at}/certificateId`,
          message: `Line ${line.seq}: certificate ${facts.number} ends on ${facts.validTo}, before the line is needed (${line.needDate}): the goods may come after it.`,
        })
      }
    }
    if (line.variant?.problem) checks.push({ code: 'VARIANT_NOT_USABLE', severity: 'BLOCKS', path: `${at}/variantCode`, message: `Line ${line.seq}: ${line.variant.problem}` })
  }
  return checks
}

export interface KindWordsFacts {
  readonly rolls: Rolls | null
  readonly variant: { readonly code: string; readonly size: string | null; readonly supplierCode: string | null } | null
  readonly certificate: { readonly number: string; readonly standard: string } | null
}

const WORDS = {
  it: {
    variant: (code: string, size: string | null, supplier: string | null) => `variante ${code}${size ? ` taglia ${size}` : ''}${supplier ? ` (cod. fornitore ${supplier})` : ''}`,
    certificate: (standard: string, number: string) => `protettore certificato ${standard}, certificato n. ${number}`,
  },
  en: {
    variant: (code: string, size: string | null, supplier: string | null) => `variant ${code}${size ? ` size ${size}` : ''}${supplier ? ` (supplier code ${supplier})` : ''}`,
    certificate: (standard: string, number: string) => `certified protector ${standard}, certificate no. ${number}`,
  },
} as const

/** What the supplier reads of a line's kind on the order: its rolls, its variant, its certificate (empty: none). */
export function lineKindWords(facts: KindWordsFacts, language: DocumentLanguage): string[] {
  const words: string[] = []
  if (facts.variant) words.push(WORDS[language].variant(facts.variant.code, facts.variant.size, facts.variant.supplierCode))
  if (facts.rolls) words.push(rollsWords(facts.rolls, language))
  if (facts.certificate) words.push(WORDS[language].certificate(facts.certificate.standard, facts.certificate.number))
  return words
}
