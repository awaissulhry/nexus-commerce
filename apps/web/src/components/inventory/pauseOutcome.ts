/**
 * The words of the FBA page's "Pause Listings" outcome (POST /api/stock/pause): exactly what ran — the stock levels
 * set to their reserved count, the ones that had nothing to sell, the ones that failed and why, and the listings that
 * keep their own quantity. Never "paused" for a listing the change cannot reach.
 */
export interface PauseResult {
  products: number
  variations: number
  notFound: number
  paused: number
  units: number
  skipped: number
  failed: Array<{ sku: string; location: string; reason: string }>
  /** Null when the server could not count them: the sentence is left out rather than guessed. */
  notFollowing: number | null
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const FAILED_SHOWN = 3

export function pauseOutcomeOf(r: PauseResult): { tone: 'success' | 'error'; message: string } {
  const parts: string[] = []
  const what = r.variations > 0 ? `${n(r.products, 'product')} and ${n(r.variations, 'variation')}` : n(r.products, 'product')
  if (r.paused > 0) {
    parts.push(`Set own-warehouse stock to the reserved count at ${n(r.paused, 'stock level')} (${n(r.units, 'unit')}) of ${what}. Listings that follow stock now show 0.`)
    if (r.skipped > 0) parts.push(`${n(r.skipped, 'stock level')} had nothing left to sell.`)
  } else if (r.failed.length === 0) {
    parts.push(`Nothing to change: no own-warehouse stock is left to sell for ${what}.`)
  } else {
    parts.push('No own-warehouse stock was changed.')
  }
  if (r.failed.length > 0) {
    const shown = r.failed.slice(0, FAILED_SHOWN).map((f) => `${f.sku} at ${f.location} (${f.reason})`).join('; ')
    const more = r.failed.length > FAILED_SHOWN ? `; and ${r.failed.length - FAILED_SHOWN} more` : ''
    parts.push(`${n(r.failed.length, 'stock level')} could not be changed: ${shown}${more}.`)
  }
  if (r.notFollowing) parts.push(`${n(r.notFollowing, 'listing')} keep their own quantity (a fixed number, a held sync or shared stock).`)
  parts.push('Amazon FBA units are not changed.')
  if (r.notFound > 0) parts.push(`${n(r.notFound, 'selected row')} skipped (not a product).`)
  return { tone: r.failed.length > 0 ? 'error' : 'success', message: `${r.failed.length > 0 ? '✗' : '✓'} ${parts.join(' ')}` }
}
