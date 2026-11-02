import { FloorBundles } from '../../../../floor/tasks/bundles/Bundles'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/bundles` — bundles from what was cut and their tickets; a scanned ticket reprinted or voided (SCR-095). */
export default function FloorBundlesPage() {
  return <FloorBundles />
}
