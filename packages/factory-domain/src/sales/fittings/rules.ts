import type { Issue } from '../../core/errors'
import { BUSINESS_TIME_ZONE } from '../../core/time'

/**
 * Fittings, alterations and remakes of made-to-measure units (B-W2b-360; SAL-054 "Fitting and showroom appointments", SAL-297
 * "Alteration loop after fitting", SAL-353 "Remake order for made-to-measure"; design sales.mtm › Fittings "Date, place, fitter ·
 * Outcome: fits / alteration needed · Alteration sent back, with the date moved by its time", mtm.fitting "Book a fitting: date and
 * time, place, fitter, invite (.ics) to the rider"). Pure: apps/factory-api's modules/sales/fittings asks these and answers in words
 * before the database's own rules (…_mtm_office_w2b_guards) would refuse.
 *
 *   an appointment   a FITTING of a rider's profile revision, a SHOWROOM visit or a MEASURING session with a customer: booked
 *                    ahead (it starts now or later, ends after it starts, within 24 hours), where in one line, with an office
 *                    person of ours and/or someone outside by name; moved while BOOKED; closed once: DONE or MISSED once it has
 *                    started (DONE says who was there), CANCELLED with why; then only its notes (and, for a done one without a
 *                    profile, the revision it led to, once)
 *   the reminder     once, REMINDER_HOURS_BEFORE before it starts, when it was booked (or last invited) earlier than that
 *   a fitting result per point of the profile's measures the change asked (a signed decimal in the point's unit, not zero), the
 *                    verdict OK (no change, nothing opened), ALTER (a point or the words; the days it adds, 1 to 365) or REMAKE
 *                    (the words: why it cannot be altered)
 *   a remake         of a returned made-to-measure unit: its goods scrapped (or held in quarantine), the new unit made to the
 *                    revision it was made to or to the rider's newest
 */

export const APPOINTMENT_KINDS = ['FITTING', 'SHOWROOM', 'MEASURING'] as const
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number]
export const APPOINTMENT_STATUSES = ['BOOKED', 'DONE', 'MISSED', 'CANCELLED'] as const
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]
/** How a booked appointment that took place (or did not) is closed; CANCELLED is its own action. */
export const CLOSE_OUTCOMES = ['DONE', 'MISSED'] as const
export type CloseOutcome = (typeof CLOSE_OUTCOMES)[number]
export const FITTING_VERDICTS = ['OK', 'ALTER', 'REMAKE'] as const
export type FittingVerdict = (typeof FITTING_VERDICTS)[number]
export const POINT_UNITS = ['cm', 'mm'] as const
export type PointUnit = (typeof POINT_UNITS)[number]

export const FITTING_LIMITS = Object.freeze({
  place: 200,
  name: 200,
  notes: 4000,
  cancelReason: 500,
  pointNote: 500,
  points: 60,
  alterationDays: 365,
  hours: 24,
  /** At most this many appointments in one list answer. */
  list: 200,
})

/** The reminder goes this many hours before the appointment starts. */
export const REMINDER_HOURS_BEFORE = 24
/** A few minutes for the clocks of the screen and the server. */
export const CLOCK_SLACK_MS = 5 * 60_000
const HOUR_MS = 3_600_000

/** Where a remade unit's returned goods may go, the usual one first (they never go back into stock as new: made to a body). */
export const REMAKE_OUTCOMES = ['SCRAP', 'QUARANTINE'] as const
export type RemakeOutcome = (typeof REMAKE_OUTCOMES)[number]

const oneLine = (value: string): boolean => !/[\r\n]/.test(value)
const kindWord = (kind: AppointmentKind): string => (kind === 'FITTING' ? 'The fitting' : kind === 'SHOWROOM' ? 'The showroom visit' : 'The measuring session')

// ---- appointments -----------------------------------------------------------------------------------------------------

export interface AppointmentDraft {
  readonly kind: AppointmentKind
  readonly startsAt: Date
  readonly endsAt: Date
  readonly place: string
  readonly riderName: string | null
  readonly withName: string | null
  readonly notes: string | null
  readonly hasProfile: boolean
}

