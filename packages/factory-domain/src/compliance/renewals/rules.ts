import { isBusinessDate, type BusinessDate } from '../../core/time'
import { addDays, daysBetween, daysToExpiry, type CertificateStatus } from '../certificates/rules'

/**
 * Certificate renewals (B-W2a-66; QHS-105 expiry alerts, PRD-283 the renewal window; Reg. (EU) 2016/425 Annex V), pure.
 *
 *   alerts    the exception rules of B-W2a-33 (kind CERTIFICATE_EXPIRING, date timers) tell people 180, 90 and 30 days
 *             before a valid certificate's last valid day: the built-in rule says 30 days, the renewal stages add 180
 *             and 90 (RENEWAL_STAGES, made once per tenant, then the tenant's to change or switch off)
 *   window    the review of an EU type-examination certificate is asked of the notified body that issued it no earlier
 *             than 12 and no later than 6 months before it expires (PRD-283, the scope's Annex V reading): the window
 *             is shown in words; whether a late application is still accepted is the notified body's decision, so
 *             nothing here refuses one
 *   start     "Start renewal" makes ONE task on the certificate with the steps below in words (the notified body's own
 *             list wins: the steps say so) and logs the start on the certificate
 *   applied   the day the application went to the notified body (a fact typed in; nothing is sent from here)
 *   renewed   the new certificate, once registered, is linked as the successor (Certificate.successorId, set once):
 *             the old one leaves the alerts' window and its timers stop
 */

/** The alerts before the last valid day, in days (the plan's 180, 90 and 30; 30 is B-W2a-33's built-in rule). */
export const RENEWAL_STAGES = [180, 90, 30] as const
export type RenewalStage = (typeof RENEWAL_STAGES)[number]
/** The stage the built-in rule already gives every tenant (B-W2a-33): the renewal step adds the others. */
export const BUILT_IN_STAGE: RenewalStage = 30
/** The stage rules the renewal step makes (once per tenant): their days, severity and name. */
export const ADDED_STAGES = [
  { daysBefore: 180, severity: 'WARNING', name: { en: 'Certificate renewal: 180 days before expiry', it: 'Rinnovo del certificato: 180 giorni alla scadenza' } },
  { daysBefore: 90, severity: 'WARNING', name: { en: 'Certificate renewal: 90 days before expiry', it: 'Rinnovo del certificato: 90 giorni alla scadenza' } },
] as const

/** The renewal window in months before the last valid day (PRD-283): it opens 12 months before and closes 6 months before. */
export const RENEWAL_WINDOW_MONTHS = { opens: 12, closes: 6 } as const

/** The certificates a renewal is started for: registered and still counting (not a draft, not withdrawn, not expired). */
export const RENEWABLE_STATUSES = ['VALID', 'SUSPENDED'] as const satisfies readonly CertificateStatus[]
export const isRenewable = (status: string): boolean => (RENEWABLE_STATUSES as readonly string[]).includes(status)

/** The certificates a successor is linked to: registered once (an expired one may still be linked, late). */
export const LINKABLE_STATUSES = ['VALID', 'SUSPENDED', 'EXPIRED'] as const satisfies readonly CertificateStatus[]

const parts = (date: BusinessDate): [number, number, number] => date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]

/** The same day `months` later (negative: earlier); the 31st becomes the month's last day, as PostgreSQL adds an interval. */
export function addMonths(date: BusinessDate, months: number): BusinessDate {
  if (!isBusinessDate(date)) throw new RangeError(`not a calendar day: ${String(date)}`)
  const [year, month, day] = parts(date)
  const index = year * 12 + (month - 1) + months
  const targetYear = Math.floor(index / 12)
  const targetMonth = index - targetYear * 12
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, last))).toISOString().slice(0, 10)
}

export interface RenewalWindow {
  /** The first day the review may be asked (12 months before the last valid day). */
  readonly opens: BusinessDate
  /** The last day it should be asked (6 months before). */
  readonly closes: BusinessDate
}

export const renewalWindowOf = (validTo: BusinessDate): RenewalWindow => ({ opens: addMonths(validTo, -RENEWAL_WINDOW_MONTHS.opens), closes: addMonths(validTo, -RENEWAL_WINDOW_MONTHS.closes) })

