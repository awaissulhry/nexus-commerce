import { isQuietLineKey, QUIET_SIDES, type QuietLineKey } from '@nexus/factory-domain/threads/quiet-lines'

/**
 * owb-po6.4 (design § 5zi F "a change that speaks in the chat"; R61 a) — a quiet line in the customer's conversation: a small line in the
 * middle, with its time, no bubble, no face. Its words come from the event's key and args (`event: { key, args, count }`, server po2.3;
 * the keys are the domain's ONE list `QUIET_LINE_KEYS`), never from the stored English body. The side is said, never a person: "The
 * factory" (any office person) or "Your team" (`args.by`: FACTORY | CUSTOMER). An unknown key draws nothing. Pure.
 */

export interface QuietEvent {
  readonly key: string
  readonly args: Readonly<Record<string, string | number>>
  /** One side's lines of one key, consecutive, inside 10 minutes, as ONE line (the read groups them). */
  readonly count: number
}

type Words = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The line's words in the reader's language, or null (an unknown key, a side the read does not name: nothing is drawn). */
export function quietLineOf(event: QuietEvent | null | undefined, t: Words): string | null {
  if (!event || !isQuietLineKey(event.key)) return null
  const by = typeof event.args.by === 'string' && (QUIET_SIDES as readonly string[]).includes(event.args.by) ? event.args.by : 'FACTORY'
  const key: QuietLineKey = event.key
  const parts = [t(`quiet.${key.slice('quiet.'.length)}.${by}`)]
  // The details the args carry, when they do (short values only: the line's words, its pieces, a file's or a column's name, a day).
  if (typeof event.args.words === 'string' && event.args.words.trim()) parts.push(t('quiet.detail.words', { words: event.args.words.trim() }))
  if (typeof event.args.pieces === 'number') parts.push(t('quiet.detail.pieces', { count: event.args.pieces }))
  if (typeof event.args.name === 'string' && event.args.name.trim()) parts.push(t('quiet.detail.words', { words: event.args.name.trim() }))
  if (event.count > 1) parts.push(t('quiet.detail.count', { count: event.count }))
  return parts.join('')
}
