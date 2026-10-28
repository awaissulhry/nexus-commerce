/**
 * The sign / accept block's rules (gap G12, SCR-099 quote accept, SCR-100 PO confirm, SCR-025 notice): a typed full
 * name, an optional email check, and required acknowledgements, checked the same way on every link page. The block
 * only checks what the person typed; the evidence (time, address, document fingerprint) is the app's to record.
 *
 * - **Name, loosely** (`nameMatches`): capital letters, accents, punctuation, spacing and word order do not matter —
 *   "rossi maria", "Maria  Rossi" and "MARIA ROSSI" all match "Maria Rossi"; "D'Amico" matches "D Amico" and "Damico";
 *   an extra word (a middle name) is fine. A missing or different word is not: "Maria" alone does not match.
 * - **Email**: looks like an address (one @, a dot after it, no spaces); when the app gives the address the link was
 *   sent to, it must be that one, ignoring case and surrounding spaces. Prefer checking it on the server and passing
 *   the outcome back (`message`) when the page should not hold the address at all.
 * - **Acknowledgements**: each one ticked (an MTM no-withdrawal notice, the terms).
 */

/** The words of a name, for comparing: no accents, lower case, letters and digits only. */
export function nameWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ')

/** Whether `typed` is `expected`, loosely (see above). Empty never matches. */
export function nameMatches(typed: string, expected: string): boolean {
  const t = nameWords(typed)
  const e = nameWords(expected)
  if (!t.length || !e.length) return false
  if (sameWords(t, e)) return true
  if (t.join('') === e.join('')) return true
  // Every expected word typed, in any order, with more words besides (a middle name).
  const left = [...t]
  return e.every((w) => {
    const i = left.indexOf(w)
    if (i < 0) return false
    left.splice(i, 1)
    return true
  })
}

/** One @, something before it, a dot after it, no spaces. */
export function emailLooksValid(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

/** The same address, ignoring case and surrounding spaces. */
export function emailMatches(typed: string, expected: string): boolean {
  const t = typed.trim().toLowerCase()
  return t !== '' && t === expected.trim().toLowerCase()
}

export interface SignInput {
  name: string
  email?: string
  /** Ids of the acknowledgements ticked. */
  acknowledged: readonly string[]
}

export interface SignRules {
  /** The name the document is for. Without it any non-empty name is accepted. */
  expectedName?: string
  /** Ask for an email. */
  askEmail?: boolean
  /** The address the link went to. Without it any well-formed address is accepted. */
  expectedEmail?: string
  /** Ids of the acknowledgements that must be ticked. */
  acknowledgements?: readonly string[]
}

export interface SignProblems {
  name: 'empty' | 'mismatch' | null
  email: 'empty' | 'invalid' | 'mismatch' | null
  /** Acknowledgements not ticked, in order. */
  acknowledgements: string[]
}

export function signProblems(input: SignInput, rules: SignRules): SignProblems {
  const name = input.name.trim() === '' ? 'empty' : rules.expectedName != null && !nameMatches(input.name, rules.expectedName) ? 'mismatch' : null
  let email: SignProblems['email'] = null
  if (rules.askEmail) {
    const typed = input.email ?? ''
    if (typed.trim() === '') email = 'empty'
    else if (!emailLooksValid(typed)) email = 'invalid'
    else if (rules.expectedEmail != null && !emailMatches(typed, rules.expectedEmail)) email = 'mismatch'
  }
  const acknowledgements = (rules.acknowledgements ?? []).filter((id) => !input.acknowledged.includes(id))
  return { name, email, acknowledgements }
}

export const signCanAccept = (p: SignProblems): boolean => p.name == null && p.email == null && p.acknowledgements.length === 0