export const WINDOW_PHASES = ['BEFORE', 'OPEN', 'CLOSED', 'ENDED'] as const
export type WindowPhase = (typeof WINDOW_PHASES)[number]

/** Where today stands: before the window, inside it, after it (still valid), or past the last valid day. */
export function windowPhase(validTo: BusinessDate, today: BusinessDate): WindowPhase {
  if (daysToExpiry(validTo, today) < 0) return 'ENDED'
  const window = renewalWindowOf(validTo)
  if (daysBetween(today, window.opens) > 0) return 'BEFORE'
  if (daysBetween(window.closes, today) > 0) return 'CLOSED'
  return 'OPEN'
}

/** The calendar day a stage fires (a working-days rule fires on the day its timer says). */
export const stageDay = (validTo: BusinessDate, daysBefore: number): BusinessDate => addDays(validTo, -daysBefore)

// ---- refusals ------------------------------------------------------------------------------------------------------------------

/** Why a renewal step is refused: a code (the screen's words, `refusal/<CODE>`) and the API's sentence. */
export interface RenewalRefusal {
  readonly code: RenewalRefusalCode
  readonly message: string
}

export const RENEWAL_REFUSALS = [
  'NOT_RENEWABLE',
  'ALREADY_RENEWED',
  'ALREADY_STARTED',
  'NOT_LINKABLE',
  'SUCCESSOR_SELF',
  'SUCCESSOR_HOLDER',
  'SUCCESSOR_NOT_LATER',
  'SUCCESSOR_NOT_REGISTERED',
  'SUCCESSOR_TAKEN',
  'APPLIED_IN_FUTURE',
] as const
export type RenewalRefusalCode = (typeof RENEWAL_REFUSALS)[number]

export interface RenewalCertificate {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly companyId: string | null
  readonly holderPartyId: string | null
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate
  readonly successorId: string | null
}

/** Start renewal: a registered certificate still counting, not renewed yet, with no renewal task still open. */
export function startRefusal(certificate: RenewalCertificate, openTask: boolean): RenewalRefusal | null {
  if (certificate.successorId !== null) return { code: 'ALREADY_RENEWED', message: `Certificate ${certificate.number} is already renewed: its successor is linked.` }
  if (!isRenewable(certificate.status)) return { code: 'NOT_RENEWABLE', message: `Certificate ${certificate.number} is ${certificate.status}: a renewal starts from a valid or suspended certificate (a draft is registered first; a withdrawn or expired one is replaced by a new certificate).` }
  if (openTask) return { code: 'ALREADY_STARTED', message: `The renewal of certificate ${certificate.number} is already started: its task is still open.` }
  return null
}

/** The application to the notified body: on a certificate a renewal is started for, on a day that has come. */
export function appliedRefusal(certificate: RenewalCertificate, appliedOn: BusinessDate, today: BusinessDate): RenewalRefusal | null {
  if (certificate.successorId !== null) return { code: 'ALREADY_RENEWED', message: `Certificate ${certificate.number} is already renewed: its successor is linked.` }
  if (!isRenewable(certificate.status) && certificate.status !== 'EXPIRED') return { code: 'NOT_RENEWABLE', message: `Certificate ${certificate.number} is ${certificate.status}: no renewal is asked for it.` }
  if (daysBetween(today, appliedOn) > 0) return { code: 'APPLIED_IN_FUTURE', message: `The application day ${appliedOn} is after today (${today}): record it once it is sent.` }
  return null
}

/**
 * Linking the successor (the database's Certificate_successor_guard holds the same): the old certificate registered
 * once and not renewed yet; the new one registered (VALID: a draft may still change or be withdrawn), another one, of
 * the same holder (company and brand), valid from a later day, and renewing no other certificate.
 */
