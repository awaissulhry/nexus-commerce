import { AsyncLocalStorage } from 'node:async_hooks'
const identity = new AsyncLocalStorage<string>()
export const authenticatedUserId = () => identity.getStore()
export const withAuthenticatedUser = <T>(id: string, work: () => T): T => identity.run(id, work)
export function personalSettingsRoute(path: string) {
  return ['/api/auth/password/change', '/api/settings/profile', '/api/settings/2fa', '/api/settings/sessions', '/api/settings/login-history', '/api/auth/2fa'].some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}
