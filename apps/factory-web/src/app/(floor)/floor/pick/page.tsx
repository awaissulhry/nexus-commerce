import { FloorPick } from '../../../../floor/tasks/issue/Pick'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/pick` — pick & issue to a work order: scan its traveller, then scan what you issue (SCR-093). */
export default function FloorPickPage() {
  return <FloorPick />
}
