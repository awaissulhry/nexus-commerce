/**
 * ProtectedValue's rules (B-W2b-28, design part ProtectedValue): a field for special-category data — a fitness
 * judgement, injury details (GDPR art. 9; D.Lgs. 81/2008 art. 41).
 *
 * - **Not entitled**: "Restricted" and who may see it. The value is never in the page for them.
 * - **Entitled**: the value is NOT read with the page. "Show" asks the app to read it, and that read writes the view log
 *   on the server (one log row per open). Until then the field says that opening it is recorded.
 * - **Open**: the value with a "View recorded · 10:42" mark, and Hide (the page forgets it; a new Show is a new log row).
 * - **Opening / failed**: held while it reads; a failure says so in words with Try again — never drawn as empty.
 */

export type ProtectedView = 'restricted' | 'closed' | 'opening' | 'failed' | 'open'

export interface ProtectedInput {
  /** The person holds a role that may see this field. */
  allowed: boolean
  /** The value, once the app read it. `undefined`: not opened. */
  value?: unknown
  opening?: boolean
  /** The read failed. */
  failed?: boolean
}

export function protectedValueView({ allowed, value, opening, failed }: ProtectedInput): ProtectedView {
  if (!allowed) return 'restricted'
  if (opening) return 'opening'
  if (failed) return 'failed'
  return value === undefined ? 'closed' : 'open'
}
