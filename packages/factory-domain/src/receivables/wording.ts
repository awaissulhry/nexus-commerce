import type { MinorUnits } from '../core/money'
import { formatDate, formatMoney } from '../documents/format'
import type { DocumentLanguage } from '../documents/model'
import type { LateInterestMode, ReminderAction } from './ladder'
import type { ReminderLine } from './reminders'

/**
 * The wording of a payment reminder (B-W2a-55; FIN-111; design "template preview in the customer's language"), pure. A
 * ladder step names a template key (the seed's BEFORE_DUE, LATE_7, LATE_30); a key not known here, or none, takes the
 * generic text of its side of the due date. THE WORDING IS THE ACCOUNTANT'S (GATE-ACCOUNTANT): every text below is a
 * placeholder to confirm, said so on the settings (`toConfirm`), and a person reads and may edit each reminder's text
 * before approving it. Italian and English; another customer language gets the English text.
 *
 * The text names the invoices (number, date, due date, what is open), the total, the late-payment interest only when the
 * company's rule computes it (AGREED), the D.Lgs. 231/2002 mention when the rule is STATUTORY (no rate recorded yet), the
 * recovery charge of art. 6 when the company claims one, and the bank account the invoices name.
 */

export const REMINDER_TEMPLATES = ['BEFORE_DUE', 'LATE_7', 'LATE_30'] as const
export type ReminderTemplate = (typeof REMINDER_TEMPLATES)[number]

export const TEMPLATE_WORDS: Readonly<Record<ReminderTemplate, { readonly en: string; readonly it: string }>> = Object.freeze({
  BEFORE_DUE: { en: 'Reminder before the due date', it: 'Promemoria prima della scadenza' },
  LATE_7: { en: 'First reminder of an overdue payment', it: 'Primo sollecito di pagamento' },
  LATE_30: { en: 'Second reminder of an overdue payment', it: 'Secondo sollecito di pagamento' },
})

/** Every text is a placeholder until the accountant gives the wording. */
export const WORDING_TO_CONFIRM = 'The reminder texts are placeholders to confirm with the accountant (GATE-ACCOUNTANT); a person reads and may edit each one before approving it.'

export const isReminderTemplate = (value: unknown): value is ReminderTemplate => typeof value === 'string' && (REMINDER_TEMPLATES as readonly string[]).includes(value)

/** The language a reminder is written in: Italian or English (the customer's language, else English). */
export const reminderLanguageOf = (language: string | null | undefined): DocumentLanguage => (language?.toLowerCase().startsWith('it') ? 'it' : 'en')

export interface WordingFacts {
  readonly language: DocumentLanguage
  readonly customerName: string
  readonly companyName: string
  readonly currency: string
  readonly action: ReminderAction
  /** The step's offset (negative: before the due date); null for a reminder by hand. */
  readonly offsetDays: number | null
  readonly lines: readonly Pick<ReminderLine, 'number' | 'issueDate' | 'dueDate' | 'claimed' | 'daysLate'>[]
  readonly amountDue: MinorUnits
  readonly interestAmount: MinorUnits | null
  readonly interestMode: LateInterestMode
  readonly recoveryChargeAmount: MinorUnits | null
  readonly iban: string | null
}

export interface ReminderText {
  readonly subject: string
  readonly body: string
  /** The template the text came from (a known key, or GENERIC). */
  readonly template: ReminderTemplate | 'GENERIC'
}

/** Which text a step gets: its own key when known, else the generic one of its side of the due date. */
function chosen(template: string | null, facts: WordingFacts): ReminderTemplate {
  if (isReminderTemplate(template)) return template
  const late = facts.offsetDays === null ? facts.lines.some((line) => line.daysLate > 0) : facts.offsetDays > 0
  return late ? 'LATE_7' : 'BEFORE_DUE'
}