/**
 * The problems of an appointment as it would be written (booked or moved), each at its body field: it starts now or later (a
 * fitting that took place without one is recorded on the order line), ends after it starts and within 24 hours, where in one
 * line, the names in one line, a fitting of a profile revision.
 */
export function appointmentProblems(draft: AppointmentDraft, now: Date, timesChanged = true): Issue[] {
  const problems: Issue[] = []
  if (timesChanged && draft.startsAt.getTime() < now.getTime() - CLOCK_SLACK_MS) problems.push({ path: 'body/startsAt', message: 'An appointment is booked ahead: it starts now or later (a fitting that took place without one is recorded on the order line).' })
  if (draft.endsAt.getTime() <= draft.startsAt.getTime()) problems.push({ path: 'body/endsAt', message: 'It ends after it starts.' })
  else if (draft.endsAt.getTime() - draft.startsAt.getTime() > FITTING_LIMITS.hours * HOUR_MS) problems.push({ path: 'body/endsAt', message: `It ends at most ${FITTING_LIMITS.hours} hours after it starts.` })
  if (draft.place.trim() === '' || draft.place.length > FITTING_LIMITS.place || !oneLine(draft.place)) problems.push({ path: 'body/place', message: `Where: 1 to ${FITTING_LIMITS.place} characters of one line ("Showroom", "Mugello paddock", the dealer's shop).` })
  if (draft.riderName !== null && (draft.riderName.trim() === '' || draft.riderName.length > FITTING_LIMITS.name || !oneLine(draft.riderName))) problems.push({ path: 'body/riderName', message: `The rider's name: 1 to ${FITTING_LIMITS.name} characters of one line.` })
  if (draft.withName !== null && (draft.withName.trim() === '' || draft.withName.length > FITTING_LIMITS.name || !oneLine(draft.withName))) problems.push({ path: 'body/withName', message: `Who it is with: 1 to ${FITTING_LIMITS.name} characters of one line.` })
  if (draft.notes !== null && (draft.notes.trim() === '' || draft.notes.length > FITTING_LIMITS.notes)) problems.push({ path: 'body/notes', message: `Notes: 1 to ${FITTING_LIMITS.notes} characters.` })
  if (draft.kind === 'FITTING' && !draft.hasProfile) problems.push({ path: 'body/measurementProfileId', message: "A fitting is of a rider's measurement profile revision: name it." })
  return problems
}

/** Why a booked appointment cannot be moved, re-invited or cancelled (null: it can). */
export function bookedRefusal(status: AppointmentStatus, action: 'moved' | 'invited' | 'cancelled'): string | null {
  if (status === 'BOOKED') return null
  return `This appointment is ${status.toLowerCase()}: it is no longer ${action} (only its notes change; book a new one).`
}

/** Why a booked appointment cannot be closed DONE or MISSED at `closedAt` (null: it can). DONE needs who was there. */
export function closeRefusal(appointment: { readonly status: AppointmentStatus; readonly kind: AppointmentKind; readonly startsAt: Date }, outcome: CloseOutcome, closedAt: Date, now: Date, who: { readonly withUserId: string | null; readonly withName: string | null }): string | null {
  if (appointment.status !== 'BOOKED') return `This appointment is ${appointment.status.toLowerCase()} already: it closes once.`
  if (closedAt.getTime() > now.getTime() + CLOCK_SLACK_MS) return 'It is closed now or earlier, not in the future.'
  if (closedAt.getTime() < appointment.startsAt.getTime()) return `${kindWord(appointment.kind)} has not started yet: it is ${outcome === 'DONE' ? 'done' : 'missed'} once it has started (cancel it instead).`
  if (outcome === 'DONE' && who.withUserId === null && who.withName === null) return 'Say who was there: an office person of ours or a name (a dealer’s fitter).'
  return null
}

/** Whether the rider's reminder is due now (see the file's head). */
export function reminderDue(appointment: { readonly status: AppointmentStatus; readonly startsAt: Date; readonly inviteSentAt: Date | null; readonly reminderSentAt: Date | null; readonly createdAt: Date }, now: Date): boolean {
  if (appointment.status !== 'BOOKED' || appointment.reminderSentAt !== null) return false
  const start = appointment.startsAt.getTime()
  if (start <= now.getTime() || start - now.getTime() > REMINDER_HOURS_BEFORE * HOUR_MS) return false
  const told = (appointment.inviteSentAt ?? appointment.createdAt).getTime()
  return start - told > REMINDER_HOURS_BEFORE * HOUR_MS
}

