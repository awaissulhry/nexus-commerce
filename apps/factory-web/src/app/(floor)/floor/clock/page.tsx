import { FloorClock } from '../../../../floor/tasks/clock/Clock'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/clock` — clock in, out and breaks, offline too; forgot badge (SCR-170). Open with nobody signed in: a kiosk. */
export default function FloorClockPage() {
  return <FloorClock />
}
