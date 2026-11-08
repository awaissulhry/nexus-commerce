/**
 * CodeInput's rules (B-W2b-155), pure: what a typed or pasted text gives as a code, when a full code is submitted, and
 * how the boxes are drawn.
 */

/** The default length of a one-time code. */
export const CODE_LENGTH = 6

const clampLength = (length: number) => (Number.isInteger(length) && length > 0 && length <= 12 ? length : CODE_LENGTH)

/**
 * A typed or pasted text → the code's digits, at most `length`. A pasted sentence ("Your code is 123 456, valid for
 * 10 minutes") gives the first run of exactly `length` digits, spaces or dashes inside it allowed ("123 456", "123-456");
 * without such a run, its digits in order, cut to `length`.
 */
export function codeFromText(text: string, length: number = CODE_LENGTH): string {
  const n = clampLength(length)
  const runs = text.match(/\d(?:[\s -]?\d)*/g) ?? []
  for (const run of runs) {
    const digits = run.replace(/\D/g, '')
    if (digits.length === n) return digits
  }
  return text.replace(/\D/g, '').slice(0, n)
}

/** True when `next` completes the code and is a new full code (not the one already there): time to submit it. */
export function codeCompletes(previous: string, next: string, length: number = CODE_LENGTH): boolean {
  const n = clampLength(length)
  return next.length === n && /^\d+$/.test(next) && next !== previous
}

export interface CodeCell {
  /** The digit in the box, or '' when empty. */
  digit: string
  /** The box the next digit goes into (the last box when the code is full). */
  active: boolean
}

/** The boxes: one per digit, the next one to fill marked. */
export function codeCells(value: string, length: number = CODE_LENGTH): CodeCell[] {
  const n = clampLength(length)
  const digits = Array.from(value.replace(/\D/g, '').slice(0, n))
  const next = Math.min(digits.length, n - 1)
  return Array.from({ length: n }, (_, i) => ({ digit: digits[i] ?? '', active: i === next }))
}

/** Where a gap is drawn between the boxes to read the code in halves (after 3 of 6, 4 of 8); none for odd lengths. */
export function codeGapAfter(length: number = CODE_LENGTH): number | null {
  const n = clampLength(length)
  return n >= 6 && n % 2 === 0 ? n / 2 : null
}

/** Whether a new code may be asked for now: no time given, or the time has passed. */
export function resendReady(availableAt: string | number | null | undefined, now: number): boolean {
  if (availableAt === null || availableAt === undefined) return true
  const at = typeof availableAt === 'number' ? availableAt : Date.parse(availableAt)
  return !Number.isFinite(at) || at <= now
}
