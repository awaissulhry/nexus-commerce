/**
 * PartnerThread's rules (B-W2b-155, design part PartnerThread = the partner side of a record's thread, anatomy D17).
 * Pure. The model has two sides only — our company and the partner — and NO internal note: an office note can never be
 * passed to this part, because there is no kind for it.
 */

/** Who wrote it: our company (by mail or in the app) or the partner (a reply by mail, or in the portal). */
export type PartnerSide = 'company' | 'partner'
/** How it came: `email` (our mail, or their reply to it), `portal` (written in the portal), `app` (by us in the app). */
export type PartnerChannel = 'email' | 'portal' | 'app'

export const PARTNER_SIDES = ['company', 'partner'] as const satisfies readonly PartnerSide[]
export const PARTNER_CHANNELS = ['email', 'portal', 'app'] as const satisfies readonly PartnerChannel[]

export interface PartnerAuthor {
  /** The person's name; null when not known (our company's mail, a colleague not named). */
  name: string | null
  /** The reader wrote it. */
  mine: boolean
}

/**
 * The name a message shows: "You" for the reader's own, the person's name, our company's name for our unnamed mail,
 * "Your team" for an unnamed message of the reader's organisation.
 */
export function partnerAuthorName(
  message: { side: PartnerSide; author: PartnerAuthor },
  companyName: string,
  words: { you: string; yourTeam: string },
): string {
  if (message.author.mine) return words.you
  const name = message.author.name?.trim()
  if (name) return name
  return message.side === 'company' ? companyName : words.yourTeam
}

/** Why Send is held: it is sending, or there is nothing to send (no text, no file). Null when it can send. */
export function partnerSendHeld(
  input: { value: string; busy?: boolean; attached?: number },
  words: { sending: string; emptyHeld: string },
): string | null {
  if (input.busy) return words.sending
  if (input.value.trim() === '' && !(input.attached && input.attached > 0)) return words.emptyHeld
  return null
}

/** The attached ids with `id` added or taken out, in the order of `all` (the files the record shares). */
export function partnerToggleFile(attached: readonly string[], id: string, all: readonly { id: string }[]): string[] {
  const set = new Set(attached)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  return all.map((file) => file.id).filter((fileId) => set.has(fileId))
}