/** Two appointments of the same person overlap. */
export const overlaps = (a: { readonly startsAt: Date; readonly endsAt: Date }, b: { readonly startsAt: Date; readonly endsAt: Date }): boolean => a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime()

// ---- the rider's mails ---------------------------------------------------------------------------------------------------

export type MailLanguage = 'it' | 'en'

const KIND_WORDS: Readonly<Record<MailLanguage, Readonly<Record<AppointmentKind, string>>>> = Object.freeze({
  it: { FITTING: 'prova', SHOWROOM: 'visita in showroom', MEASURING: 'presa delle misure' },
  en: { FITTING: 'fitting', SHOWROOM: 'showroom visit', MEASURING: 'measuring session' },
})

export const appointmentKindWords = (kind: AppointmentKind, language: MailLanguage): string => KIND_WORDS[language][kind]

/** "martedì 2 dicembre 2026, 10:00–11:00" / "Tuesday 2 December 2026, 10:00–11:00", in the business time zone. */
export function whenWords(startsAt: Date, endsAt: Date, language: MailLanguage, timeZone: string = BUSINESS_TIME_ZONE): string {
  const locale = language === 'it' ? 'it-IT' : 'en-GB'
  // Assembled from the parts (the punctuation of a long date differs between ICU versions).
  const parts = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(startsAt)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? ''
  const time = (instant: Date): string => {
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant)
    return `${clock.find((entry) => entry.type === 'hour')?.value ?? '00'}:${clock.find((entry) => entry.type === 'minute')?.value ?? '00'}`
  }
  return `${part('weekday')} ${part('day')} ${part('month')} ${part('year')}, ${time(startsAt)}–${time(endsAt)}`
}

export interface MailFacts {
  readonly kind: AppointmentKind
  readonly riderName: string | null
  readonly startsAt: Date
  readonly endsAt: Date
  readonly place: string
  /** Who of ours (or outside) the rider meets, when known. */
  readonly withWho: string | null
  /** The garment it is about, in words (the template's name), when known. */
  readonly garment: string | null
}

export type AppointmentMail = 'INVITE' | 'UPDATE' | 'REMINDER' | 'CANCEL'

/**
 * The words of a mail to the rider (no body data, no price, no link; the .ics travels beside it). The cancellation never says why
 * (the reason is the office's).
 */
export function appointmentMail(mail: AppointmentMail, language: MailLanguage, facts: MailFacts): { subject: string; body: string } {
  const what = appointmentKindWords(facts.kind, language)
  const when = whenWords(facts.startsAt, facts.endsAt, language)
  const garment = facts.garment ? ` (${facts.garment})` : ''
  if (language === 'it') {
    const hello = facts.riderName ? `Buongiorno ${facts.riderName},` : 'Buongiorno,'
    const with_ = facts.withWho ? `\nCon: ${facts.withWho}` : ''
    const block = `Quando: ${when}\nDove: ${facts.place}${with_}`
    if (mail === 'CANCEL') return { subject: `Annullato: ${what} del ${when}`, body: `${hello}\n\nla ${what}${garment} prevista per ${when} a ${facts.place} è annullata.\n\nScriveteci per fissare un'altra data.\n\nGrazie.` }
    if (mail === 'REMINDER') return { subject: `Promemoria: ${what} ${when}`, body: `${hello}\n\nvi ricordiamo la ${what}${garment}:\n\n${block}\n\nSe non potete venire, scriveteci.\n\nGrazie.` }
    if (mail === 'UPDATE') return { subject: `Nuova data: ${what} ${when}`, body: `${hello}\n\nla ${what}${garment} è cambiata:\n\n${block}\n\nIn allegato l'invito aggiornato per il calendario.\n\nGrazie.` }
    return { subject: `Appuntamento: ${what} ${when}`, body: `${hello}\n\nvi confermiamo la ${what}${garment}:\n\n${block}\n\nIn allegato l'invito per il calendario.\n\nGrazie.` }
  }
  const hello = facts.riderName ? `Hello ${facts.riderName},` : 'Hello,'
  const with_ = facts.withWho ? `\nWith: ${facts.withWho}` : ''
  const block = `When: ${when}\nWhere: ${facts.place}${with_}`
  if (mail === 'CANCEL') return { subject: `Cancelled: ${what} on ${when}`, body: `${hello}\n\nthe ${what}${garment} on ${when} at ${facts.place} is cancelled.\n\nWrite to us to book another date.\n\nThank you.` }
  if (mail === 'REMINDER') return { subject: `Reminder: ${what} ${when}`, body: `${hello}\n\na reminder of your ${what}${garment}:\n\n${block}\n\nIf you cannot come, write to us.\n\nThank you.` }
  if (mail === 'UPDATE') return { subject: `New date: ${what} ${when}`, body: `${hello}\n\nyour ${what}${garment} changed:\n\n${block}\n\nThe updated calendar invite is attached.\n\nThank you.` }
  return { subject: `Appointment: ${what} ${when}`, body: `${hello}\n\nwe confirm your ${what}${garment}:\n\n${block}\n\nThe calendar invite is attached.\n\nThank you.` }
}

