/**
 * tw- W1.1 (THE THREAD REBUILD; 10-design §3 "Tones", 13-backend §3.5): ONE colour per sender — the name line, the 28 px tile and
 * the quote bar of a person draw the same DS group tone in every host (`--nds-grid-tone-<tone>-fg` / `-bg`, AA+ in light and dark).
 * A stable hash of the sender key picks one of six tones, so a name has the same colour on the order, the customer, Incoming and a
 * window. Yellow and red are never a person's (yellow says "office note, not sent to the customer"; red says error). Slate is kept for
 * whoever has no key: a floor writer the site's gate keeps back (R5: never a person colour) and the system. Pure.
 */

/** The six person tones, in the DS's group-tone order (packages/ui tokens groupTones). */
export const SENDER_TONES = ['purple', 'emerald', 'pink', 'orange', 'blue', 'cyan'] as const
export type PersonTone = (typeof SENDER_TONES)[number]
/** A person's tone, or slate: no key (a hidden floor writer, the system). */
export type SenderTone = PersonTone | 'slate'

/** FNV-1a over the key's UTF-16 units: the same key, the same number, in every browser and on the server render. */
function hashOf(key: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** The tone of a sender key (`USER:<id>`, `PARTY:<id>`, `PARTY~<name>`, `WORKER:<id>`); slate without a key. */
export function senderTone(senderKey: string | null | undefined): SenderTone {
  if (!senderKey) return 'slate'
  return SENDER_TONES[hashOf(senderKey) % SENDER_TONES.length]
}

/** The class that sets `--fw-rt-tone-bg` / `--fw-rt-tone-fg` for a tone (parts.css). */
export const toneClass = (tone: SenderTone): string => `fw-rt-tone-${tone}`
