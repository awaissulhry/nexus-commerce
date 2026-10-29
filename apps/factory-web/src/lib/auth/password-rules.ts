/**
 * What a new office password must be (PLT-047, PLT-070): the rules the API applies (factory-domain auth/password
 * `passwordProblems`), mirrored here because that module hashes with node:crypto and cannot reach the browser;
 * `password-rules.vitest.test.ts` holds the mirror to it. The sign-in pages (a reset, a required change, an invitation)
 * and the profile's password change check a new password with this before they send it. The list of well-known
 * passwords stays on the API: each screen says so in its own words when the API refuses one.
 *
 * Plain module (no React): the problems are message keys (`field.…`) that the `auth` and `me` catalogues both hold.
 */

export const PASSWORD_RULES = Object.freeze({ min: 12, max: 256, distinct: 4, namePart: 4 })

/** A field's problem: a message key and its parameters. */
export interface RuleProblem {
  key: string
  params?: Readonly<Record<string, string | number>>
}

/** A new password as the API will judge it (all but the list of well-known passwords), and its confirmation. */
export function checkNewPassword(
  values: { password: string; confirmation: string },
  person: { email?: string | null; displayName?: string | null } = {},
): { password?: RuleProblem; confirmation?: RuleProblem } {
  const value = values.password.normalize('NFKC')
  const length = [...value].length
  const lower = value.toLowerCase()
  const parts = [person.email?.split('@')[0], person.email, ...(person.displayName?.split(/\s+/) ?? [])]
    .map((part) => part?.trim().toLowerCase() ?? '')
    .filter((part) => part.length >= PASSWORD_RULES.namePart)
  let password: RuleProblem | undefined
  if (length < PASSWORD_RULES.min) password = { key: 'field.passwordShort', params: { min: PASSWORD_RULES.min } }
  else if (length > PASSWORD_RULES.max) password = { key: 'field.passwordLong', params: { max: PASSWORD_RULES.max } }
  else if (value.trim() === '' || new Set(lower).size < PASSWORD_RULES.distinct) password = { key: 'field.passwordSimple' }
  else if (parts.some((part) => lower.includes(part))) password = { key: 'field.passwordName' }
  if (password) return { password }
  return values.confirmation !== values.password ? { confirmation: { key: 'field.repeatMismatch' } } : {}
}
