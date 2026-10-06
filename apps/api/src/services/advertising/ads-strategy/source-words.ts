/**
 * ADS AUTONOMY W1-5 — where a strategy number comes from, in the words refusals, reasons and run lines use. Types only
 * at runtime, so the target resolver (whose constants the registry imports) can use it without a cycle.
 */
import type { StrategySource } from './resolve.js'

/** "ads strategy: Helmets (IT), category, v3" (", from SKU-1" when one product of several gave it). */
export function strategyWords(s: StrategySource): string {
  return `ads strategy: ${s.label}, ${s.level}${s.via === 'parent' ? ' (its parent)' : ''}, v${s.version}${s.product ? `, from ${s.product}` : ''}`
}
