/**
 * ADS AUTONOMY W1-5 — where a strategy number comes from, in the words refusals, reasons and run lines use. Types only
 * at runtime, so the target resolver (whose constants the registry imports) can use it without a cycle.
 */
import type { StrategySource } from './resolve.js'

/**
 * "ads strategy: Helmets (IT), category, v3" (", from SKU-1" when one product of several gave it). W4-4 — `version: false`
 * leaves the version out, for words a waiting request is compared on (a save of the strategy that keeps the number must
 * not make it stale); the write's evidence keeps the version.
 */
export function strategyWords(s: StrategySource, opts: { version?: boolean } = {}): string {
  return `ads strategy: ${s.label}, ${s.level}${s.via === 'parent' ? ' (its parent)' : ''}${opts.version === false ? '' : `, v${s.version}`}${s.product ? `, from ${s.product}` : ''}`
}
