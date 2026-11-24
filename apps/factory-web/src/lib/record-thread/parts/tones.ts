/**
 * tw- W1.1 (THE THREAD REBUILD; 10-design §3 "Tones", 13-backend §3.5): ONE colour per sender — the name line, the 28 px tile and
 * the quote bar of a person draw the same DS group tone in every host (`--nds-grid-tone-<tone>-fg` / `-bg`, AA+ in light and dark).
 * A stable hash of the sender key picks one of six tones, so a name has the same colour on the order, the customer, Incoming and a
 * window. Yellow and red are never a person's (yellow says "office note, not sent to the customer"; red says error). Slate is kept for
 * whoever has no key: a floor writer the site's gate keeps back (R5: never a person colour) and the system. Pure.
 */

/**
 * The person tones, in the DS's group-tone order (packages/ui tokens groupTones). tw- fx2 (walk G-7: four people, two colours): every
 * DS group tone but yellow (the office note's) and slate (no key) — eight.
 */
/** The person tones: never yellow (the one yellow = not sent to the customer) and never red (red = an error, a bounce) — 10-design § 3. */
export const SENDER_TONES = ['purple', 'emerald', 'pink', 'orange', 'blue', 'cyan', 'violet'] as const
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
  // tw- fx2 (G-7): a stronger mix of the bits (murmur3's finaliser), so close keys ("USER:…1", "USER:…2") spread over the tones.
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

/** The tone of a sender key (`USER:<id>`, `PARTY:<id>`, `PARTY~<name>`, `WORKER:<id>`); slate without a key. */
export function senderTone(senderKey: string | null | undefined): SenderTone {
  if (!senderKey) return 'slate'
  return SENDER_TONES[hashOf(senderKey) % SENDER_TONES.length]
}

/**
 * tw- fx2 (walk G-7): ONE colour per person INSIDE a list — each sender keeps its own tone; when two senders of the loaded list would
 * share one, the later in sorted sender-key order takes the next free tone (deterministic: the same list, the same colours).
 */
export function tonesFor(senderKeys: ReadonlyArray<string | null | undefined>): ReadonlyMap<string, SenderTone> {
  const keys = [...new Set(senderKeys.filter((key): key is string => Boolean(key)))].sort()
  const used = new Set<PersonTone>()
  const tones = new Map<string, SenderTone>()
  for (const key of keys) {
    const start = hashOf(key) % SENDER_TONES.length
    let pick: PersonTone = SENDER_TONES[start]!
    for (let step = 0; step < SENDER_TONES.length; step += 1) {
      const tone = SENDER_TONES[(start + step) % SENDER_TONES.length]!
      if (!used.has(tone)) {
        pick = tone
        break
      }
    }
    used.add(pick)
    tones.set(key, pick)
  }
  return tones
}

/** The class that sets `--fw-rt-tone-bg` / `--fw-rt-tone-fg` for a tone (parts.css). */
export const toneClass = (tone: SenderTone): string => `fw-rt-tone-${tone}`
