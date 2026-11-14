import { isApiError } from '../../../../lib/api/errors'

/**
 * "Copy capture address" on Home › Mail (B-W2b-397 on B-W2b-394's GET /email/capture; COL-021; design home.mail page head "Copy
 * capture address (W2b)"): the company's capture address — forward or BCC any mail to it and it joins the record its subject
 * names, else waits here — copied in one press. Held with its reason while it is read, when the company has no mail domain
 * yet, or no address yet (Admin › Connections makes one, `#capture`).
 */

export type CaptureState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly address: string | null; readonly receivingDomain: string | null; readonly mayManage: boolean }
  | { readonly status: 'error'; readonly problem: string }

/** Why Copy waits (a key of `mail-depth`), or null when there is an address to copy. */
export function copyHeld(state: CaptureState): string | null {
  if (state.status === 'loading') return 'capture.held.reading'
  if (state.status === 'error') return state.problem
  if (state.address) return null
  return state.receivingDomain === null ? 'capture.held.noDomain' : 'capture.held.none'
}

/** Where the address is set up: Admin › Connections, at the capture card. */
export const captureSetupHref = (prefix: string): string => `${prefix}/admin/connections#capture`

/** A read that failed, in words (a key of `mail-depth`). */
export function captureProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'forbidden') return 'capture.problem.forbidden'
  if (isApiError(error) && error.kind === 'unavailable') return 'capture.problem.unavailable'
  return 'capture.problem.read'
}
