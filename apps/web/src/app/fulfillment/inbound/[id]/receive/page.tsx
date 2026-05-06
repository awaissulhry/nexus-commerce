import MobileReceiveClient from './MobileReceiveClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// H.7 — mobile-first receive flow.
//
// Reachable from the desktop drawer ("Open mobile receive →" link)
// and direct URL share for warehouse staff on phones. Single-page
// flow: SKU search/scan input → matching item card with receive
// controls (±qty buttons, manual input, QC, photo capture, save).
//
// The desktop drawer is the right tool when you're sitting at a desk;
// this page is the right tool when you're holding a phone over a
// pallet at the receiving dock.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <MobileReceiveClient id={id} />
}
