import { redirect } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import ListWizardClient, {
  type WizardData,
  type WizardProduct,
} from './ListWizardClient'

export const dynamic = 'force-dynamic'

interface StartResponse {
  wizard?: WizardData
  product?: WizardProduct
  error?: string
}

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ channel?: string; marketplace?: string }>
}

export default async function ListWizardPage({
  params,
  searchParams,
}: PageProps) {
  const { id: productId } = await params
  const { channel, marketplace } = await searchParams

  if (!channel || !marketplace) {
    // No channel/marketplace specified — bounce back to the product
    // edit page so the user can pick a target.
    redirect(`/products/${productId}/edit`)
  }

  const backend = getBackendUrl()
  let res: Response
  try {
    res = await fetch(`${backend}/api/listing-wizard/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, channel, marketplace }),
      cache: 'no-store',
    })
  } catch {
    return (
      <FailureView
        productId={productId}
        title="Couldn't reach the API"
        detail="The listing wizard couldn't start because the API server is unreachable. Try again in a moment."
      />
    )
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const json = (await res.json()) as StartResponse
      if (json.error) detail = json.error
    } catch {
      /* ignore — fall back to status code */
    }
    return (
      <FailureView
        productId={productId}
        title="Couldn't start the wizard"
        detail={detail}
      />
    )
  }

  const json = (await res.json()) as StartResponse
  if (!json.wizard || !json.product) {
    return (
      <FailureView
        productId={productId}
        title="Wizard payload missing"
        detail="The API returned a 200 but no wizard data. Refresh to retry."
      />
    )
  }

  return (
    <ListWizardClient initialWizard={json.wizard} product={json.product} />
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
      <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg shadow-sm p-6 text-center">
        <h1 className="text-[16px] font-semibold text-slate-900 mb-2">
          {title}
        </h1>
        <p className="text-[13px] text-slate-600 mb-4">{detail}</p>
        <a
          href={`/products/${productId}/edit`}
          className="inline-flex items-center justify-center h-8 px-3 text-[12px] font-medium text-blue-700 hover:text-blue-900 hover:underline"
        >
          ← Back to product
        </a>
      </div>
    </div>
  )
}
