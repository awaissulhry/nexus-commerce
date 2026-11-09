import { PublicDoc } from '../../../links/public-doc/PublicDoc'

/**
 * `/doc` — Type the code (B-W2b-166, SCR-102; design links.doc sec:lookup): the public DoC page without a code, for a
 * reader whose QR is damaged. The code typed opens `/doc/<code>`.
 */
export default function PublicDocLookupPage() {
  return <PublicDoc code={null} />
}
