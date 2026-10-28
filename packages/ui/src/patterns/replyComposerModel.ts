/**
 * ReplyComposer — the pure rules (Reviews parts, 2026-10-26). No React, so Node tests cover them.
 *
 * The composer is the same for every channel: the page passes the channel's limit and rule line (from `@nexus/shared`
 * `reviewReplyRules()`), and the composer counts, words the counter and says why the send is held. Reasons, first
 * that applies wins:
 *   1. the page's own reason (no "Manage reviews" permission, the reply window closed…)
 *   2. the reply was already sent — it cannot be sent again
 *   3. the text is over the limit — "Cut 38 characters"
 *   4. there is no text yet — "Write a reply first."
 * Characters are counted as a person sees them (the Textarea counter's rule).
 */
import { charactersOver, countCharacters } from '../primitives/textareaCounter'

export interface ReplyHeldInput {
  /** The page's reason (permission, a closed window), or null. */
  held?: string | null
  /** The reply was sent already. */
  sent?: boolean
  text: string
  limit: number | null
}

export const REPLY_SENT_HELD = 'This reply was sent. A sent reply cannot be sent again.'
export const REPLY_EMPTY_HELD = 'Write a reply first.'

/** "Cut 38 characters to send it (the limit is 500)." */
export function replyOverWords(over: number, limit: number): string {
  return `Cut ${over.toLocaleString('en-US')} ${over === 1 ? 'character' : 'characters'} to send it (the limit is ${limit.toLocaleString('en-US')}).`
}

/** Why the send is held, or null when it may run. */
export function replyHeldReason({ held, sent, text, limit }: ReplyHeldInput): string | null {
  if (held) return held
  if (sent) return REPLY_SENT_HELD
  const over = charactersOver(countCharacters(text), limit)
  if (limit != null && over > 0) return replyOverWords(over, limit)
  if (text.trim().length === 0) return REPLY_EMPTY_HELD
  return null
}

/** The counter when there is no limit: "312 characters", "1 character". */
export function replyLengthWords(text: string): string {
  const n = countCharacters(text)
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'character' : 'characters'}`
}
