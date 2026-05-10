'use client'

// MC.10.4 — Brand consistency monitoring section.
//
// Pinned at the top of the BrandKit edit page (above identity).
// Runs the consistency check on load + on demand, surfacing
// blocking / warning / info issues. Each issue can carry a deep-
// link to the offending document (A+, Brand Story, or back to the
// kit) so the operator can fix in one click.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ShieldCheck,
  AlertOctagon,
  AlertTriangle,
  Info,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ConsistencyIssue {
  severity: 'blocking' | 'warning' | 'info'
  code: string
  message: string
  link?: {
    kind: 'aplus' | 'brand_story' | 'brand_kit'
    id: string
    label?: string
  }
}

interface ConsistencyResult {
  brand: string
  ranAt: string
  blocking: number
  warnings: number
  info: number
  issues: ConsistencyIssue[]
}

interface Props {
  brand: string
  apiBase: string
}

const SEVERITY_TONE = {
  blocking:
    'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200',
  warning:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200',
  info: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300',
}

const SEVERITY_ICON = {
  blocking: AlertOctagon,
  warning: AlertTriangle,
  info: Info,
}

export default function ConsistencySection({ brand, apiBase }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [result, setResult] = useState<ConsistencyResult | null>(null)
  const [loading, setLoading] = useState(false)

  const run = async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${apiBase}/api/brand-kits/${encodeURIComponent(brand)}/consistency`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`Check failed (${res.status})`)
      const data = (await res.json()) as { result: ConsistencyResult }
      setResult(data.result)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('brandKit.consistency.runError'),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand])

  const totalIssues =
    (result?.blocking ?? 0) + (result?.warnings ?? 0) + (result?.info ?? 0)

  const allClear = result && totalIssues === 0

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <ShieldCheck className="w-4 h-4 text-slate-400" />
          {t('brandKit.consistency.title')}
          {result && (
            <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">
              ({totalIssues})
            </span>
          )}
        </h2>
        <Button
          variant="secondary"
          size="sm"
          onClick={run}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
          )}
          {t('brandKit.consistency.runCta')}
        </Button>
      </header>

      {!result ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {loading
            ? t('brandKit.consistency.running')
            : t('brandKit.consistency.notRun')}
        </p>
      ) : allClear ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          {t('brandKit.consistency.allClear')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {result.issues.map((issue, idx) => {
            const Icon = SEVERITY_ICON[issue.severity]
            return (
              <li
                key={idx}
                className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${SEVERITY_TONE[issue.severity]}`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span className="rounded bg-black/10 px-1 font-mono text-[10px] dark:bg-white/10">
                  {issue.code}
                </span>
                <span className="flex-1">{issue.message}</span>
                {issue.link && (
                  <Link
                    href={
                      issue.link.kind === 'aplus'
                        ? `/marketing/aplus/${issue.link.id}`
                        : issue.link.kind === 'brand_story'
                          ? `/marketing/brand-story/${issue.link.id}`
                          : `/marketing/brand-kit/${encodeURIComponent(brand)}`
                    }
                    className="text-xs font-medium underline hover:no-underline"
                  >
                    {t('brandKit.consistency.openLink')}
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {result && (
        <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-400">
          {t('brandKit.consistency.lastRun', {
            when: new Date(result.ranAt).toLocaleString(),
          })}
        </p>
      )}
    </section>
  )
}
