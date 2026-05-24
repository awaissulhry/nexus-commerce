'use client'

// EC.9 — HealthScoreRail
//
// Replaces the EC.1 HealthRail placeholder with a real 0–100 score +
// grouped check list. Hard fails are surfaced at the top with a
// publish-blocked banner. Soft warnings drag the score down but
// don't block.
//
// Visual:
//   ┌─ Pre-publish health ────────────────────  82 / 100 ┐
//   │ ⊘ Publish blocked — 1 hard fail              │
//   │ ─────────────────────────────────────────────│
//   │ Content                              25 / 30 │
//   │   ✓ Title length (62/80)                     │
//   │   ⚠ Description (140 chars)                  │
//   │ Aspects                              15 / 30 │
//   │   ✗ Required (3/8 missing)         hard fail │
//   │ …                                            │
//   └──────────────────────────────────────────────┘

import { useMemo } from 'react'
import { CheckCircle2, AlertTriangle, XCircle, Ban, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useHealthScore, type Check, type CheckStatus } from './useHealthScore'

interface Props {
  marketplace: string
  categoryId: string | null
  categoryName: string | null
  categoryPath: string | null
  title: string
  description: string
  brand: string | null
  gtin: string | null
  mpn: string | null
  priceValue: number | null
  imageCount: number
  itemSpecifics: Record<string, unknown>
  policies: {
    fulfillmentPolicyId: string | null
    paymentPolicyId: string | null
    returnPolicyId: string | null
    merchantLocationKey: string | null
  }
}

const GROUP_LABELS: Record<Check['group'], string> = {
  content:  'Content',
  images:   'Images',
  aspects:  'Category & Aspects',
  pricing:  'Pricing & Policies',
  gates:    'Category gates',
}

const STATUS_ICON: Record<CheckStatus, React.ComponentType<{ className?: string }>> = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
}

const STATUS_TONE: Record<CheckStatus, string> = {
  pass: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  fail: 'text-rose-600 dark:text-rose-400',
}

function scoreTone(score: number): { ring: string; text: string; bg: string; label: string } {
  if (score >= 85) return { ring: 'ring-emerald-300 dark:ring-emerald-700', text: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-950/40', label: 'Excellent' }
  if (score >= 70) return { ring: 'ring-blue-300 dark:ring-blue-700',       text: 'text-blue-700 dark:text-blue-300',       bg: 'bg-blue-50 dark:bg-blue-950/40',       label: 'Ready to publish' }
  if (score >= 50) return { ring: 'ring-amber-300 dark:ring-amber-700',     text: 'text-amber-700 dark:text-amber-300',     bg: 'bg-amber-50 dark:bg-amber-950/40',     label: 'Needs polish' }
  return                  { ring: 'ring-rose-300 dark:ring-rose-700',       text: 'text-rose-700 dark:text-rose-300',       bg: 'bg-rose-50 dark:bg-rose-950/40',       label: 'Major gaps' }
}

export default function HealthScoreRail(props: Props) {
  const result = useHealthScore(props)
  const tone = scoreTone(result.score)

  const grouped = useMemo(() => {
    const map: Record<Check['group'], Check[]> = {
      content: [], images: [], aspects: [], pricing: [], gates: [],
    }
    for (const c of result.checks) map[c.group].push(c)
    return map
  }, [result.checks])

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-3">
      {/* ── Score header ─────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            Pre-publish health
          </div>
          <div className={cn('text-[10.5px] font-medium', tone.text)}>
            {tone.label}
          </div>
        </div>
        <div
          className={cn(
            'text-right rounded-md px-2.5 py-1 ring-1',
            tone.bg, tone.ring,
          )}
        >
          <div className={cn('text-xl font-bold leading-none tabular-nums', tone.text)}>
            {result.score}
          </div>
          <div className="text-[9px] text-slate-500 dark:text-slate-400 mt-0.5">/ 100 · {props.marketplace}</div>
        </div>
      </div>

      {/* ── Publish gate ─────────────────────────────────────────── */}
      {!result.canPublish && (
        <div className="px-2 py-1.5 rounded border border-rose-200 dark:border-rose-800 bg-rose-50/60 dark:bg-rose-950/30 text-[10.5px] text-rose-800 dark:text-rose-300 flex items-start gap-1.5">
          <Ban className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Publish blocked</div>
            <div>{result.hardFails.length} hard fail{result.hardFails.length === 1 ? '' : 's'} — fix below to enable Publish.</div>
          </div>
        </div>
      )}
      {result.canPublish && result.score >= 70 && (
        <div className="px-2 py-1.5 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30 text-[10.5px] text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5 flex-shrink-0" />
          Ready to publish on eBay {props.marketplace}.
        </div>
      )}

      {/* ── Grouped checks ───────────────────────────────────────── */}
      <div className="space-y-2">
        {(Object.keys(GROUP_LABELS) as Check['group'][]).map((g) => {
          const list = grouped[g]
          if (!list || list.length === 0) return null
          const earned = list.reduce((acc, c) => acc + c.earned, 0)
          const total = list.reduce((acc, c) => acc + c.weight, 0)
          return (
            <div key={g} className="space-y-1">
              <div className="flex items-baseline justify-between text-[10.5px]">
                <span className="font-semibold text-slate-700 dark:text-slate-300">{GROUP_LABELS[g]}</span>
                <span className="text-slate-500 dark:text-slate-400 tabular-nums">{earned} / {total}</span>
              </div>
              <ul className="space-y-0.5">
                {list.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </ul>
            </div>
          )
        })}
      </div>

      {result.loading && (
        <div className="text-[10px] text-slate-400 italic">
          Loading category schema — score may shift when complete.
        </div>
      )}
    </div>
  )
}

function CheckRow({ check }: { check: Check }) {
  const Icon = STATUS_ICON[check.status]
  return (
    <li
      className="flex items-start gap-1.5 text-[10.5px]"
      title={check.hint ?? ''}
    >
      <Icon className={cn('w-3 h-3 flex-shrink-0 mt-[1.5px]', STATUS_TONE[check.status])} />
      <span className={cn('flex-1', check.status === 'fail' ? 'text-slate-800 dark:text-slate-200' : 'text-slate-600 dark:text-slate-400')}>
        {check.label}
        {check.hard && check.status === 'fail' && (
          <span className="ml-1 px-1 py-0 rounded bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 text-[9px] uppercase tracking-wide">
            hard fail
          </span>
        )}
      </span>
    </li>
  )
}
