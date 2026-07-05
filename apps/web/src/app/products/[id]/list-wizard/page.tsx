'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side POST /start
// 401'd and everyone saw the "Couldn't start the wizard" failure card in
// prod. The start call MUST run client-side where the patched window.fetch
// adds credentials.

import { Suspense, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import ListWizardClient, {
  type WizardData,
  type WizardProduct,
  type ChannelTuple,
} from './ListWizardClient'

interface RawWizardResponse {
  wizard?: {
    id: string
    productId: string
    channels?: ChannelTuple[]
    channelsHash?: string
    currentStep: number
    state: Record<string, unknown> | null
    channelStates?: Record<string, Record<string, unknown>> | null
    submissions?: unknown[] | null
    status: string
    updatedAt?: string
  }
  product?: WizardProduct
  /** C.7 — true when /start created a fresh ListingWizard row
   *  (vs resuming an existing DRAFT). Drives the one-shot
   *  wizard.created broadcast on the client. */
  isNew?: boolean
  error?: string
}

type StartState =
  | { phase: 'loading' }
  | { phase: 'error'; title: string; detail: string }
  | {
      phase: 'ready'
      wizard: WizardData
      product: WizardProduct
      isNew: boolean
      stepFromUrl?: number
    }

// useSearchParams() requires a Suspense boundary at prerender time, so the
// page shell wraps the real component.
export default function ListWizardPage() {
  return (
    <Suspense fallback={<StartingView />}>
      <ListWizardPageInner />
    </Suspense>
  )
}

function ListWizardPageInner() {
  const params = useParams<{ id: string }>()
  const productId = params?.id ?? ''
  // Phase B: query params are optional. If `?channel=` + `?marketplace=`
  // are present, we kick off a single-channel wizard for back-compat
  // with old deep-links and the existing /products/:id/edit entry.
  // Without them, the wizard starts empty and the user picks channels
  // in Step 1.
  //
  // PR.1 — `?step=N` deep-links into a specific step on first paint.
  // Validated against [1, 9] before being passed to the client.
  const searchParams = useSearchParams()
  const channel = searchParams.get('channel') ?? undefined
  const marketplace = searchParams.get('marketplace') ?? undefined
  const stepParam = searchParams.get('step') ?? undefined

  const [state, setState] = useState<StartState>({ phase: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })
    ;(async () => {
      const backend = getBackendUrl()

      // Build the /start body. Phase B accepts either the legacy
      // (channel, marketplace) pair or no channels at all (Step 1 picks).
      const startBody: Record<string, unknown> = { productId }
      if (channel && marketplace) {
        startBody.channel = channel
        startBody.marketplace = marketplace
      }

      let res: Response
      try {
        res = await fetch(`${backend}/api/listing-wizard/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(startBody),
          cache: 'no-store',
        })
      } catch {
        if (alive)
          setState({
            phase: 'error',
            title: "Couldn't reach the API",
            detail:
              "The listing wizard couldn't start because the API server is unreachable. Try again in a moment.",
          })
        return
      }

      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          const json = (await res.json()) as RawWizardResponse
          if (json.error) detail = json.error
        } catch {
          /* ignore — fall back to status code */
        }
        if (alive)
          setState({
            phase: 'error',
            title: "Couldn't start the wizard",
            detail,
          })
        return
      }

      const json = (await res.json()) as RawWizardResponse
      if (!json.wizard || !json.product) {
        if (alive)
          setState({
            phase: 'error',
            title: 'Wizard payload missing',
            detail: 'The API returned a 200 but no wizard data. Refresh to retry.',
          })
        return
      }

      // Map the raw response (Json columns are unknown shape) into the
      // typed WizardData the client expects.
      const wizard: WizardData = {
        id: json.wizard.id,
        productId: json.wizard.productId,
        channels: Array.isArray(json.wizard.channels) ? json.wizard.channels : [],
        channelsHash: json.wizard.channelsHash,
        currentStep: json.wizard.currentStep,
        state: (json.wizard.state ?? {}) as Record<string, unknown>,
        channelStates: (json.wizard.channelStates ?? {}) as Record<
          string,
          Record<string, unknown>
        >,
        submissions: (json.wizard.submissions ?? []) as unknown[],
        status: json.wizard.status,
        updatedAt: json.wizard.updatedAt,
      }

      // PR.1 — validate ?step=N against [1, 9]. Out-of-range / non-numeric
      // ignored (client falls back to wizard.currentStep). Operators
      // can't deep-link into a step that hasn't been reached yet —
      // ListWizardClient's chrome-Continue gate would block forward
      // progress anyway, but disallowing here keeps the URL honest.
      const stepFromUrl = (() => {
        if (!stepParam) return undefined
        const n = parseInt(stepParam, 10)
        if (!Number.isFinite(n) || n < 1 || n > 9) return undefined
        if (n > wizard.currentStep) return undefined
        return n
      })()

      if (alive)
        setState({
          phase: 'ready',
          wizard,
          product: json.product,
          isNew: json.isNew === true,
          stepFromUrl,
        })
    })()
    return () => {
      alive = false
    }
  }, [productId, channel, marketplace, stepParam])

  if (state.phase === 'loading') return <StartingView />

  if (state.phase === 'error') {
    return (
      <FailureView
        productId={productId}
        title={state.title}
        detail={state.detail}
      />
    )
  }

  return (
    <ListWizardClient
      initialWizard={state.wizard}
      product={state.product}
      isNew={state.isNew}
      initialStepOverride={state.stepFromUrl}
    />
  )
}

function StartingView() {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-slate-50 p-6"
      aria-busy="true"
    >
      <div className="max-w-md w-full bg-white border border-default rounded-lg shadow-sm p-6 text-center">
        <h1 className="text-xl font-semibold text-slate-900 mb-2">
          Listing Wizard
        </h1>
        <p className="text-md text-slate-600 flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Starting the wizard…
        </p>
      </div>
    </div>
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
        <h1 className="text-xl font-semibold text-slate-900 mb-2">
          {title}
        </h1>
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
