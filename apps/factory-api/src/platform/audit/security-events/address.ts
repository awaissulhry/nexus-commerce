import { ValidationError } from '@nexus/factory-domain/core/errors'
import { LOCAL_COOKIE_SECRET, readFactoryVariables } from '../../../env'
import { authSecrets, type AuthSecrets } from '../../auth/sessions/secrets'

/**
 * A search by address (B-W2b-399; PLT-077 "search by IP"): the address an administrator types is turned into the same keyed
 * hash the sessions and the security events keep (platform/auth/sessions/secrets.ts `ipHash`, from FACTORY_COOKIE_SECRET as
 * src/index.ts builds it, the local placeholder in local and test runs), so it is found without any address being stored.
 * The same in the API and the worker (an export of a search by address).
 */

let secrets: AuthSecrets | undefined

const IPV4_PART = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
const IPV4 = new RegExp(`^${IPV4_PART}(\\.${IPV4_PART}){3}$`)
/** IPv6 in its usual forms (groups of up to 4 hex digits, at most one `::`), an IPv4 tail allowed (`::ffff:192.0.2.1`). */
function isIpv6(value: string): boolean {
  const [head, tail = ''] = value.split(/:(?=\d+\.\d+\.\d+\.\d+$)/)
  const groups = value.includes('.') ? head! : value
  if (groups.includes(':::') || (groups.match(/::/g) ?? []).length > 1 || !/^[0-9a-fA-F:]+$/.test(groups) || !groups.includes(':')) return false
  if (value.includes('.') && !IPV4.test(tail)) return false
  const parts = groups.split(':')
  const counted = parts.filter((part) => part !== '').length + (value.includes('.') ? 2 : 0)
  return parts.every((part) => part.length <= 4) && (groups.includes('::') ? counted < 8 : counted === 8)
}
export const isIpAddress = (value: string): boolean => IPV4.test(value) || isIpv6(value)

export function addressHashOf(address: string, path: string): string {
  if (!isIpAddress(address.trim())) throw new ValidationError('Not an IP address.', [{ path, message: 'Type an IPv4 or IPv6 address.' }])
  secrets ??= authSecrets(readFactoryVariables().FACTORY_COOKIE_SECRET ?? LOCAL_COOKIE_SECRET)
  const hash = secrets.ipHash(address.trim())
  if (hash === null) throw new ValidationError('Not an IP address.', [{ path, message: 'Type an IPv4 or IPv6 address.' }])
  return hash
}
