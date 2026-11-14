import type { MinorUnits } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { LadderStep } from '../ladder'

/**
 * Payment received notices and trusted reminder levels (B-W2b-402; FIN-128, FIN-113; the Owner's rule of 11-13: every
 * message that would go out by itself has a per-company switch, OFF by default), pure.
 *
 *   to staff      a payment recorded: the people who follow the customer and the people whose orders it pays hear it (an
 *                 amount only with the price grain); a deposit paid: the order's maker and who releases production at the
 *                 company hear that production may start (the work orders' deposit gate reads the request PAID at once)
 *   to customer   a bank transfer recorded: an e-mail to the customer's invoice contacts with what arrived and what it paid,
 *                 only while the company's switch (ReceivablesSettings.paymentNoticeToCustomerOn) is on; FAKE mail locally
 *   trusted level a customer's level (Party.reminderTrustedLevel, 1 to 10; null: none): the ladder's e-mail reminders up to
 *                 that level go without a person, only while the company's reminders are switched on and nothing holds them
 * The wording is a placeholder to confirm with the accountant (WORDING_TO_CONFIRM).
 */

export const NOTICE_WORDING_TO_CONFIRM = 'The payment received notice is a placeholder text: confirm its wording with the accountant before switching the notice on.'

export interface NoticeLine {
  readonly number: string
  readonly amount: MinorUnits
}

export interface PaymentNoticeInput {
  readonly language: 'it' | 'en'
  readonly companyName: string
  readonly customerName: string
  readonly currency: string
  readonly amount: MinorUnits
  readonly receivedOn: BusinessDate
  /** The invoices (and deposit requests, by their order's number) it was placed on. */
  readonly placed: readonly NoticeLine[]
  /** What is not placed yet (kept on account). */
  readonly unplaced: MinorUnits
}

const money = (amount: MinorUnits, currency: string, language: 'it' | 'en'): string => {
  const whole = Math.trunc(Math.abs(amount) / 100)
  const cents = String(Math.abs(amount) % 100).padStart(2, '0')
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, language === 'it' ? '.' : ',')
  return `${amount < 0 ? '-' : ''}${grouped}${language === 'it' ? ',' : '.'}${cents} ${currency}`
}
const dayWords = (day: BusinessDate, language: 'it' | 'en'): string => (language === 'it' ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : day)

/** The customer's notice in its language (it, else en). */
export function paymentNoticeMail(input: PaymentNoticeInput): { readonly subject: string; readonly body: string } {
  const { language } = input
  const amount = money(input.amount, input.currency, language)
  const lines = input.placed.map((line) => `- ${line.number}: ${money(line.amount, input.currency, language)}`)
  if (language === 'it') {
    return {
      subject: `Pagamento ricevuto - ${input.companyName}`,
      body: [
        `Gentile ${input.customerName},`,
        '',
        `abbiamo ricevuto il Vostro pagamento di ${amount} in data ${dayWords(input.receivedOn, language)}.`,
        ...(lines.length > 0 ? ['', 'È stato imputato a:', ...lines] : []),
        ...(input.unplaced > 0 ? ['', `${money(input.unplaced, input.currency, language)} restano a Vostro credito.`] : []),
        '',
        'Grazie.',
        input.companyName,
      ].join('\n'),
    }
  }
  return {
    subject: `Payment received - ${input.companyName}`,
    body: [
      `Dear ${input.customerName},`,
      '',
      `we received your payment of ${amount} on ${dayWords(input.receivedOn, language)}.`,
      ...(lines.length > 0 ? ['', 'It was placed on:', ...lines] : []),
      ...(input.unplaced > 0 ? ['', `${money(input.unplaced, input.currency, language)} stays on your account as a credit.`] : []),
      '',
      'Thank you.',
      input.companyName,
    ].join('\n'),
  }
}

/** Why a customer's notice did not go by itself (null: it goes). */
export const NOTICE_HELD = {
  SWITCHED_OFF: "The company's payment received notice to customers is switched off (the Owner's switch).",
  NOT_A_TRANSFER: 'Only a bank transfer (typed, matched from the bank or a Ri.Ba. paid) is told this way: the card provider tells its own.',
  VOIDED: 'The payment was voided before the notice went.',
  NO_CONTACT: 'No active contact of the customer receives invoices with an e-mail address.',
} as const
export type NoticeHeld = keyof typeof NOTICE_HELD

export const MAX_TRUSTED_LEVEL = 10

/** The ladder steps a trusted level lets go without a person (the e-mail ones; a letter or a call always waits). */
export const trustedSteps = (level: number | null, ladder: readonly LadderStep[]): LadderStep[] => (level === null ? [] : ladder.filter((step) => step.level <= level && step.action === 'EMAIL'))

/** Whether a reminder of `level` sent as `action` to a customer of `trustedLevel` may go by itself (the switch and holds aside). */
export const trustedFor = (trustedLevel: number | null, reminder: { readonly level: number; readonly action: string; readonly byHand: boolean }): boolean =>
  trustedLevel !== null && !reminder.byHand && reminder.action === 'EMAIL' && reminder.level <= trustedLevel

export const TRUST_WORDS = {
  NONE: { en: 'Every reminder to this customer waits for a person.', it: 'Ogni sollecito a questo cliente aspetta una persona.' },
  LEVEL: { en: 'E-mail reminders up to level {level} go by themselves while reminders are switched on and nothing holds them; a letter, a call or a higher level waits for a person.', it: 'I solleciti via e-mail fino al livello {level} partono da soli quando i solleciti sono attivi e nulla li trattiene; una lettera, una telefonata o un livello più alto aspettano una persona.' },
} as const

export const trustWords = (level: number | null): { readonly en: string; readonly it: string } =>
  level === null ? TRUST_WORDS.NONE : { en: TRUST_WORDS.LEVEL.en.replace('{level}', String(level)), it: TRUST_WORDS.LEVEL.it.replace('{level}', String(level)) }
