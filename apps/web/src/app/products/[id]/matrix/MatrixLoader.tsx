'use client'

/**
 * Client-side fallback loader for the variant-matrix page — mirrors
 * ProductEditLoader. page.tsx renders this when its server-side load came
 * back unauthenticated/errored (the norm under RBAC enforce); the browser's
 * credentialed fetch wrapper then authenticates the same requests.
 */

import { useCallback, useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import MatrixResult from './MatrixResult'
import { loadMatrixData, type MatrixLoadResult } from './matrix-data'

export default function MatrixLoader({ id }: { id: string }) {
  const [result, setResult] = useState<MatrixLoadResult | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    loadMatrixData(id).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  if (!result) {
    return (
      <div className="py-24 text-center text-sm text-slate-500">Loading matrix…</div>
    )
  }
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

  return (
    <MatrixResult
      id={id}
      product={result.data.product}
      initialChildren={result.data.children}
    />
  )
}
