import { FloorCut } from '../../../../floor/tasks/cutting/Cut'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/cut` — the cutting table: check a hide and log the sets cut from it (SCR-094). */
export default function FloorCutPage() {
  return <FloorCut />
}
