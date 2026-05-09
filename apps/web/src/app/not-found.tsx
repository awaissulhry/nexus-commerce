import Link from 'next/link'
import { FileQuestion, Home } from 'lucide-react'
import { Button } from '@/components/ui/Button'

/**
 * Root not-found boundary. Catches any `notFound()` call from a server
 * component and any unmatched route. Without this, Next.js renders its
 * default barebones 404 with no sidebar.
 *
 * U.62 — added after the QA audit found 0 not-found.tsx files in the app.
 */
export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 mb-4">
          <FileQuestion className="w-5 h-5 text-slate-500 dark:text-slate-400" />
        </div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-1">
          Page not found
        </h2>
        <p className="text-md text-slate-600 dark:text-slate-400 mb-4">
          The page you're looking for doesn't exist or may have moved.
        </p>
        <Link href="/">
          <Button variant="primary">
            <Home className="w-3.5 h-3.5 mr-1.5" />
            Back to dashboard
          </Button>
        </Link>
      </div>
    </div>
  )
}
