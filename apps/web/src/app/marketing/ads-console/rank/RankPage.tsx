'use client'

import { UnifiedRankCockpit } from './UnifiedRankCockpit'

// RC4 — /rank now renders the unified cockpit. The legacy mode tabs
// (keywords/strategy/conquest/tos) stay reachable via the Automation hub until
// they're absorbed into the cockpit stations (RC4.1–RC4.4) and retired (RC4.9).
export function RankPage() {
  return <UnifiedRankCockpit />
}
