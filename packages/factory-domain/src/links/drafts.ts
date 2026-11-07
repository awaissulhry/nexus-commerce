/**
 * A long form's draft kept with us (design links.frame "Finish later": "Long forms (measurements, questionnaire, claim)
 * keep a draft with the sender, never on the device"; links-depth.prisma LinkDraft). Only a MEASUREMENTS, CLAIM or
 * SUPPLIER_ONBOARD link keeps one (links/purposes `draft`), one per link, saved and resumed from the same link while it
 * opens; a save is never a counted use. The data may hold personal and body data, so it is sealed (AES-256-GCM, the API's
 * seal) inside an envelope that names its link: a sealed draft copied onto another link opens nothing. The office never
 * reads it; the form's own send drops it, and the purge job deletes it 7 days after its link expired.
 */

/** A draft lives until its link's expiry plus this many days (the database checks `purgeAfter` exactly). */
export const DRAFT_KEEP_DAYS = 7

/** The most a draft's envelope may hold, in UTF-8 bytes (sealed it stays under the database's 256 KiB). */
export const DRAFT_MAX_BYTES = 180 * 1024

const DAY_MS = 24 * 60 * 60 * 1000

/** When the purge job deletes the draft of a link that expires at `expiresAt`. */
export const draftPurgeAfter = (expiresAt: Date): Date => new Date(expiresAt.getTime() + DRAFT_KEEP_DAYS * DAY_MS)

/** The text that is sealed: the data with its link's id. */
export function draftEnvelope(linkId: string, data: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ v: 1, linkId: linkId.toLowerCase(), data })
}

/** The data of an opened envelope, or null when it is not this link's (or not an envelope at all). */
export function draftData(linkId: string, opened: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(opened) as { v?: unknown; linkId?: unknown; data?: unknown }
    if (parsed.v !== 1 || parsed.linkId !== linkId.toLowerCase()) return null
    const data = parsed.data
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The envelope's size problem, or null. */
export function draftSizeProblem(envelope: string): string | null {
  return Buffer.byteLength(envelope, 'utf8') > DRAFT_MAX_BYTES ? `The draft is too large to keep (at most ${Math.floor(DRAFT_MAX_BYTES / 1024)} KiB). Send the form, or leave out the photos.` : null
}
