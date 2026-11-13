import { TEXTAREA_LABELS, type TextareaLabels } from '../primitives/TextareaLabels'
import { REPLY_EMPTY_HELD, REPLY_SENT_HELD, replyOverWords } from './replyComposerModel'

/**
 * `ReplyComposer`'s words (B-W2b-F41). English by default; `title`, `label` and `placeholder` still win over them.
 */
export interface ReplyComposerLabels {
  /** The heading when no `title` is passed: "Reply". */
  title: string
  /** The section's name when no `label` is passed: "Reply". */
  label: string
  /** The field's empty text when no `placeholder` is passed. */
  placeholder: string
  /** The templates menu: "Templates". */
  templates: string
  /** "Draft with AI" */
  draft: string
  /** Why Draft with AI waits while a draft is written. */
  drafting: string
  /** Why the send button waits while the reply is sent. */
  sending: string
  /** The mark on a sent reply: "Sent". */
  sent: string
  /** The text field's name for a screen reader: "Reply text". */
  text: string
  /** Above the English line of a draft in another language: "In English, only for you". */
  englishOnly: string
  /** Why the send is held after the reply was sent. */
  sentHeld: string
  /** Why the send is held with no text: "Write a reply first." */
  emptyHeld: string
  /** Why the send is held over the limit: "Cut 38 characters to send it (the limit is 500)." */
  over: (over: number, limit: number) => string
  /** The counter when there is no limit: "312 characters". */
  length: (count: number) => string
  /** The text field's counter words (with a limit). */
  textarea: TextareaLabels
}

export const REPLY_COMPOSER_LABELS: ReplyComposerLabels = {
  title: 'Reply',
  label: 'Reply',
  placeholder: 'Write a reply, pick a template or draft one with AI',
  templates: 'Templates',
  draft: 'Draft with AI',
  drafting: 'Drafting a reply… this takes a few seconds.',
  sending: 'This takes a few seconds.',
  sent: 'Sent',
  text: 'Reply text',
  englishOnly: 'In English, only for you',
  sentHeld: REPLY_SENT_HELD,
  emptyHeld: REPLY_EMPTY_HELD,
  over: (over, limit) => replyOverWords(over, limit),
  length: (count) => `${count.toLocaleString('en-US')} ${count === 1 ? 'character' : 'characters'}`,
  textarea: TEXTAREA_LABELS,
}
