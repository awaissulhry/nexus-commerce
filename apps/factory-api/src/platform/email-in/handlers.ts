import type { EventHandler } from '../outbox/dispatch'
import { emailFetchHandler } from './fetch'
import type { EmailInRuntime } from './service'
import { emailSortHandler } from './sort'

/** Email in's handlers for the worker (background.ts HANDLERS): read a received mail, then sort it. */
export function emailInHandlers(runtime?: () => EmailInRuntime): EventHandler[] {
  return [runtime ? emailFetchHandler(runtime) : emailFetchHandler(), emailSortHandler()]
}
