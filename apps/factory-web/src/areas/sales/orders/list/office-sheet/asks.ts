import type { BrandRequest } from '../../../../home/approvals/requests/api'
import type { SheetAsk } from '../../../../../lib/orders-sheet/model'
import type { SheetRowRead } from './api'

/**
 * owb-of3 step 4 — "The customer asks n changes" (design § 5c, sheetModal `asks|`), pure: each open ask of the order (from → to, the
 * line it is on) with who asked and when (today's walled read of the order's requests, `listOrderRequests`), and what an answer
 * calls: Yes → today's `POST /sales/change-requests/:id/accept` with the ask's id and version; No → today's refuse with the words the
 * customer reads (needed). Nothing changes before the answer; both answers are in the order's history.
 */

export interface AskEntry {
  readonly ask: SheetAsk
  readonly seq: number
  /** Today's request behind the ask (who, when, its version); null: not read (yet), or out of reach. */
  readonly request: BrandRequest | null
}

export function askEntriesOf(row: Pick<SheetRowRead, 'lines'>, requests: readonly BrandRequest[]): AskEntry[] {
  const byId = new Map(requests.map((request) => [request.id, request]))
  return row.lines.flatMap((line) => line.asks.map((ask) => ({ ask, seq: line.seq, request: byId.get(ask.requestId) ?? null })))
}

export type AskAnswer =
  | { readonly call: 'accept'; readonly requestId: string; readonly body: { readonly version: number; readonly answer: null } }
  | { readonly call: 'refuse'; readonly request: Pick<BrandRequest, 'id' | 'answeredIn'>; readonly body: { readonly version: number; readonly answer: string } }
  | { readonly call: 'none'; readonly why: 'notRead' | 'noWords' }

/** The call an answer makes (Yes: accept by the ask's id; No: refuse with words); none while the request is not read or No has no words. */
export function askAnswerOf(entry: AskEntry, yes: boolean, words: string): AskAnswer {
  if (!entry.request) return { call: 'none', why: 'notRead' }
  if (yes) return { call: 'accept', requestId: entry.request.id, body: { version: entry.request.version, answer: null } }
  const answer = words.trim()
  if (answer === '') return { call: 'none', why: 'noWords' }
  return { call: 'refuse', request: { id: entry.request.id, answeredIn: entry.request.answeredIn }, body: { version: entry.request.version, answer } }
}
