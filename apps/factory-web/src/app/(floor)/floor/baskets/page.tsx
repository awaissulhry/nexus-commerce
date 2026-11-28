import { BasketHome } from '../../../../floor/basket/home/BasketHome'

/** B-W2b-F6: visited once, a tablet opens this page with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/baskets` — owb-fl5: a tablet's Baskets tile: the department's baskets, For you, Coming next (lead settle 9). */
export default function FloorBasketsPage() {
  return <BasketHome />
}
