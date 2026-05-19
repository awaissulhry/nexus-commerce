/**
 * Settings rebuild — Phase A.5
 *
 * Landing page for the settings hub. The old /settings route 302'd
 * to /settings/account; that hid the surface area from anyone who
 * landed here by deep-link.
 *
 * The landing now shows every group with cards for each page, so
 * a new operator scanning the hub gets a one-glance answer to
 * "what can I configure here?".
 *
 * Pure server component — no client hooks needed; SETTINGS_NAV is
 * static.
 */

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { SETTINGS_NAV } from './_shell/settings-nav'

export const dynamic = 'force-static'

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  beta: {
    label: 'Beta',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  },
  soon: {
    label: 'Soon',
    cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  },
}

export default function SettingsLandingPage() {
  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Workspace settings
        </h2>
        <p className="text-base text-slate-600 dark:text-slate-400">
          Configure your account, workspace, integrations, and developer tools.
        </p>
      </div>

      {SETTINGS_NAV.map((group) => (
        <section key={group.label} className="space-y-3">
          <div className="flex items-baseline justify-between border-b border-slate-200 dark:border-slate-800 pb-1.5">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
              {group.label}
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-500">
              {group.description}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.items.map((item) => {
              const Icon = item.icon
              const badge = item.status ? STATUS_BADGE[item.status] : null
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  className="group block rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-sm transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-700 dark:group-hover:bg-blue-950/40 dark:group-hover:text-blue-300 transition-colors">
                      <Icon size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          {item.label}
                        </div>
                        {badge && (
                          <span
                            className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${badge.cls}`}
                          >
                            {badge.label}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                        {item.description}
                      </p>
                    </div>
                    <ChevronRight
                      size={14}
                      className="text-slate-400 dark:text-slate-500 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors shrink-0 mt-1"
                    />
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
