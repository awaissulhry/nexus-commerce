import { FloorFabricCut } from '../../../../floor/tasks/fabriccut/FabricCut'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/fabriccut` — fabric cutting: the ticket, the lay, the count at both ends, the cut, stickers, fabric used, recuts, to sewing (SCR-182). */
export default function FloorFabricCutPage() {
  return <FloorFabricCut />
}
