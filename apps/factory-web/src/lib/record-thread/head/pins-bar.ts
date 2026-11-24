/**
 * tw- W2.1 (THE THREAD REBUILD; 10-design §8; W-080 / W-081, P11, Z7, Z14, R12): the pinned bar under the head — one line
 * "Sender: text" of the newest pin first; each click goes to that message (the host's one door: older pages read, the row lit) and the
 * bar moves to the next older pin; marks at the left say how many (a window of 4 when there are more, up to the 50 the server keeps).
 * A pin of an office note shows a lock; a floor writer the site's gate keeps back is "A person on the floor" (R12: the server sends no
 * name); an erased message "Message removed". Pins have no live event (Z7): a colleague's pin shows with the next read. Pure.
 */

/** A pin as GET …/pins answers it (the office's read). */
export interface PinInput {
  readonly messageId: string
  readonly pinnedAt: string
  readonly message: {
    readonly authorName: string | null
    readonly excerpt: string
    readonly audience?: 'OFFICE' | 'PARTNER' | undefined
    readonly attachmentCount: number
    readonly removed: boolean
    /** tw-s (office): the writer's kind; a WORKER with no name is kept back by the site's gate. */
    readonly authorKind?: 'USER' | 'WORKER' | 'PARTY' | 'SYSTEM' | undefined
  }
}

/** One pin as the bar says it. */
export interface BarPin {
  readonly messageId: string
  readonly pinnedAt: string
  /** The writer's name; null: removed, or a writer kept back (`hidden`). */
  readonly author: string | null
  /** A floor writer the site's gate keeps back (R12): "A person on the floor". */
  readonly hidden: boolean
  readonly excerpt: string
  /** An office note: a lock (the customer never reads it, nor its pin). */
  readonly office: boolean
  readonly files: number
  readonly removed: boolean
}

/** At most this many marks; past it a window of them, the current one inside. */
export const BAR_MARKS = 4

/** The bar's pins, newest pin first (P11). */
export function barPinsOf(pins: readonly PinInput[]): BarPin[] {
  return pins
    .map((pin) => {
      const removed = pin.message.removed
      const hidden = !removed && pin.message.authorName === null && pin.message.authorKind !== 'SYSTEM'
      return { messageId: pin.messageId, pinnedAt: pin.pinnedAt, author: removed ? null : pin.message.authorName, hidden, excerpt: removed ? '' : pin.message.excerpt, office: pin.message.audience === 'OFFICE', files: pin.message.attachmentCount, removed }
    })
    .sort((a, b) => (a.pinnedAt === b.pinnedAt ? a.messageId.localeCompare(b.messageId) : a.pinnedAt < b.pinnedAt ? 1 : -1))
}

/** Where the bar stands: the pin it shows, its place, the marks (the current one on), and the pin the next click shows. */
export interface BarState {
  readonly pin: BarPin
  readonly index: number
  readonly count: number
  readonly marks: readonly boolean[]
  readonly next: number
}

export function barState(pins: readonly BarPin[], index: number): BarState | null {
  const count = pins.length
  if (count === 0) return null
  const at = ((Math.trunc(index) % count) + count) % count
  const shown = Math.min(BAR_MARKS, count)
  const start = Math.min(Math.max(0, at - (shown - 1)), count - shown)
  return { pin: pins[at]!, index: at, count, marks: Array.from({ length: shown }, (_, mark) => start + mark === at), next: (at + 1) % count }
}

/** The bar's words: who (a name, or the words of a key of record-thread-card; null: none) and what (the words, or a key). */
export function barWords(pin: BarPin): { readonly who: { readonly text: string } | { readonly key: string } | null; readonly what: { readonly text: string } | { readonly key: string; readonly count?: number } } {
  const who = pin.removed ? null : pin.hidden ? { key: 'author.floorPerson' } : pin.author ? { text: pin.author } : { key: 'author.SYSTEM' }
  if (pin.removed) return { who, what: { key: 'quote.removed' } }
  if (pin.excerpt.trim() === '' && pin.files > 0) return { who, what: { key: 'quote.files', count: pin.files } }
  return { who, what: { text: pin.excerpt } }
}
