/**
 * P0 item 8 (2026-09-30) — a channel field list the sheet reports missing (`meta.schemaMissing`) is loaded, instead of
 * the sheet quietly showing only its fixed columns (Motovento eBay DE in production: no item specifics at all).
 *
 * The server reads field lists from the business's cache only; `POST /categories/schema/download` fetches the missing
 * ones through the channel gateway. The sheet tries that once per open, then offers "Load eBay fields". A key it cannot
 * load (no category chosen, the Shopify store list) keeps its own sentence and pointer (`rulesStatus.ts`).
 */
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, sendCommand, type CommandConflict, type CommandKey } from '@/lib/command-key'
import { channelLabel } from '../../scopes'
import { downloadableCategory, missingRuleSentence } from './rulesStatus'

/** Has its own banner, which updates by itself (`useChannelSheetAdapter`). */
const SHOPIFY_FIELDS_UNREAD = 'SHOPIFY:*'

export interface MissingFields {
  /** The categories the download can fetch (an Amazon type, an eBay or Etsy category id). */
  loadable: string[]
  /** One sentence per key that loading cannot fix — the choice the operator still has to make. */
  unloadable: string[]
}

export function missingFields(channel: string, market: string, missing: readonly string[]): MissingFields | null {
  const keys = missing.filter(key => key !== SHOPIFY_FIELDS_UNREAD)
  if (!keys.length) return null
  const loadable = [...new Set(keys.map(downloadableCategory).filter((c): c is string => c !== null))].sort()
  const unloadable = keys.filter(key => downloadableCategory(key) === null).map(key => missingRuleSentence(channel, market, key))
  return { loadable, unloadable }
}

/** "eBay fields for DE are not loaded yet." */
export const notLoadedTitle = (channel: string, market: string) => `${channelLabel(channel)} fields for ${market} are not loaded yet.`
export const loadButtonLabel = (channel: string) => `Load ${channelLabel(channel)} fields`

/**
 * The automatic attempt's key: one per open sheet and per set of missing lists. A key already tried is never tried
 * again by itself (a failure waits for the button); a new category that goes missing gets its own attempt.
 */
export function autoLoadKey(channel: string, market: string, loadable: readonly string[]): string | null {
  return loadable.length ? `${channel}|${market}|${[...loadable].sort().join(',')}` : null
}

interface DownloadAnswer { results?: Array<{ productType: string; outcome: string; error?: string }>; remaining?: number; error?: string }
/** `partial`: the server loads at most 25 lists per call and said how many are left — load again. */
export type FieldsLoadOutcome = { state: 'loaded' } | { state: 'partial'; remaining: number; message: string } | { state: 'failed'; message: string }

/** The provider's reason, cut so the banner stays a banner at phone width. */
const DETAIL_MAX = 120

/** What one download answer means for the banner. Anything short of every list loaded is a failure with its reason. */
export function fieldsLoadOutcome(channel: string, answer: { status: number; body: DownloadAnswer | null; conflict: CommandConflict | null } | 'no-answer'): FieldsLoadOutcome {
  const name = channelLabel(channel)
  if (answer === 'no-answer') return { state: 'failed', message: 'No answer from the server. The download may still be running: wait a moment, then try again.' }
  if (answer.conflict) return { state: 'failed', message: commandConflictMessage(answer.conflict, 'field download') }
  if (answer.status < 200 || answer.status >= 300) {
    return { state: 'failed', message: answer.body?.error ? `${name} fields could not be loaded: ${answer.body.error}` : 'No answer from the server. Try again.' }
  }
  const failed = (answer.body?.results ?? []).filter(r => r.outcome === 'failed')
  const remaining = answer.body?.remaining ?? 0
  if (!failed.length && remaining > 0) return { state: 'partial', remaining, message: `${remaining} more ${name} field ${remaining === 1 ? 'list' : 'lists'} to load. Choose ${loadButtonLabel(channel)} again.` }
  if (!failed.length) return { state: 'loaded' }
  const detail = failed.map(r => r.error ? `${r.productType}: ${r.error}` : r.productType).join('; ')
  return { state: 'failed', message: `Could not reach ${name}. Try again. (${detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail})` }
}

/**
 * THE field-list download: the sheet's banner and the Requirements dialog both call this, so the two cannot word or
 * judge one answer differently (code review 2026-09-30). The server fetches through the channel gateway, per business.
 */
export async function downloadFieldLists(commandKey: CommandKey, channel: string, market: string, productTypes: readonly string[]): Promise<FieldsLoadOutcome> {
  try {
    const answer = await sendCommand<DownloadAnswer>(commandKey, `${getBackendUrl()}/api/categories/schema/download`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, market, productTypes }) })
    return fieldsLoadOutcome(channel, { status: answer.response.status, body: answer.body, conflict: answer.conflict })
  } catch {
    return fieldsLoadOutcome(channel, 'no-answer')
  }
}
