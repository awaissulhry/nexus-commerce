/**
 * Phase S3 — shared centered card for the standalone auth surfaces
 * (login, forgot/reset password, accept invite, 403).
 */

import type { ReactNode } from 'react'

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 font-display text-lg font-bold text-white">
            N
          </div>
          <h1 className="font-display text-xl font-semibold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>
        <div className="rounded-xl border border-default bg-white p-6 shadow-sm">{children}</div>
        <p className="mt-6 text-center text-xs text-tertiary">Nexus Commerce</p>
      </div>
    </div>
  )
}
