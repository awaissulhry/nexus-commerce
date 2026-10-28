import { ValidationError } from '@nexus/factory-domain/core/errors'

/**
 * Email addresses as sign-in names: trimmed and lower case, so `Ada@Example.com ` and `ada@example.com` are one
 * account (the column is plain text with a unique key per tenant, not citext). The shape check is deliberately loose:
 * the invitation link proves the address.
 */

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

export const normalizeEmail = (value: string): string => value.trim().toLowerCase()

/** The normalized address, or a 400 at `path`. */
export function emailOrThrow(value: string, path = 'email'): string {
  const email = normalizeEmail(value)
  if (email.length > 254 || !EMAIL.test(email)) throw new ValidationError('The email address is not valid.', [{ path, message: 'Expected an email address.' }])
  return email
}
