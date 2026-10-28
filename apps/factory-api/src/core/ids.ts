import type { IncomingMessage } from 'node:http'
import { newId } from '@nexus/factory-domain/core/ids'

/**
 * Request ids. Every request gets one, logged on every line of that request and answered in `x-request-id`; the
 * audit rows of the command() step carry it too. A caller (the factory web) may send its own `x-request-id` to tie
 * its logs to ours; it is kept only when it is a short plain token, so a header can never inject text into a log
 * line. Otherwise the API makes a UUIDv7.
 */

export const REQUEST_ID_HEADER = 'x-request-id'

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/

export function requestIdFor(request: IncomingMessage): string {
  const sent = request.headers[REQUEST_ID_HEADER]
  return typeof sent === 'string' && SAFE_REQUEST_ID.test(sent) ? sent : newId()
}

export { newId }
