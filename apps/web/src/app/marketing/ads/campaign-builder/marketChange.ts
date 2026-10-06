/**
 * CC-6 — one market per launch.
 *
 * A builder's market can change after the operator has already picked products, product targets or a portfolio for
 * the old one (the header selector stays on every step). Those picks belong to the old market: a product is listed per
 * market, and a portfolio belongs to one market's profile. The product picker cleared its tray only while it was on
 * screen, so a change made on step 2 or 3 launched the old market's products into the new one.
 *
 * Every builder now drops its market-bound picks on a REAL change, wherever the operator is, and says what it dropped.
 * The first '' → 'IT' resolution of the console context is not a change.
 */
import { useEffect, useRef } from 'react'

/** A real change: from one known market to a different one. */
export function isRealMarketChange(prev: string, next: string): boolean {
  return !!prev && !!next && prev !== next
}

/** The sentence a builder shows after dropping its picks. `parts` are the non-empty things it dropped. */
export function marketChangeNote(prev: string, next: string, parts: string[]): string {
  if (!parts.length) return ''
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `The marketplace changed from ${prev} to ${next}, so ${list} chosen for ${prev} ${parts.length === 1 && !/s$/.test(parts[0]) ? 'was' : 'were'} removed. Choose them again for ${next}.`
}

/** Calls `onChange(prev, next)` once per real market change. */
export function useOnMarketChange(market: string, onChange: (prev: string, next: string) => void): void {
  const prevRef = useRef(market)
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = market
    if (isRealMarketChange(prev, market)) cb.current(prev, market)
  }, [market])
}
