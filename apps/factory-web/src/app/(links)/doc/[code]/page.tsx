import { PublicDoc } from '../../../../links/public-doc/PublicDoc'

/**
 * `/doc/<code>` — the public DoC (B-W2b-166, SCR-102; PRD-294, PRD-356): the permanent address the QR on a garment label
 * and in the instructions holds, for anyone, with no sign-in (links/public-doc). Not a token: the code names a released
 * batch or a style, and the page reads it from the API under its rate limits.
 */
export default async function PublicDocPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return <PublicDoc code={decodeURIComponent(code)} />
}