/** The subject and text of a reminder in its language (placeholders to confirm with the accountant). */
export function reminderText(template: string | null, facts: WordingFacts): ReminderText {
  const key = chosen(template, facts)
  const it = facts.language === 'it'
  const money = (amount: MinorUnits) => formatMoney(amount, facts.currency, facts.language)
  const day = (date: string) => formatDate(date, facts.language)
  const one = facts.lines.length === 1 ? facts.lines[0]! : null
  const overdue = key !== 'BEFORE_DUE'

  const subject = it
    ? key === 'BEFORE_DUE'
      ? one ? `Promemoria: fattura ${one.number} in scadenza il ${day(one.dueDate)}` : `Promemoria: ${facts.lines.length} fatture in scadenza`
      : key === 'LATE_7'
        ? one ? `Sollecito di pagamento: fattura ${one.number} scaduta il ${day(one.dueDate)}` : `Sollecito di pagamento: ${facts.lines.length} fatture scadute`
        : one ? `Secondo sollecito: fattura ${one.number} scaduta il ${day(one.dueDate)}` : `Secondo sollecito: ${facts.lines.length} fatture scadute`
    : key === 'BEFORE_DUE'
      ? one ? `Reminder: invoice ${one.number} is due on ${day(one.dueDate)}` : `Reminder: ${facts.lines.length} invoices falling due`
      : key === 'LATE_7'
        ? one ? `Payment reminder: invoice ${one.number} was due on ${day(one.dueDate)}` : `Payment reminder: ${facts.lines.length} overdue invoices`
        : one ? `Second reminder: invoice ${one.number} was due on ${day(one.dueDate)}` : `Second reminder: ${facts.lines.length} overdue invoices`

  const lineText = (line: WordingFacts['lines'][number]) =>
    it
      ? `- Fattura ${line.number} del ${day(line.issueDate)}, scadenza ${day(line.dueDate)}: ${money(line.claimed)}${line.daysLate > 0 ? ` (scaduta da ${line.daysLate} ${line.daysLate === 1 ? 'giorno' : 'giorni'})` : ''}`
      : `- Invoice ${line.number} of ${day(line.issueDate)}, due ${day(line.dueDate)}: ${money(line.claimed)}${line.daysLate > 0 ? ` (${line.daysLate} ${line.daysLate === 1 ? 'day' : 'days'} late)` : ''}`

  const opening = it
    ? key === 'BEFORE_DUE'
      ? 'le ricordiamo che le seguenti fatture sono in scadenza:'
      : key === 'LATE_7'
        ? 'dai nostri registri risultano scadute e non ancora pagate le seguenti fatture:'
        : 'nonostante il nostro precedente sollecito, risultano ancora non pagate le seguenti fatture:'
    : key === 'BEFORE_DUE'
      ? 'we would like to remind you that the following invoices fall due soon:'
      : key === 'LATE_7'
        ? 'according to our records the following invoices are overdue and not paid yet:'
        : 'despite our earlier reminder, the following invoices are still not paid:'

  const extras: string[] = []
  if (overdue && facts.interestAmount !== null && facts.interestAmount > 0) {
    extras.push(it ? `Interessi di mora (D.Lgs. 231/2002) maturati a oggi: ${money(facts.interestAmount)}` : `Late-payment interest (D.Lgs. 231/2002) to date: ${money(facts.interestAmount)}`)
  } else if (overdue && facts.interestMode === 'STATUTORY') {
    extras.push(it ? 'Sulle somme scadute sono dovuti gli interessi di mora ai sensi del D.Lgs. 231/2002.' : 'Late-payment interest is due on the overdue amounts under D.Lgs. 231/2002.')
  }
  if (overdue && facts.recoveryChargeAmount !== null && facts.recoveryChargeAmount > 0) {
    extras.push(
      it
        ? `Risarcimento forfettario dei costi di recupero (art. 6 D.Lgs. 231/2002): ${money(facts.recoveryChargeAmount)} per fattura.`
        : `Fixed compensation for recovery costs (art. 6 D.Lgs. 231/2002): ${money(facts.recoveryChargeAmount)} per invoice.`,
    )
  }

  const request = it
    ? key === 'BEFORE_DUE'
      ? 'Se il pagamento è già stato disposto, non tenga conto di questo messaggio.'
      : key === 'LATE_7'
        ? 'La preghiamo di provvedere al pagamento. Se lo ha già effettuato, non tenga conto di questo messaggio e ci invii, se possibile, la contabile del bonifico.'
        : 'La preghiamo di provvedere al pagamento al più presto e di contattarci per qualsiasi chiarimento. Se lo ha già effettuato, ci invii la contabile del bonifico.'
    : key === 'BEFORE_DUE'
      ? 'If the payment is already on its way, please disregard this message.'
      : key === 'LATE_7'
        ? 'Please arrange the payment. If you have already paid, please disregard this message and, if possible, send us the transfer receipt.'
        : 'Please arrange the payment as soon as possible and contact us with any question. If you have already paid, please send us the transfer receipt.'

  const bank = facts.iban ? (it ? `Coordinate per il bonifico: IBAN ${facts.iban}` : `Bank details for the transfer: IBAN ${facts.iban}`) : null

  const body = [
    it ? `Gentile ${facts.customerName},` : `Dear ${facts.customerName},`,
    '',
    opening,
    '',
    ...facts.lines.map(lineText),
    '',
    it ? `Totale: ${money(facts.amountDue)}` : `Total: ${money(facts.amountDue)}`,
    ...(extras.length > 0 ? ['', ...extras] : []),
    '',
    request,
    ...(bank ? [bank] : []),
    '',
    it ? 'Cordiali saluti,' : 'Kind regards,',
    facts.companyName,
  ].join('\n')

  return { subject, body, template: isReminderTemplate(template) ? template : 'GENERIC' }
}
