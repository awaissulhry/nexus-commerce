/**
 * DS floor kit — the PIN pad's rules (gap G4): sign-in, sign-off and step-up on a shared tablet.
 *
 * 🔴 A digit is never shown, spoken or kept longer than needed. The pad shows dots only; a screen reader hears "3 of 6",
 * never a number; the digits live in a ref, are handed to `onSubmit` once all are typed, and are cleared in the same
 * step. Nothing here or in `PinPad.tsx` renders a digit the person typed.
 *
 * One fixed layout, 3 × 4, the same on every screen (A2 §3.1: "no hidden layout changes"): 1–9, then Clear, 0, Back.
 */

export type PinDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
export type PinKey = PinDigit | 'back' | 'clear'

export const PIN_LENGTH = 6

/** The pad, row by row. */
export const PIN_PAD_ROWS: readonly (readonly PinKey[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['clear', '0', 'back'],
]

export const isPinDigit = (key: string): key is PinDigit => key.length === 1 && key >= '0' && key <= '9'

/** A press on the pad: the digits after it, and the PIN to submit when this press completed it. */
export function pinPress(digits: string, key: PinKey, length = PIN_LENGTH): { digits: string; submit: string | null } {
  if (key === 'clear') return { digits: '', submit: null }
  if (key === 'back') return { digits: digits.slice(0, -1), submit: null }
  if (digits.length >= length) return { digits, submit: null }
  const next = digits + key
  // Complete: hand the PIN over and keep nothing.
  return next.length === length ? { digits: '', submit: next } : { digits: next, submit: null }
}

/** A physical key, as the pad reads it: digits (top row and number pad), Backspace, and Escape or Delete to clear. */
export function pinKeyFromKeyboard(key: string): PinKey | null {
  if (isPinDigit(key)) return key
  if (key === 'Backspace') return 'back'
  if (key === 'Escape' || key === 'Delete') return 'clear'
  return null
}

/** The dots: `true` for each digit typed. The only view of the PIN there is. */
export function pinDots(entered: number, length = PIN_LENGTH): boolean[] {
  return Array.from({ length }, (_, i) => i < entered)
}
