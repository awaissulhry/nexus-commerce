import { FloorMyDay } from '../../../../floor/tasks/myday/MyDay'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/myday` — My day: the worker's own minutes, pace, records and statement, behind the PIN (SCR-171, B-W2b-68). */
export default function FloorMyDayPage() {
  return <FloorMyDay />
}
