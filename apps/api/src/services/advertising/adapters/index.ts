/**
 * Adapter registry. The sync orchestrator imports `ADAPTERS` and
 * iterates — adding a new ad product is one new file + one entry here.
 */

import { sdAdapter } from './sd.adapter.js'
import { spAdapter } from './sp.adapter.js'
import { sbAdapter } from './sb.adapter.js'
import type { AdsAdapter } from './types.js'

export const ADAPTERS: ReadonlyArray<AdsAdapter> = [
  spAdapter,  // first so SP errors are surfaced upfront when re-enabled
  sbAdapter,
  sdAdapter,  // last — proven working today
]

export { sdAdapter, spAdapter, sbAdapter }
export type { AdsAdapter, AdProduct } from './types.js'
