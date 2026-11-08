import { FloorInline } from '../../../../floor/tasks/inline/Inline'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/inline` — in-line inspection: first piece, cutting, roving, end of line (SCR-176). */
export default function FloorInlinePage() {
  return <FloorInline />
}
