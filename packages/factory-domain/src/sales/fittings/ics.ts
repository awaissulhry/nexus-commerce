/**
 * The calendar invite of an appointment (B-W2b-360; SAL-054; design mtm.fitting "Invite (.ics) to the rider"): an iCalendar
 * object (RFC 5545) with one VEVENT, METHOD REQUEST for the invite and its updates, CANCEL for the cancellation. The UID is the
 * appointment's (`appointment-<id>@<domain>`), the SEQUENCE its version when the mail was made (it only grows, so a calendar
 * replaces the older copy). Times in UTC. Text escaped (backslash, semicolon, comma, line break) and every line folded at 75
 * octets; lines end in CRLF. Pure: the API attaches the bytes to the mail.
 */

export interface IcsInput {
  readonly method: 'REQUEST' | 'CANCEL'
  readonly appointmentId: string
  /** The sending domain (the mail identity's), for a UID unique in the world. */
  readonly domain: string
  readonly sequence: number
  readonly stamp: Date
  readonly startsAt: Date
  readonly endsAt: Date
  readonly summary: string
  readonly location: string
  readonly description: string
  readonly organizer: { readonly name: string | null; readonly email: string }
  readonly attendee: { readonly name: string | null; readonly email: string }
}

const two = (value: number): string => String(value).padStart(2, '0')

/** "20261202T090000Z". */
export function icsTime(instant: Date): string {
  return `${instant.getUTCFullYear()}${two(instant.getUTCMonth() + 1)}${two(instant.getUTCDate())}T${two(instant.getUTCHours())}${two(instant.getUTCMinutes())}${two(instant.getUTCSeconds())}Z`
}

/** A TEXT value escaped (RFC 5545 §3.3.11). */
export function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
}

/** A parameter value (CN): quoted, without the characters a quoted value cannot hold. */
const param = (value: string): string => `"${value.replace(/["\r\n]/g, '').slice(0, 200)}"`

/** One content line folded at 75 octets (RFC 5545 §3.1), never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const parts: string[] = []
  let current = ''
  let octets = 0
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8')
    const limit = parts.length === 0 ? 75 : 74
    if (octets + size > limit) {
      parts.push(current)
      current = ''
      octets = 0
    }
    current += char
    octets += size
  }
  parts.push(current)
  return parts.join('\r\n ')
}

const mailto = (who: { readonly name: string | null; readonly email: string }, prefix: string): string => `${prefix}${who.name ? `;CN=${param(who.name)}` : ''}:mailto:${who.email}`

/** The whole iCalendar object, CRLF line ends. */
export function appointmentIcs(input: IcsInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nexus Factory//Fittings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:appointment-${input.appointmentId}@${input.domain}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${icsTime(input.stamp)}`,
    `DTSTART:${icsTime(input.startsAt)}`,
    `DTEND:${icsTime(input.endsAt)}`,
    `SUMMARY:${icsText(input.summary)}`,
    `LOCATION:${icsText(input.location)}`,
    `DESCRIPTION:${icsText(input.description)}`,
    mailto(input.organizer, 'ORGANIZER'),
    mailto(input.attendee, 'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE'),
    `STATUS:${input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}
