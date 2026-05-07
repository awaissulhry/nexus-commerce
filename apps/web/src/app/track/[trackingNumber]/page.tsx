import TrackingPageClient from './TrackingPageClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * O.21 — Public branded tracking page.
 *
 * Customer lands here from the tracking link in their order
 * confirmation / shipped email. No auth — public URL keyed on the
 * tracking number itself (which is sufficiently long + non-guessable
 * for casual privacy, though not a secret).
 *
 * Mobile-first: customers check on phones way more often than
 * desktops. Italian default (Xavia is an Italian brand); English
 * fallback handled by the browser if i18n catalog ever lands.
 *
 * Marketplace orders (Amazon, eBay) won't reach this page — those
 * channels show their own tracking. Direct-channel orders (Shopify,
 * Woo) are the audience.
 */
export default async function TrackingPage({
  params,
}: {
  params: Promise<{ trackingNumber: string }>
}) {
  const { trackingNumber } = await params
  return <TrackingPageClient trackingNumber={trackingNumber} />
}
