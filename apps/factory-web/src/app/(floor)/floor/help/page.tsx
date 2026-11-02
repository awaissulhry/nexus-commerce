import { FloorHelp } from '../../../../floor/tasks/help/Help'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/help` — Call for help: one tap calls the right person, and the screen says who is coming (SCR-172, B-W2b-70). */
export default function FloorHelpPage() {
  return <FloorHelp />
}
