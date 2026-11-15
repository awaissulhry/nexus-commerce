import type { SavedReply } from './api'

/**
 * The send panel's Message from a template (B-W2b-432; design shell.preview sec:send-panel "Message (template per language,
 * W2b)"): the message templates of the language on screen, one picked fills the message box with the record's values (the
 * names it had no value for said, the box still the person's), and what the person had written can be put back. Pure.
 */

export interface MessageTemplateModel {
  status: 'loading' | 'ready' | 'failed' | 'none'
  /** Shared ones first, then the reader's own, each by name. */
  replies: readonly Pick<SavedReply, 'id' | 'name' | 'shared'>[]
  pickedId: string | null
  filling: boolean
  /** The placeholders the record had no value for (left empty in the message). */
  missing: readonly string[]
  /** A refused fill, as a key of `admin-templates` or `send`. */
  problem: string | null
  /** The message as the person had it before the pick (null: nothing to put back). */
  previous: string | null
}

export const NO_TEMPLATES: MessageTemplateModel = { status: 'none', replies: [], pickedId: null, filling: false, missing: [], problem: null, previous: null }

/** Shared first, then one's own; each group by name in the reader's language. */
export function orderedReplies(replies: readonly SavedReply[], locale: string): SavedReply[] {
  return [...replies].sort((a, b) => Number(b.shared) - Number(a.shared) || a.name.localeCompare(b.name, locale))
}