// ---- a fitting's result ------------------------------------------------------------------------------------------------

export interface PointChangeInput {
  readonly change: string
  readonly unit?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface PointChange {
  readonly change: string
  readonly unit: PointUnit
  readonly note?: string
}

const CHANGE = /^[+-]?[0-9]{1,4}(\.[0-9]{1,2})?$/
const POINT_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/

/**
 * The point changes asked, checked against the profile's measures ({ code: { value, unit } }): each point one of them, the change
 * a signed decimal (up to 4 digits and 2 decimals, not zero) in the unit it was measured in (cm or mm; given or taken from the
 * profile), a note of one line (1 to 500); at most 60 points. Returns the stored form ({ code: { change, unit, note? } }) and the
 * problems at body/pointChanges/<code>/….
 */
export function pointChangesOf(asked: Readonly<Record<string, PointChangeInput>>, measured: Readonly<Record<string, { readonly value: string; readonly unit: string }>>): { changes: Record<string, PointChange>; problems: Issue[] } {
  const changes: Record<string, PointChange> = {}
  const problems: Issue[] = []
  const entries = Object.entries(asked)
  if (entries.length > FITTING_LIMITS.points) problems.push({ path: 'body/pointChanges', message: `A fitting asks changes to at most ${FITTING_LIMITS.points} points.` })
  for (const [code, entry] of entries.slice(0, FITTING_LIMITS.points)) {
    const at = `body/pointChanges/${code}`
    if (!POINT_CODE.test(code)) {
      problems.push({ path: at, message: `"${code.slice(0, 60)}" is not a point code.` })
      continue
    }
    const measure = measured[code]
    if (!measure) {
      problems.push({ path: at, message: `Point ${code} is not one of the measures of the revision fitted.` })
      continue
    }
    const change = entry.change.trim()
    if (!CHANGE.test(change) || Number(change) === 0) problems.push({ path: `${at}/change`, message: `The change of ${code} is a signed number, not zero, of up to 4 digits and 2 decimals ("+2.0", "-1.5").` })
    const measuredUnit = measure.unit.toLowerCase()
    const unit = (entry.unit ?? measuredUnit).toLowerCase()
    if (!(POINT_UNITS as readonly string[]).includes(unit)) problems.push({ path: `${at}/unit`, message: `The change of ${code} is in cm or mm.` })
    else if (measuredUnit !== '' && unit !== measuredUnit) problems.push({ path: `${at}/unit`, message: `The change of ${code} is in the unit it was measured in (${measuredUnit}).` })
    const note = entry.note?.trim() ?? ''
    if (entry.note !== undefined && entry.note !== null && (note === '' || note.length > FITTING_LIMITS.pointNote || !oneLine(note))) problems.push({ path: `${at}/note`, message: `The note of ${code}: 1 to ${FITTING_LIMITS.pointNote} characters of one line.` })
    changes[code] = { change: change.startsWith('+') || change.startsWith('-') ? change : `+${change}`, unit: unit as PointUnit, ...(note !== '' ? { note } : {}) }
  }
  return { changes, problems }
}

/** The verdict's own rules (see the file's head), each at its body field. */
export function verdictProblems(input: { readonly verdict: FittingVerdict; readonly points: number; readonly notes: string | null; readonly alterationDays: number | null }): Issue[] {
  const problems: Issue[] = []
  if (input.notes !== null && (input.notes.trim() === '' || input.notes.length > FITTING_LIMITS.notes)) problems.push({ path: 'body/notes', message: `The words: 1 to ${FITTING_LIMITS.notes} characters.` })
  if (input.verdict === 'OK' && input.points > 0) problems.push({ path: 'body/pointChanges', message: 'It fits: no point changes.' })
  if (input.verdict === 'ALTER' && input.points === 0 && input.notes === null) problems.push({ path: 'body/pointChanges', message: 'An alteration names the points to change, or says what to change in the words.' })
  if (input.verdict === 'REMAKE' && input.notes === null) problems.push({ path: 'body/notes', message: 'A remake says why the unit cannot be altered.' })
  if (input.alterationDays !== null) {
    if (input.verdict !== 'ALTER') problems.push({ path: 'body/alterationDays', message: 'Days only for an alteration.' })
    else if (!Number.isInteger(input.alterationDays) || input.alterationDays < 1 || input.alterationDays > FITTING_LIMITS.alterationDays) problems.push({ path: 'body/alterationDays', message: `The days the alteration adds: 1 to ${FITTING_LIMITS.alterationDays}.` })
  }
  return problems
}

/** The work an alteration asks, in words, from the point changes and the words ("Chest +2.0 cm; Sleeve -1.0 cm (shorter)"). */
export function alterationWords(changes: Readonly<Record<string, PointChange>>, names: Readonly<Record<string, string>>, notes: string | null, max = 2000): string {
  const points = Object.entries(changes).map(([code, change]) => `${names[code] ?? code} ${change.change} ${change.unit}${change.note ? ` (${change.note})` : ''}`)
  const words = [points.length > 0 ? points.join('; ') : null, notes].filter((part): part is string => part !== null && part.trim() !== '').join('. ')
  return (words === '' ? 'Alteration after the fitting.' : words).slice(0, max)
}

/** What comes next after a fitting result, in words (null: nothing). */
export function nextStepOf(result: { readonly verdict: FittingVerdict; readonly alterationRepairId: string | null; readonly newProfileId: string | null; readonly salesOrderLineId: string | null }): string | null {
  if (result.verdict === 'OK') return null
  if (result.verdict === 'ALTER') return result.alterationRepairId ? null : 'Open the alteration (the garment goes to the alteration workshop with the changes asked).'
  if (!result.newProfileId) return 'Measure the rider again (a new revision of the measures), then make the remake from the return of the unit.'
  return 'Make the remake from the return of the unit, on the new revision once the factory confirmed it.'
}

// ---- a remake --------------------------------------------------------------------------------------------------------------

/** Why a remade unit's goods cannot go `outcome` (null: they can). */
export function remakeOutcomeProblem(outcome: string): string | null {
  return (REMAKE_OUTCOMES as readonly string[]).includes(outcome) ? null : 'A remade unit was made to a body: it is scrapped or held in quarantine, never put back into stock.'
}

/**
 * Why the remake cannot be made to the revision named (null: it can): the revision the unit was made to, or the rider's newest
 * revision of the same garment type (a fitting's new measures).
 */
export function remakeProfileProblem(madeTo: { readonly id: string; readonly revision: number; readonly partyId: string; readonly riderName: string; readonly garmentType: string }, named: { readonly id: string; readonly revision: number; readonly partyId: string; readonly riderName: string; readonly garmentType: string }, newestRevision: number): string | null {
  if (named.id === madeTo.id) return null
  if (named.partyId !== madeTo.partyId || named.riderName !== madeTo.riderName || named.garmentType !== madeTo.garmentType) return `A remake is made to ${madeTo.riderName}'s ${madeTo.garmentType} measures: the revision it was made to (${madeTo.revision}) or the newest.`
  if (named.revision !== newestRevision) return `Revision ${named.revision} is not the newest (revision ${newestRevision} is): remake to the revision it was made to (${madeTo.revision}) or to the newest.`
  return null
}
