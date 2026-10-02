/**
 * R4 (MCP full control, part 06) — what a service moved out of a route returns, so the route can answer exactly as it
 * did and a Claude tool can reuse the same logic without an HTTP reply.
 *
 *   { ok: true, value }          the route returns `value` as its body (status 200)
 *   { ok: false, status, body }  the route answers `status` with `body`, word for word as before
 */
export type ServiceRefusal = { ok: false; status: number; body: Record<string, unknown> }
export type ServiceOutcome<T> = { ok: true; value: T } | ServiceRefusal

/** Narrows an outcome to its refusal (the API's tsconfig does not narrow on `!outcome.ok`). */
export function isRefused<T>(outcome: ServiceOutcome<T>): outcome is ServiceRefusal {
  return outcome.ok === false
}

export const done = <T>(value: T): ServiceOutcome<T> => ({ ok: true, value })
export const refused = (status: number, body: Record<string, unknown>): ServiceOutcome<never> => ({ ok: false, status, body })

/** The route side: set the status of a refusal and hand back the body, exactly as the route used to. */
export function answer<T>(reply: { code: (status: number) => unknown }, outcome: ServiceOutcome<T>): T | Record<string, unknown> {
  if (isRefused(outcome)) {
    reply.code(outcome.status)
    return outcome.body
  }
  return outcome.value
}
