/**
 * The owner digest's and alert routes' rules the database holds (factory-db …_insights_depth_w2b_guards, B-W2b-381) read back from
 * the database's own words, pure (B-W2b-435). The routes of apps/factory-api modules/insights/digest and platform/alerts/routes check
 * these first, in words; when a write still reaches a rule (a race: the company's switch turned off between the read and the send,
 * a role archived meanwhile), the API answers 409 in these words (core/errors) instead of a 500.
 */

export const DIGEST_REFUSAL_ISSUES = Object.freeze({
  mailOff: 'digest/MAIL_OFF',
  office: 'digest/OFFICE_PERSON',
  state: 'digest/STATE',
  kept: 'digest/KEPT',
  sendTime: 'body/sendTime',
  weekdays: 'body/weekdays',
  locale: 'body/locale',
  timeZone: 'body/timeZone',
  sections: 'body/sections',
  switchState: 'switch/STATE',
  routeWider: 'route/WIDER',
  routePlace: 'route/PLACE',
  routeWho: 'route/WHO',
  routeKept: 'route/KEPT',
} as const)

const MAIL_OFF = /^digest: digest \S+ goes out only while/
const OFFICE = /^digest: digest \S+ is an office person/
const SENT_ORDER = /^digest: (digest \S+ did not go out in the future|the last time digest \S+ went out only moves forward|digest \S+ is set before it first goes out)/
const STATE = /^digest: (digest \S+ is turned on with when and by whom|while digest \S+ is on)/
const KEPT = /^digest: (the person and the key of digest|the key of digest)/
const TIME = /^digest: digest \S+ goes out at a time of day/
const DAYS = /^digest: digest \S+ goes out on ISO weekdays/
const LOCALE = /^digest: digest \S+ is written in Italian/
const ZONE = /^digest: digest \S+ keeps the clock of a known time zone/
const SECTIONS = /^digest: digest \S+ lists at least one section/
const SWITCH = /^insights: (the company and the key of settings|the key of settings|the morning e-mail of company|while the morning e-mail of company|the settings of company)/
const ROUTE_WIDER = /^alerts: route \S+ never widens its rule/
const ROUTE_PLACE = /^alerts: route \S+ names a \S+ that does not exist/
const ROUTE_WHO = /^alerts: route \S+ tells (the holders of one office role or one office person|an office person who is invited or active|the holders of an office role that is not archived)/
const ROUTE_KEPT = /^alerts: (route \S+ is added or removed, never changed|the key of route)/

/** The words and issue path of a refusal of the database's digest, switch and route rules, or null when the message is another one. */
export function databaseDigestRefusal(message: string): { readonly path: string; readonly message: string } | null {
  const I = DIGEST_REFUSAL_ISSUES
  if (MAIL_OFF.test(message)) return { path: I.mailOff, message: "The morning e-mail goes out only while it is on and its company's morning e-mail is switched on." }
  if (OFFICE.test(message)) return { path: I.office, message: 'The morning e-mail is for office people only.' }
  if (SENT_ORDER.test(message)) return { path: I.state, message: 'The morning e-mail was marked as sent by another run meanwhile: nothing more to do.' }
  if (STATE.test(message)) return { path: I.state, message: 'The morning e-mail changed meanwhile: read it again and save once more.' }
  if (KEPT.test(message)) return { path: I.kept, message: 'A morning e-mail stays the person’s own: it is never moved to someone else.' }
  if (TIME.test(message)) return { path: I.sendTime, message: 'A time of day is HH:MM (07:30).' }
  if (DAYS.test(message)) return { path: I.weekdays, message: 'Weekdays are 1 (Monday) to 7 (Sunday), ascending, each once, at least one.' }
  if (LOCALE.test(message)) return { path: I.locale, message: 'The morning e-mail is written in Italian or English.' }
  if (ZONE.test(message)) return { path: I.timeZone, message: 'Choose a known time zone (Europe/Rome).' }
  if (SECTIONS.test(message)) return { path: I.sections, message: 'Choose at least one section, each once.' }
  if (SWITCH.test(message)) return { path: I.switchState, message: "The company's morning e-mail switch changed meanwhile: read it again and switch once more." }
  if (ROUTE_WIDER.test(message)) return { path: I.routeWider, message: 'A route never reaches wider than its rule: choose a place inside the rule’s company or site.' }
  if (ROUTE_PLACE.test(message)) return { path: I.routePlace, message: 'That place does not exist (a customer is a party we sell to, or a brand).' }
  if (ROUTE_WHO.test(message)) return { path: I.routeWho, message: 'A route tells the holders of one office role that is not archived, or one active office person.' }
  if (ROUTE_KEPT.test(message)) return { path: I.routeKept, message: 'A route is added or removed, never changed: remove it and add a new one.' }
  return null
}
