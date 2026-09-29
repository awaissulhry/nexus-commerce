/**
 * One Idempotency-Key per operator intent, for the commands the API keeps durable receipts for
 * (`apps/api/src/lib/command-idempotency.ts`): bulk replicate, PIM attach-to-parent and
 * promote-to-parent, the listing-wizard submit, and the product sheet's bulk save (one fill, paste or undo).
 *
 * What the server does with a key, and what the web does with the key afterwards:
 *   - 2xx: the command ran, or its stored result was replayed. Done: drop the key, so the next
 *     deliberate press is a new command.
 *   - 409 "still running": the same key and request are running now. Keep the key: pressing again
 *     once it finishes replays the result instead of running the command twice.
 *   - 422 "used for a different request": an earlier attempt with this key reached the server and
 *     has finished or is still running; this attempt did not run. Drop the key, so the next press is
 *     a new command with the operator's current values.
 *   - Any other non-2xx: the server released the key. Drop it.
 *   - No response (network error, abort) or a gateway 502/503/504: the command may have run, or may
 *     still be running, without the page seeing it. Keep the key, so a retry cannot run it twice.
 *
 * Keys are random, never built from the request's content. A content key (`pim-attach:<parent>:<ids>`)
 * is identical for two deliberate commands, so a corrected retry inside the receipt window was
 * refused with 422.
 */
import { useRef } from 'react'

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'

/**
 * The API's own words. Routes answer 409 for their own reasons too ("Wizard is already submitted.",
 * "X is itself a child"), so the status alone cannot say which 409 this is. The contract test reads
 * these strings back out of the API source.
 */
export const RUNNING_ERROR_PREFIX = 'The same request is still running.'
export const REUSED_ERROR = 'This Idempotency-Key was already used for a different request.'

export type CommandConflict = 'running' | 'reused'

/** Statuses that may come from a proxy while the API is still running the command. */
const OUTCOME_UNKNOWN = new Set([502, 503, 504])

function errorText(body: unknown): string | null {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return typeof error === 'string' ? error : null
}

/** Whether this response is the idempotency layer refusing the attempt, and why. */
export function commandConflict(status: number, body: unknown): CommandConflict | null {
  const error = errorText(body)
  if (status === 409 && error?.startsWith(RUNNING_ERROR_PREFIX)) return 'running'
  if (status === 422 && error === REUSED_ERROR) return 'reused'
  return null
}

/** Whether the key must survive this response, because a retry could otherwise run the command twice. */
export function keepsKey(status: number, body: unknown): boolean {
  return commandConflict(status, body) === 'running' || OUTCOME_UNKNOWN.has(status)
}

/** What to tell the operator. `what` names the request: "attach request", "publish request". */
export function commandConflictMessage(conflict: CommandConflict, what: string): string {
  return conflict === 'running'
    ? `Your earlier ${what} is still running on the server. Wait a few seconds, then try again: repeating the same request will not run it twice.`
    : `This ${what} was not applied: an earlier attempt with different values already reached the server and has finished or is still running. Check the current state first; trying again sends your current values as a new request.`
}

const newKey = () => crypto.randomUUID()

/** The key of one intent: created when the action starts, kept while its outcome is unknown. */
export class CommandKey {
  private key: string | null = null

  constructor(private readonly mint: () => string = newKey) {}

  /** The key to send: the one of an attempt whose outcome is unknown, or a new one. */
  take(): string {
    if (this.key === null) this.key = this.mint()
    return this.key
  }

  /**
   * Record the response to an attempt that sent `key`. Never called when no response arrived, so
   * that attempt's key stays for the retry. An older attempt cannot drop a newer key.
   */
  settle(key: string, status: number, body: unknown): void {
    if (this.key === key && !keepsKey(status, body)) this.key = null
  }

  /** The key a retry would reuse, or null when the next press starts a new command. */
  get pending(): string | null {
    return this.key
  }
}

/** A component's key slot, kept across renders for as long as the component is mounted. */
export function useCommandKey(): CommandKey {
  const ref = useRef<CommandKey | null>(null)
  if (ref.current === null) ref.current = new CommandKey()
  return ref.current
}

const slots = new Map<string, CommandKey>()

/**
 * A key slot for code with no component to hold one, named by verb and subject
 * (`attach:<parentId>`), so a retry of the same verb on the same product reuses its key and
 * another product never inherits it. Lives for the page session.
 */
export function commandKeyFor(name: string): CommandKey {
  let slot = slots.get(name)
  if (!slot) {
    slot = new CommandKey()
    slots.set(name, slot)
  }
  return slot
}

export interface CommandResponse<T> {
  response: Response
  /** The parsed JSON body, or null when there was none. */
  body: T | null
  /** Set when the idempotency layer refused this attempt; the command did not run for it. */
  conflict: CommandConflict | null
}

/**
 * Send a command with its intent's key and settle the key from the answer. Throws only when no
 * response arrived — the key is then kept, so the operator's retry cannot run the command twice.
 */
export async function sendCommand<T = unknown>(slot: CommandKey, url: string, init: RequestInit): Promise<CommandResponse<T>> {
  const key = slot.take()
  const headers = new Headers(init.headers)
  headers.set(IDEMPOTENCY_KEY_HEADER, key)
  const response = await fetch(url, { ...init, headers })
  const body = (await response.json().catch(() => null)) as T | null
  slot.settle(key, response.status, body)
  return { response, body, conflict: commandConflict(response.status, body) }
}
