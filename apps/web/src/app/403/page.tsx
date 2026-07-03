'use client'

/** Phase S3 — branded 403. Shown when a signed-in user lacks access. */

import { AuthCard } from '../_auth/AuthCard'

export default function ForbiddenPage() {
  return (
    <AuthCard title="Access denied" subtitle="You don't have permission to view this page.">
      <div className="space-y-4 text-center">
        <p className="text-sm text-slate-600">
          If you think this is a mistake, ask your workspace Owner to grant you access.
        </p>
        <a
          href="/dashboard/overview"
          className="inline-block w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Back to dashboard
        </a>
      </div>
    </AuthCard>
  )
}