export function successorRefusal(old: RenewalCertificate, successor: RenewalCertificate, successorRenews: string | null): RenewalRefusal | null {
  if (old.successorId !== null) return { code: 'ALREADY_RENEWED', message: `Certificate ${old.number} is already renewed: its successor is linked and never changes.` }
  if (!(LINKABLE_STATUSES as readonly string[]).includes(old.status)) return { code: 'NOT_LINKABLE', message: `Certificate ${old.number} is ${old.status}: only a registered certificate (valid, suspended or expired) is renewed.` }
  if (successor.id === old.id) return { code: 'SUCCESSOR_SELF', message: 'A certificate does not renew itself: pick the new certificate.' }
  if (successor.companyId !== old.companyId || successor.holderPartyId !== old.holderPartyId) return { code: 'SUCCESSOR_HOLDER', message: `Certificate ${successor.number} is held by another company or brand than ${old.number}: a renewal keeps the holder.` }
  if (daysBetween(old.validFrom, successor.validFrom) <= 0) return { code: 'SUCCESSOR_NOT_LATER', message: `Certificate ${successor.number} is valid from ${successor.validFrom}, not after ${old.validFrom}: a renewal starts on a later day.` }
  if (successor.status !== 'VALID') return { code: 'SUCCESSOR_NOT_REGISTERED', message: `Certificate ${successor.number} is ${successor.status}: register the new certificate first (a draft may still change).` }
  if (successorRenews !== null && successorRenews !== old.id) return { code: 'SUCCESSOR_TAKEN', message: `Certificate ${successor.number} already renews another certificate.` }
  return null
}

// ---- the renewal task --------------------------------------------------------------------------------------------------------

export type Locale = 'en' | 'it'

export interface TaskFacts {
  readonly number: string
  readonly notifiedBodyNumber: string
  readonly notifiedBodyName: string
  readonly validTo: BusinessDate
}

/**
 * The renewal task (title, description and checklist) in a language of the office. The steps are the usual ones in
 * words; what the notified body asks for (samples, tests, fees) is its own list: the description says so.
 */
export function renewalTask(facts: TaskFacts, locale: Locale): { title: string; description: string; checklist: string[]; dueDate: BusinessDate } {
  const window = renewalWindowOf(facts.validTo)
  const body = `${facts.notifiedBodyName} (${facts.notifiedBodyNumber})`
  if (locale === 'it') {
    return {
      title: `Rinnovare il certificato ${facts.number}`,
      description: `Il certificato ${facts.number} scade il ${facts.validTo}. Chiedere il riesame all'organismo notificato ${body} tra il ${window.opens} e il ${window.closes} (da 12 a 6 mesi prima della scadenza). I passi qui sotto sono quelli consueti: vale l'elenco dell'organismo notificato.`,
      checklist: [
        "Controllare il fascicolo tecnico: modifiche dall'esame, revisioni con la risposta dell'organismo",
        `Inviare la domanda di riesame a ${body} entro il ${window.closes}`,
        "Mandare ciò che chiede l'organismo notificato (campioni, prove, documenti)",
        'Registrare il nuovo certificato con il suo PDF e la copertura',
        'Collegare il nuovo certificato a questo nella scheda Rinnovi',
      ],
      dueDate: window.closes,
    }
  }
  return {
    title: `Renew certificate ${facts.number}`,
    description: `Certificate ${facts.number} expires on ${facts.validTo}. Ask notified body ${body} for its review between ${window.opens} and ${window.closes} (12 to 6 months before it expires). The steps below are the usual ones: the notified body's own list wins.`,
    checklist: [
      'Check the technical file: changes since the examination, reviews with the notified body’s answer',
      `Send the application for review to ${body} by ${window.closes}`,
      'Send what the notified body asks for (samples, tests, documents)',
      'Register the new certificate with its PDF and coverage',
      'Link the new certificate to this one on the Renewals tab',
    ],
    dueDate: window.closes,
  }
}

/** What a renewal still lacks, in order (the Renewals tab's next step). */
export function renewalNextStep(input: { readonly status: string; readonly successorId: string | null; readonly started: boolean; readonly appliedOn: BusinessDate | null }): 'RENEWED' | 'START' | 'APPLY' | 'LINK' | 'NONE' {
  if (input.successorId !== null) return 'RENEWED'
  if (!(LINKABLE_STATUSES as readonly string[]).includes(input.status)) return 'NONE'
  if (!input.started && isRenewable(input.status)) return 'START'
  if (input.appliedOn === null && isRenewable(input.status)) return 'APPLY'
  return 'LINK'
}
