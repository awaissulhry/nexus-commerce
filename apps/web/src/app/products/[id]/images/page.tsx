// /products/[id]/images — dedicated multi-scope image manager.
//
// C.11 — fills the page that the wizard's Step 7 has linked to since
// launch but never existed (404 every click of "Open image manager").
// Wizard Step 7 still owns the quick master-gallery reorder for
// in-flight wizards; this page handles per-variant + per-scope
// (GLOBAL/PLATFORM/MARKETPLACE) overrides via the existing
// ListingImage table + ImageResolutionService cascade.

import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import ImagesClient from './ImagesClient'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

interface ListingImageRow {
  id: string
  productId: string
  variationId: string | null
  scope: 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
  platform: string | null
  marketplace: string | null
  url: string
  filename: string | null
  position: number
  role: string
  sourceProductImageId: string | null
}

interface MasterImage {
  id: string
  url: string
  alt: string | null
  type: string
  createdAt: string
}

interface VariantSummary {
  id: string
  sku: string
  name: string
  variantAttributes: Record<string, unknown> | null
}

interface ApiResponse {
  product?: { id: string; sku: string; name: string; isParent: boolean }
  master?: MasterImage[]
  overrides?: ListingImageRow[]
  variants?: VariantSummary[]
  error?: string
}

export default async function ImagesPage({ params }: PageProps) {
  const { id: productId } = await params
  const backend = getBackendUrl()

  let res: Response
  try {
    res = await fetch(
      `${backend}/api/products/${encodeURIComponent(productId)}/listing-images`,
      { cache: 'no-store' },
    )
  } catch {
    return (
      <FailureView
        productId={productId}
        title="Couldn't reach the API"
        detail="The image manager couldn't load because the API server is unreachable. Try again in a moment."
      />
    )
  }

  if (res.status === 404) {
    notFound()
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const j = (await res.json()) as ApiResponse
      if (j.error) detail = j.error
    } catch {
      /* ignore — fall back to status code */
    }
    return (
      <FailureView
        productId={productId}
        title="Couldn't load images"
        detail={detail}
      />
    )
  }

  const json = (await res.json()) as ApiResponse
  if (!json.product) {
    notFound()
  }

  return (
    <ImagesClient
      product={json.product}
      master={json.master ?? []}
      overrides={json.overrides ?? []}
      variants={json.variants ?? []}
    />
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
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg shadow-sm p-6 text-center dark:bg-slate-900 dark:border-slate-800">
        <h1 className="text-xl font-semibold text-slate-900 mb-2 dark:text-slate-100">
          {title}
        </h1>
        <p className="text-md text-slate-600 mb-4 dark:text-slate-400">
          {detail}
        </p>
        <a
          href={`/products/${productId}/edit`}
          className="inline-flex items-center justify-center h-8 px-3 text-base font-medium text-blue-700 hover:text-blue-900 hover:underline dark:text-blue-400"
        >
          ← Back to product
        </a>
      </div>
    </div>
  )
}
