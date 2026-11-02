import { FloorScan } from '../../../../floor/scan/Scan'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/scan` — scan anything: any label of the factory opens its card (SCR-024). */
export default function FloorScanPage() {
  return <FloorScan />
}
