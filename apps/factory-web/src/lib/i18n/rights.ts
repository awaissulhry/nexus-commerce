import type { Dictionary } from './messages'

/**
 * B-W2b-F51: a right in words, never its permission code. A person reads "Needs the right “See the bank statements and
 * their lines”", never `payments.bank.view`. The words are the role screens' own (Admin › Roles & permissions): the
 * `perm.<permission with _>` keys of `messages/<locale>/admin.json`, which the admin-screens test makes complete for every
 * permission. There is no second list of words.
 *
 * One way for every page: a caller passes `rightRef(permission)` as a message parameter (`t('held.permission',
 * { right: rightRef('files.read') })`, or a model's phrase `{ key, params: { right: rightRef('files.read') } }`), and
 * every translator (lib/i18n/messages createTranslator) says it in the page's language. Code that holds a language may
 * also ask `rightWords(locale, permission)` (messages.ts) directly.
 */

/** The message key of a permission's words in the admin catalogue (`perm.inventory_issue_over`). */
export const permissionKey = (name: string) => `perm.${name.replace(/\./g, '_')}`

/** The admin key of the words said when a right has no words of its own (never shown while the catalogue is complete). */
export const UNNAMED_RIGHT_KEY = 'held.unnamedRight'

// A private-use character starts a reference: no message text and no typed value starts with it.
const PREFIX = 'right:'

/** A message parameter that the translator turns into the right's words in the page's language. */
export const rightRef = (permission: string): string => `${PREFIX}${permission}`

/** The permission a parameter refers to, or null when it is an ordinary value. */
export function rightOf(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith(PREFIX) ? value.slice(PREFIX.length) : null
}

/**
 * The role screens' words of a right, said short enough to sit in a sentence: what they say before a colon, a semicolon
 * or a dash, without remarks in brackets ("See a customer's credit with a company: the limit, what is used, …" → "See a
 * customer's credit with a company"). When that is one or two words before a colon ("Protected: see …"), the words after
 * it. The role matrix keeps showing the whole sentence.
 */
export function headlineOf(words: string): string {
  const plain = words.replace(/\s*\([^()]*\)/g, '').trim()
  const parts = plain.split(/: |; | — /)
  let head = parts[0] ?? plain
  if (head.split(/\s+/).length <= 2 && parts.length > 1 && plain.slice(head.length, head.length + 2) === ': ') {
    const next = parts[1] ?? ''
    head = next.charAt(0).toUpperCase() + next.slice(1)
  }
  return head.replace(/[.,]$/, '').trim()
}

/** A right's words from the admin catalogues: the language's, else the default language's, else the unnamed right's. */
export function wordsOfRight(permission: string, admin: Dictionary | undefined, fallback: Dictionary | undefined): string {
  const key = permissionKey(permission)
  const words = admin?.[key] ?? fallback?.[key]
  return words ? headlineOf(words) : (admin?.[UNNAMED_RIGHT_KEY] ?? fallback?.[UNNAMED_RIGHT_KEY] ?? '')
}
