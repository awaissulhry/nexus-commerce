import { isApiError, issuePath, type ApiError } from '../../../lib/api/errors'
import type { Translate } from '../../../lib/i18n/messages'
import type { OfferedRole } from './api'
import type { RoleChoice } from './view/PeopleDialogs'

/**
 * The account pages' words for what the API answered (lifted from the customer's Account, B-W2b-196, by B-W2b-193): a
 * failure, a refused invitation or step-up code, and a role as the invite offers it — always `portal-account` words of our
 * own, never the API's English.
 */

/** A role as the invite and the role change offer it: its name, and what it covers in our words (`sees`: the host's words). */
export function roleChoiceOf(role: OfferedRole, roleWords: Translate, t: Translate, sees: Translate = t): RoleChoice {
  const key = `role.sees.${role.key}`
  const known = sees(key) !== key
  return { key: role.key, name: roleWords(`role.${role.key}`), sees: known ? sees(key) : t(role.seesPrices ? 'role.sees.withPrices' : 'role.sees.noPrices'), seesPrices: role.seesPrices, admin: role.admin }
}

/** A failure in our words (never the API's English). */
export function failedWords(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t('failed.network')
  const kind: ApiError['kind'] = error.kind
  if (kind === 'conflict') return t('failed.conflict')
  if (kind === 'forbidden' || kind === 'step_up') return t('failed.forbidden')
  if (kind === 'not_found') return t('failed.gone')
  if (kind === 'invalid') return t('failed.invalid')
  if (kind === 'rate_limited') return t('failed.wait')
  if (kind === 'signed_out') return t('failed.signedOut')
  return t('failed.network')
}

export function inviteFailed(error: unknown, t: Translate): string {
  if (isApiError(error) && error.kind === 'conflict') return error.issues.some((issue) => issuePath(issue) === 'email') ? t('invite.failed.address') : t('invite.failed.seats')
  if (isApiError(error) && error.kind === 'invalid') return t('invite.failed.invalid')
  return failedWords(error, t)
}

export function stepUpWords(error: unknown, t: Translate): string {
  if (!isApiError(error)) return t('failed.network')
  if (error.kind === 'rate_limited') return t('stepUp.wait')
  const path = error.issues.map(issuePath).find((value) => value.startsWith('code')) ?? ''
  if (path === 'code/TRIED_OUT') return t('stepUp.triedOut')
  if (path === 'code/EXPIRED' || path === 'code/USED' || path === 'code/NONE') return t('stepUp.expired')
  return t('stepUp.wrong')
}
