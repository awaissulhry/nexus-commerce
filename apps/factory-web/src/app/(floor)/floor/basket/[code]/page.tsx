import { BasketPage } from '../../../../../floor/basket/page/BasketPage'

/** B-W2b-F6: visited once, a page opens with no network for a day (floor/moves.ts). */
export const unstable_dynamicStaleTime = 86_400

/** `/floor/basket/<code>` — owb-fl5: one basket on a phone (design § 4.3, § 5zg C): a scan or a list row opens it. */
export default async function FloorBasketPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return <BasketPage code={decoded(code)} />
}

/** The code as scanned (a malformed escape stays as it came: the read then says no basket has it). */
function decoded(code: string): string {
  try {
    return decodeURIComponent(code)
  } catch {
    return code
  }
}
