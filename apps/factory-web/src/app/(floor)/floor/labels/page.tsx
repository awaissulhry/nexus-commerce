import { FloorLabels } from '../../../../floor/tasks/labels/Labels'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/labels` — garment labels at the final operation (SCR-096): batch or serial, behind the certificate gate. */
export default function FloorLabelsPage() {
  return <FloorLabels />
}
