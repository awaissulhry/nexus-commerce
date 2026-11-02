import { FloorPack } from '../../../../floor/tasks/pack/Pack'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/pack` — the packing bench (SCR-098): scan released garments into cartons, print the labels and the DDT. */
export default function FloorPackPage() {
  return <FloorPack />
}
