import type { RecipientLanguage } from './api'

/**
 * The send panel's language (B-W2b-432; design shell.preview sec:language-version "Language: Italiano / English
 * (SegmentedControl; the partner contact's language is preselected, PLT-131 W2b)" — "changing language re-renders the same
 * version; nothing in the record changes"). The pick re-renders the preview and lists the message templates of that
 * language; the document itself goes out in the record's own language, so Send waits while the two differ (the host's Fix
 * link changes the record's language). Pure.
 */

export type SendLanguageCode = 'it' | 'en'

export interface SendLanguageModel {
  /** The language on screen: the contact's, preselected, until the person picks the other one. */
  picked: SendLanguageCode
  /** The language the record's document is written in and goes out in. */
  documentLanguage: SendLanguageCode
  /** The contact's language as the API worked it out (null while read, when it failed, or without the right to read it). */
  recipient: Pick<RecipientLanguage, 'language' | 'source' | 'notOffered'> | null
  status: 'loading' | 'ready' | 'failed' | 'none'
  /** Where the record's language is changed (the host's tab), for the line under a mismatch. */
  fix?: { label: string; href: string } | null
}

/** The language preselected when the contact's is known: theirs; else the document's. */
export const preselected = (recipient: Pick<RecipientLanguage, 'language'> | null, documentLanguage: SendLanguageCode): SendLanguageCode => recipient?.language ?? documentLanguage

/** Why Send waits for the language (a key of `admin-templates`), or null: the language on screen is not the document's. */
export const languageHeld = (model: Pick<SendLanguageModel, 'picked' | 'documentLanguage'> | null): string | null => (model && model.picked !== model.documentLanguage ? 'tpl.send.held.language' : null)

/** The contact reads the other language than the document is written in (said even after the person picks the document's). */
export const recipientDiffers = (model: Pick<SendLanguageModel, 'recipient' | 'documentLanguage'>): boolean => !!model.recipient && model.recipient.language !== model.documentLanguage
