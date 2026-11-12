import { FloorCount } from '../../../../floor/tasks/count/Count'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/count` — Count: what to count, scan every unit, the differences after Bin done (SCR-178, B-W2b-310). */
export default function FloorCountPage() {
  return <FloorCount />
}
