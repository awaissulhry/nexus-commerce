import type { PartnerChannel } from './partnerThreadModel'

/**
 * `PartnerThread`'s words (B-W2b-155). English by default; a host passes the words it translates. A word with a number
 * or a value in it is a function: the host writes its own plural forms.
 */
export interface PartnerThreadLabels {
  /** The heading when the page gives none. */
  title: string
  /** The list's name for a screen reader. */
  conversation: string
  /** The reader's own messages. */
  you: string
  /** A message of the reader's organisation whose writer is not named. */
  yourTeam: string
  /** How each message came: by e-mail, in the portal, from our team in the app. */
  channels: Record<PartnerChannel, string>
  /** A message's name for a screen reader: "Message from Anna Rossi, 3 Nov 10:42". */
  messageFrom: (who: string, time: string) => string
  /** The attachments' list name. */
  attachments: string
  /** No message yet. */
  empty: string
  /** The messages are being read. */
  loading: string
  /** They could not be read. */
  failed: string
  retry: string
  /** Shows the messages before the first one drawn. */
  earlier: string
  /** Earlier messages are being read (the held button's words). */
  reading: string
  /** The message box's label. */
  composer: string
  send: string
  /** Sending (the held Send's words). */
  sending: string
  /** Send held: nothing written or attached. */
  emptyHeld: string
  /** The legend of the files that can be attached. */
  attach: string
  /** Under it. */
  attachHint: string
  /** Beside Send: "1 file attached". */
  attached: (count: number) => string
}

export const PARTNER_THREAD_LABELS: PartnerThreadLabels = {
  title: 'Messages',
  conversation: 'Conversation',
  you: 'You',
  yourTeam: 'Your team',
  channels: { email: 'By e-mail', portal: 'In the portal', app: 'In the portal' },
  messageFrom: (who, time) => `Message from ${who}, ${time}`,
  attachments: 'Attached files',
  empty: 'No messages yet. Ask your question below.',
  loading: 'Reading the messages…',
  failed: 'The messages could not be read.',
  retry: 'Try again',
  earlier: 'Earlier messages',
  reading: 'Reading…',
  composer: 'Your message',
  send: 'Send',
  sending: 'Sending…',
  emptyHeld: 'Write a message first.',
  attach: 'Attach files of this record',
  attachHint: 'Only files already shared with you can be attached.',
  attached: (count) => (count === 1 ? '1 file attached' : `${count} files attached`),
}
