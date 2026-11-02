import { FloorReturnsIn } from '../../../../floor/tasks/returns-in/ReturnsIn'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/returnsin` — receive a customer return at the dock: scan the RMA, the parcel, the lines, grade, the place (SCR-180). */
export default function FloorReturnsInPage() {
  return <FloorReturnsIn />
}
