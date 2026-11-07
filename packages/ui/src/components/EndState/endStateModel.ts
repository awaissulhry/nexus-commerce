/**
 * EndState's rules (B-W2b-155), pure: what an action looks like (busy and done hold it with their words), whether a
 * contact can be reached (a `mailto:` / `tel:` only for an address that looks like one), and the next steps as a list.
 */
import type { ReactNode } from 'react'

export type EndStateTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

export const END_STATE_TONES = ['success', 'info', 'warning', 'danger', 'neutral'] as const satisfies readonly EndStateTone[]

export interface EndStateAction {
  label: string
  onClick?: () => void
  /** A link instead of a button (the portal, the PDF of a record). */
  href?: string
  /** Default `secondary`; the first action of an end is usually `primary`. */
  variant?: 'primary' | 'secondary'
  /** Held with its reason (focusable, says why). */
  heldReason?: string | null
  /** The command runs: held with the busy words. */
  busy?: boolean
  /** Pressed once and done: the words replace the label and hold it ("Asked — we passed it on"). */
  done?: string | null
}

export interface EndStateContact {
  /** Whom to ask: the record's owner ("Anna Rossi"), or the company. */
  name: string
  /** Their role or the company ("Sales, Pelletteria Demo"). */
  detail?: string | null
  email?: string | null
  phone?: string | null
}

/** How an action draws: its words and why it is held (null = it acts). */
export function endStateActionView(action: EndStateAction, busyWords: string): { words: string; held: string | null } {
  if (action.done) return { words: action.done, held: action.done }
  if (action.busy) return { words: busyWords, held: busyWords }
  return { words: action.label, held: action.heldReason ?? null }
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/
const PHONE = /^\+?[\d\s().-]{5,}$/

/** A `mailto:` address for a plausible e-mail address, else null (the address is still shown as text). */
export function mailtoOf(email: string | null | undefined): string | null {
  const e = email?.trim()
  return e && EMAIL.test(e) ? `mailto:${e}` : null
}

/** A `tel:` number for a plausible phone number (spaces and brackets dropped), else null. */
export function telOf(phone: string | null | undefined): string | null {
  const p = phone?.trim()
  if (!p || !PHONE.test(p)) return null
  const digits = p.replace(/[^\d+]/g, '')
  return digits.replace(/\+/g, '').length >= 5 ? `tel:${digits}` : null
}

/** The next steps as list items: an array as given (empty ones dropped), one node as one item, nothing as none. */
export function endStateSteps(next: ReactNode | readonly ReactNode[] | null | undefined): ReactNode[] {
  if (next === null || next === undefined || next === false || next === '') return []
  if (Array.isArray(next)) return next.filter((step) => step !== null && step !== undefined && step !== false && step !== '')
  return [next as ReactNode]
}
