/**
 * W5.49 — listing recovery page.
 *
 * Server component: pulls the product + its existing channel listings
 * and the last 20 audit events, then hands them to the client picker.
 *
 * The actual destructive call goes via /api/products/:id/recover; on
 * success the client redirects to the wizard URL the API returned for
 * the recreate step.
 */

import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { getServerT } from '@/lib/i18n/server'
import RecoverClient, {
  type RecoverChannelListing,
  type RecoverProduct,
  type RecoveryEvent,
} from './RecoverClient'
import NewTabClickPerf from '@/components/perf/NewTabClickPerf'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function RecoverPage({ params }: PageProps) {
  const { id: productId } = await params
  const t = await getServerT()
  const backend = getBackendUrl()

  // EH.3 — Parallel fetch of /health (slow: 200–500 ms Prisma joins)
  // and /recover/events (cheap: ~50 ms). Previously sequential, so
  // the cheap events query waited on the slow health query for no
  // reason. .catch(() => null) on each preserves the "network error
  // vs non-2xx" distinction the original try/catch made.
  const [productRes, eventsRes] = await Promise.all([
    fetch(`${backend}/api/products/${productId}/health`, {
      cache: 'no-store',
    }).catch(() => null),
    fetch(`${backend}/api/products/${productId}/recover/events`, {
      cache: 'no-store',
    }).catch(() => null),
  ])

  if (!productRes) {
    return (
      <FailureView
        productId={productId}
        title={t('recover.error.unreachableTitle')}
        detail={t('recover.error.unreachableDetail')}
      />
    )
  }
  if (productRes.status === 404) notFound()
  if (!productRes.ok) {
    return (
      <FailureView
        productId={productId}
        title={t('recover.error.loadFailedTitle')}
        detail={`HTTP ${productRes.status}`}
      />
    )
  }

  const product = (await productRes.json()) as RecoverProduct & {
    channelListings?: RecoverChannelListing[]
  }
  if (!product?.id) notFound()

  const events: RecoveryEvent[] =
    eventsRes && eventsRes.ok
      ? ((await eventsRes.json()) as { events?: RecoveryEvent[] }).events ?? []
      : []

  return (
    <>
      {/* EH.8 — Cross-tab click→FCP perf telemetry. */}
      <NewTabClickPerf button="recover" productId={productId} />
      <RecoverClient
        productId={productId}
        product={product}
        listings={product.channelListings ?? []}
        events={events}
      />
    </>
  )
}

function FailureView({
  productId,
  title,
  detail,
}: {
  productId: string
  title: string
  detail: string
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md w-full bg-white border border-default rounded-lg shadow-sm p-6 text-center">
        <h1 className="text-xl font-semibold text-slate-900 mb-2">{title}</h1>
        <p className="text-md text-slate-600 mb-4">{detail}</p>
        <a
          href={`/products/${productId}/edit`}
          className="inline-flex items-center justify-center h-8 px-3 text-base font-medium text-blue-700 hover:text-blue-900 hover:underline"
        >
          ← Back to product
        </a>
      </div>
    </div>
  )
}
