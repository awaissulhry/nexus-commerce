/**
 * PES.1 — the market this operator last worked in.
 *
 * Why it exists, measured 2026-09-01: the marketplace table has FIVE markets served by two channels
 * each (DE, ES, FR, IT, UK), so "the market with the most channels" is a five-way tie and the
 * tiebreak is alphabetical — the studio landed on DE for a catalogue whose home market is IT.
 * `/api/products/:id` carries no market signal at all (`channelListings` comes back empty; only
 * `syncChannels` / `linkedToChannels` are present, and those name channels, not markets), and the
 * per-product listing call that would is the 9-second cold one the frame deliberately does not make.
 *
 * So the frame stops guessing and remembers instead. A recalled market is the operator's own last
 * choice, not an inference — the only kind of default that cannot be wrong about them.
 *
 * Per-browser and best-effort: a private window, cleared site data or a storage-blocking setting all
 * throw or return null, and every one of those cases simply falls back to the first-visit rule.
 */

const KEY = 'nexus:studio:market'

export function readLastMarket(): string | null {
  try {
    const v = window.localStorage.getItem(KEY)
    return v && v.trim() ? v : null
  } catch {
    // Storage can throw outright (Safari private mode, blocked site data) — never let that break
    // the page whose only use for it is a default.
    return null
  }
}

export function writeLastMarket(code: string): void {
  try {
    window.localStorage.setItem(KEY, code)
  } catch {
    /* not remembering is not an error worth surfacing */
  }
}
