'use client'

import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app/error]', error)
  }, [error])

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-amber-50 border border-amber-200 mb-4">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-1">
          Something went wrong
        </h2>
        <p className="text-md text-slate-600 mb-4 break-words">
          {error.message || 'An unexpected error occurred.'}
        </p>
        {error.digest && (
          <p className="text-sm text-slate-400 font-mono mb-4">
            digest: {error.digest}
          </p>
        )}
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  )
}
