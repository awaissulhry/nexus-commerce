import { FloorMachine } from '../../../../floor/tasks/machine/Machine'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/machine` — a machine problem from the station, and the technician's job (SCR-179, B-W2a-73). */
export default function FloorMachinePage() {
  return <FloorMachine />
}
