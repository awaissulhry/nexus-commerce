import { FloorChainPage } from '../../../../floor/chains/Chain'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/chains` — a chain: ONE step, its lots as big rows, +12 and −12 (owb-fl9). */
export default function FloorChainRoute() {
  return <FloorChainPage />
}
