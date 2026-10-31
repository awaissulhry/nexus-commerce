/**
 * `ReadAloudButton`'s words (B-W2b-28, D27). English by default; a host passes the words it translates.
 */
export interface ReadAloudLabels {
  /** The button at rest. */
  read: string
  /** The button while reading. */
  stop: string
  /** The voice that reads, named under the button: "Voice: Alice". */
  voice: (name: string) => string
}

export const READ_ALOUD_LABELS: ReadAloudLabels = {
  read: 'Read aloud',
  stop: 'Stop reading',
  voice: (name) => `Voice: ${name}`,
}
