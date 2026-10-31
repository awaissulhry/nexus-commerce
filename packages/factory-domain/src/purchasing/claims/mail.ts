import type { DocumentLanguage } from '../../documents/model'
import { decimalText } from '../../product/units/units'
import type { ClaimKind, ClaimRemedy } from './rules'

/**
 * The claim's mail to the supplier (B-W2a-44; SCM-134): the subject and the standard text in the supplier's language
 * (it, else en), sent on the claim's thread so the supplier's reply comes back to the claim. It names the goods, the
 * lots and hides, the quantities, what is wrong and the remedy asked, and the receipt, delivery note and order they came
 * with — never a price or a value (Owner answer C2: no prices on what a supplier is sent outside the order's own
 * thread). The office's own words replace the standard text.
 */

export interface ClaimMailLine {
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly colour: string | null
  readonly lot: string | null
  readonly hide: string | null
  readonly quantity: string
  readonly uom: string
  /** What is wrong with this line, when more than the claim's reason. */
  readonly reason: string | null
}

export interface ClaimMailInput {
  readonly language: DocumentLanguage
  readonly number: string
  readonly kind: ClaimKind
  readonly remedy: ClaimRemedy | null
  /** The reason's label in the language, and the person's words. */
  readonly reason: { readonly label: string | null; readonly note: string | null }
  readonly receiptNumber: string | null
  readonly supplierDdtNumber: string | null
  readonly orderNumber: string | null
  readonly lines: readonly ClaimMailLine[]
  readonly recipientName: string | null
  /** The office's own words in place of the standard text. */
  readonly message: string | null
  /** B-W2b-14: the claim letter (PDF) goes with the mail; the standard text says so. */
  readonly letterAttached?: boolean | undefined
}

function lineText(line: ClaimMailLine, it: boolean): string {
  const goods = [line.code, line.name, line.colour].filter((part): part is string => Boolean(part && part.trim())).join(' ')
  const tracked = [line.lot ? `${it ? 'lotto' : 'lot'} ${line.lot}` : null, line.hide ? `${it ? 'pelle' : 'hide'} ${line.hide}` : null].filter(Boolean).join(', ')
  const why = line.reason?.trim() ? ` — ${line.reason.trim()}` : ''
  return `${line.seq}. ${goods}${tracked ? ` (${tracked})` : ''}: ${decimalText(line.quantity)} ${line.uom}${why}`
}

/** The subject and text of the claim's mail. */
export function claimMail(input: ClaimMailInput): { readonly subject: string; readonly body: string } {
  const it = input.language === 'it'
  const ddt = input.supplierDdtNumber ? (it ? ` (vs. DDT ${input.supplierDdtNumber})` : ` (your delivery note ${input.supplierDdtNumber})`) : ''
  const subject = it
    ? `${input.kind === 'RETURN' ? 'Reso merce e reclamo' : 'Reclamo'} ${input.number}${ddt}`
    : `${input.kind === 'RETURN' ? 'Goods returned and claim' : 'Claim'} ${input.number}${ddt}`
  const greeting = input.recipientName ? (it ? `Gentile ${input.recipientName},` : `Dear ${input.recipientName},`) : it ? 'Buongiorno,' : 'Hello,'
  const own = input.message?.trim() ? input.message.trim() : null
  if (own) return { subject, body: [greeting, own, it ? 'Cordiali saluti' : 'Kind regards'].join('\n\n') }

  const where = [
    input.receiptNumber ? (it ? `consegna ${input.receiptNumber}` : `delivery ${input.receiptNumber}`) : null,
    input.orderNumber ? (it ? `ordine ${input.orderNumber}` : `order ${input.orderNumber}`) : null,
  ].filter(Boolean)
  const of = where.length > 0 ? (it ? ` della ${where.join(', ')}` : ` of ${where.join(', ')}`) : ''
  const opening =
    input.kind === 'RETURN'
      ? it
        ? `vi rendiamo la merce${of}${ddt} indicata qui sotto, che non possiamo usare.`
        : `we are returning the goods${of}${ddt} listed below, which we cannot use.`
      : it
        ? `vi segnaliamo un problema con la merce${of}${ddt} indicata qui sotto.`
        : `we report a problem with the goods${of}${ddt} listed below.`
  const reason = [input.reason.label, input.reason.note].filter((part): part is string => Boolean(part && part.trim())).join(': ')
  const why = reason ? (it ? `Motivo: ${reason}.` : `Reason: ${reason}.`) : null
  const ask =
    input.remedy === 'REPLACEMENT'
      ? it
        ? 'Vi chiediamo la sostituzione della merce.'
        : 'We ask you to replace the goods.'
      : input.remedy === 'CREDIT'
        ? it
          ? 'Vi chiediamo una nota di credito per questa merce.'
          : 'We ask you for a credit note for these goods.'
        : null
  const reply = it ? `Vi preghiamo di rispondere a questo messaggio citando il reclamo ${input.number}.` : `Please reply to this message quoting claim ${input.number}.`
  const letter = input.letterAttached ? (it ? `In allegato la lettera di reclamo ${input.number} (PDF).` : `The claim letter ${input.number} (PDF) is attached.`) : null
  const lines = input.lines.map((line) => lineText(line, it)).join('\n')
  return {
    subject,
    body: [greeting, opening, lines, why, ask, letter, reply, it ? 'Cordiali saluti' : 'Kind regards'].filter((part): part is string => Boolean(part)).join('\n\n'),
  }
}
