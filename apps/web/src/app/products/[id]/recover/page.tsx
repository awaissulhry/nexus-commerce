'use client'

/**
 * W5.49 — listing recovery page.
 *
 * Pulls the product + its existing channel listings and the last 20
 * audit events, then hands them to the client picker.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so the old server-side fetches 401'd
 * and everyone saw the failure card in prod. Data MUST load client-side
 * where the patched window.fetch adds credentials.
 *
 * The actual destructive call goes via /api/products/:id/recover; on
 * success the client redirects to the wizard URL the API returned for
 * the recreate step.
 */

import { useEffect, useState } from 'react'
import { notFound, useParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import RecoverClient, {
  type RecoverChannelListing,
  type RecoverProduct,
  type RecoveryEvent,
} from './RecoverClient'
import NewTabClickPerf from '@/components/perf/NewTabClickPerf'
import RecoverLoading from './loading'

type LoadState =
  | { phase: 'loading' }
  | { phase: 'notfound' }
  | { phase: 'error'; titleKey: string; detail: string | null }
  | {
      phase: 'ready'
      product: RecoverProduct & { channelListings?: RecoverChannelListing[] }
      events: RecoveryEvent[]
    }

export default function RecoverPage() {
  const params = useParams<{ id: string }>()
  const productId = params?.id ?? ''
  const { t } = useTranslations()

  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })
    ;(async () => {
      const backend = getBackendUrl()

      // EH.3 — Parallel fetch of /health (slow: 200–500 ms Prisma joins)
      // and /recover/events (cheap: ~50 ms). .catch(() => null) on each
      // preserves the "network error vs non-2xx" distinction.
      const [productRes, eventsRes] = await Promise.all([
        fetch(`${backend}/api/products/${productId}/health`, {
          cache: 'no-store',
        }).catch(() => null),
        fetch(`${backend}/api/products/${productId}/recover/events`, {
          cache: 'no-store',
        }).catch(() => null),
      ])
      if (!alive) return

      if (!productRes) {
        setState({
          phase: 'error',
          titleKey: 'recover.error.unreachableTitle',
          detail: null,
        })
        return
      }
      if (productRes.status === 404) {
        setState({ phase: 'notfound' })
        return
      }
      if (!productRes.ok) {
        setState({
          phase: 'error',
          titleKey: 'recover.error.loadFailedTitle',
          detail: `HTTP ${productRes.status}`,
        })
        return
      }

      const product = (await productRes.json()) as RecoverProduct & {
        channelListings?: RecoverChannelListing[]
      }
      if (!alive) return
      if (!product?.id) {
        setState({ phase: 'notfound' })
        return
      }

      const events: RecoveryEvent[] =
        eventsRes && eventsRes.ok
          ? ((await eventsRes.json()) as { events?: RecoveryEvent[] }).events ?? []
          : []
      if (!alive) return

      setState({ phase: 'ready', product, events })
    })()
    return () => {
      alive = false
    }
  }, [productId])

  if (state.phase === 'notfound') notFound()

  if (state.phase === 'loading') {
    return (
      <>
        {/* EH.8 — Cross-tab click→FCP perf telemetry. */}
        <NewTabClickPerf button="recover" productId={productId} />
        <RecoverLoading />
      </>
    )
  }

  if (state.phase === 'error') {
    return (
      <FailureView
        productId={productId}
        title={t(state.titleKey)}
        detail={state.detail ?? t('recover.error.unreachableDetail')}
      />
    )
  }

  return (
    <>
      {/* EH.8 — Cross-tab click→FCP perf telemetry. */}
      <NewTabClickPerf button="recover" productId={productId} />
      <RecoverClient
        productId={productId}
        product={state.product}
        listings={state.product.channelListings ?? []}
        events={state.events}
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
