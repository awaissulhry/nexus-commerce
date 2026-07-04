'use client'

/**
 * Client-side fallback loader for the product edit page.
 *
 * page.tsx renders this ONLY when its server-side data load came back
 * unauthenticated/errored — which is the norm under RBAC enforce mode, where
 * the Next.js server can't read the API-origin session cookie. Here in the
 * browser the credentialed global fetch wrapper attaches the session, so the
 * same loader succeeds for a permitted user (and still 401s → login redirect
 * for one who isn't). Once loaded we render the real editor unchanged.
 */

import { useCallback, useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import ProductEditClient from './ProductEditClient'
import ProductEditLoading from './loading'
import { loadEditData, type EditLoadResult } from './edit-data'

export default function ProductEditLoader({ id }: { id: string }) {
  const [result, setResult] = useState<EditLoadResult | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    loadEditData(id).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  if (!result) return <ProductEditLoading />
  if (result.kind === 'notfound') notFound()

  if (result.kind === 'error') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Couldn&apos;t load this product
          {result.code ? ` (HTTP ${result.code})` : ''}.
        </p>
        <button
          type="button"
          onClick={retry}
          className="inline-flex h-8 items-center rounded-md border border-default px-3 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Retry
        </button>
      </div>
    )
  }

  const { data } = result
  return (
    <ProductEditClient
      product={data.product}
      listings={{}}
      marketplaces={data.marketplaces}
      childrenList={data.childrenList}
      parentProduct={data.parentProduct}
      siblings={data.siblings}
      parentListings={{}}
    />
  )
}
