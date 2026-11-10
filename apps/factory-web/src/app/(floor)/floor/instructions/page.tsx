import { FloorInstructions } from '../../../../floor/tasks/instructions/Instructions'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/instructions` — Spec & instructions: for the bundle in hand, how to do it, the spec for this size, Seen, report a spec problem (SCR-174, B-W2b-232). */
export default function FloorInstructionsPage() {
  return <FloorInstructions />
}
