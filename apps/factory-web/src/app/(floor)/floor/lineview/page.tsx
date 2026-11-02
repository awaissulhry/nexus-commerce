import { FloorLineView } from '../../../../floor/tasks/lineview/LineView'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/lineview` — the team leader's Line view: my line now, calls, what waits, stations (SCR-168, B-W2b-70). */
export default function FloorLineViewPage() {
  return <FloorLineView />
}
