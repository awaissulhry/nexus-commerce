import { searchAddress } from '../../../links/tracking/model'
import { TrackSearch } from '../../../links/tracking/TrackSearch'

type Search = Promise<Record<string, string | string[] | undefined>>
const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null)

/**
 * `/t?tenant=<slug>&company=<code>` — Find your order (B-W2b-170; design links.tracking sec:search; LOG-062): the public
 * search by the customer's order reference and the delivery postcode, for a customer without the link (links/tracking).
 * The address names whose company it is; without it the page says to use the link of our e-mail.
 */
export default async function TrackSearchPage({ searchParams }: { searchParams: Search }) {
  const search = await searchParams
  return <TrackSearch address={searchAddress(one(search.tenant), one(search.company))} />
}
