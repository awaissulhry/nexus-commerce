import { FloorTraining } from "../../../../floor/tasks/training/Training";

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts); signing itself needs the network. */
export const unstable_dynamicStaleTime = 86_400;

/** `/floor/training` — Training & PPE sign-off: training attendance with badge and PIN, receive PPE with a receipt (SCR-231, B-W2b-145). */
export default function FloorTrainingPage() {
  return <FloorTraining />;
}
