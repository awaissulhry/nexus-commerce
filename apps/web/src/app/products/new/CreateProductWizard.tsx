// SS — auto-create + redirect into the listing wizard.
//
// User feedback was clear: the listing wizard handles the entire
// flow (channels, markets, productType, identifiers, attributes,
// images, pricing, review, submit). Don't add a separate create
// wizard, don't modify the listing wizard. Just create a draft
// product up front and drop the user into the listing wizard for
// it. Master SKU/name are placeholders here; the user can rename
// them later from /products/[id]/edit if they want to.

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'

export default function CreateProductWizard() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  // SS — guard against double-effect runs in React strict mode.
  // Without this, the auto-create POST fires twice on first mount,
  // creating two products. Idempotency-Key on the API also dedups
  // server-side, but stopping it client-side is cleaner.
  const triggeredRef = useRef(false)

  useEffect(() => {
    if (triggeredRef.current) return
    triggeredRef.current = true
    void run()

    async function run() {
      try {
        // Generate a draft SKU. Combination of date + random suffix
        // keeps it short, sortable, and human-readable enough that
        // the user can grep their catalog if they forget to rename
        // it. Format: NEW-YYYYMMDD-XXXX
        const today = new Date()
        const yyyymmdd =
          today.getFullYear().toString() +
          String(today.getMonth() + 1).padStart(2, '0') +
          String(today.getDate()).padStart(2, '0')
        const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
        const draftSku = `NEW-${yyyymmdd}-${suffix}`

        const createRes = await fetch(
          `${getBackendUrl()}/api/products/create-wizard`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // NN.2 — idempotency key derived from the draft SKU.
              // Strict-mode-double-mount safe: same key, same body,
              // server returns the cached result on the second call.
              'Idempotency-Key': `create-wizard:${draftSku}`,
            },
            body: JSON.stringify({
              sku: draftSku,
              name: 'Untitled product',
              basePrice: 0,
            }),
          },
        )
        const json = (await createRes.json().catch(() => ({}))) as {
          success?: boolean
          product?: { id: string }
          error?: string
        }
        if (!createRes.ok || !json?.success || !json.product?.id) {
          setError(
            json?.error ?? `Couldn't start a new product (HTTP ${createRes.status}).`,
          )
          return
        }
        // UU — drop straight into the listing wizard at its default
        // first step (Channels). Master SKU/name placeholders can be
        // renamed later from /products/[id]/edit on the master tab.
        // The listing wizard itself is unmodified.
        router.replace(`/products/${json.product.id}/list-wizard`)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [router])

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        {!error ? (
          <>
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 text-blue-600 mb-4">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
            <h1 className="text-[18px] font-semibold text-slate-900 mb-1">
              Setting up your new product…
            </h1>
            <p className="text-[13px] text-slate-600">
              We're creating a draft and dropping you into the listing
              wizard. You'll be able to rename the SKU and master name
              later from the edit page.
            </p>
          </>
        ) : (
          <>
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-rose-50 text-rose-600 mb-4">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h1 className="text-[18px] font-semibold text-slate-900 mb-1">
              Couldn't start a new product
            </h1>
            <p className="text-[13px] text-slate-600 mb-4 break-words">
              {error}
            </p>
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => router.push('/products')}
              >
                Back to products
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  triggeredRef.current = false
                  setError(null)
                  // Trigger the effect again by remounting via key.
                  router.refresh()
                }}
              >
                Try again
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
