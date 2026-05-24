'use client'

// AC.4 — Pre-publish health panel.
//
// Replaces the AC.1 HealthRail placeholder with a real scored panel:
//   * Donut-style score gauge (0–100) + status pill.
//   * Per-group check list (Blockers / Required / Recommended /
//     Polish), with Polish collapsed by default.
//   * Each row clickable — fires onJumpTo(target). The cockpit shell
//     scrolls the matching card into view and (when target=classic)
//     expands the transitional pass-through.
//   * Suppression banner when listing.listingStatus = SUPPRESSED —
//     calls out the AC.10 follow-up while still giving the operator
//     a glaring "this listing is offline" header.
//
// The component is dense on purpose (per user feedback memory:
// "visibility over minimalism — Salesforce/Airtable density").

import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertOctagon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import type {
  HealthCheck,
  HealthReport,
  CheckGroup,
  JumpTarget,
} from './computeHealthScore'

interface Props {
  report: HealthReport
  /** Click-to-jump handler. Cockpit owns the actual scroll/expand. */
  onJumpTo?: (target: JumpTarget) => void
  className?: string
}

const STATUS_STYLE: Record<
  HealthReport['status'],
  { label: string; ring: string; text: string; bg: string }
> = {
  ready: {
    label: 'Publish-ready',
    ring: 'stroke-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800',
  },
  warn: {
    label: 'Needs polish',
    ring: 'stroke-amber-500',
    text: 'text-amber-700 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800',
  },
  blocked: {
    label: 'Blocked',
    ring: 'stroke-rose-500',
    text: 'text-rose-700 dark:text-rose-400',
    bg: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800',
  },
  suppressed: {
    label: 'Suppressed',
    ring: 'stroke-rose-500',
    text: 'text-rose-700 dark:text-rose-400',
    bg: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800',
  },
}

const GROUP_META: Record<CheckGroup, { label: string; tone: string; tip: string }> = {
  blocker: {
    label: 'Blockers',
    tone: 'text-rose-700 dark:text-rose-400',
    tip: 'Must pass — Amazon rejects the listing otherwise.',
  },
  required: {
    label: 'Required',
    tone: 'text-amber-700 dark:text-amber-400',
    tip: 'Should pass before publish — Amazon will accept but the listing will look unfinished.',
  },
  recommended: {
    label: 'Recommended',
    tone: 'text-blue-700 dark:text-blue-400',
    tip: 'Lifts conversion / SEO — meaningful for the listing\'s long-term performance.',
  },
  polish: {
    label: 'Polish',
    tone: 'text-slate-600 dark:text-slate-400',
    tip: 'Nice-to-have — last 5% once everything else is green.',
  },
}

export default function HealthPanel({ report, onJumpTo, className }: Props) {
  const { t } = useTranslations()
  const [polishOpen, setPolishOpen] = useState(false)
  const style = STATUS_STYLE[report.status]
  // AC.13.2 — translate the status pill label via the i18n catalog.
  const statusLabel = t(
    `products.edit.cockpit.amazon.health.${report.status}`,
  )

  // Group checks for rendering.
  const grouped: Record<CheckGroup, HealthCheck[]> = {
    blocker: [],
    required: [],
    recommended: [],
    polish: [],
  }
  for (const c of report.checks) grouped[c.group].push(c)

  return (
    <div
      className={cn(
        'rounded-lg border bg-white dark:bg-slate-900 p-3 space-y-3',
        style.bg,
        className,
      )}
    >
      {/* Header — score donut + status pill */}
      <div className="flex items-center gap-3">
        <ScoreDonut score={report.score} ringClass={style.ring} />
        <div className="min-w-0 flex-1">
          <div className={cn('text-sm font-bold', style.text)}>
            {statusLabel}
          </div>
          <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
            {report.summary.blocker.pass}/{report.summary.blocker.total} blockers ·{' '}
            {report.summary.required.pass}/{report.summary.required.total} required ·{' '}
            {report.summary.recommended.pass}/{report.summary.recommended.total} rec
          </div>
        </div>
      </div>

      {report.status === 'suppressed' && (
        <div className="flex items-start gap-2 rounded-md border border-rose-300 dark:border-rose-700 bg-white dark:bg-slate-900 p-2">
          <AlertOctagon className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5" />
          <div className="text-[11px] text-slate-700 dark:text-slate-300">
            <span className="font-semibold text-rose-700 dark:text-rose-400">
              Listing suppressed.
            </span>{' '}
            Real suppression reasons land in AC.10 via the Listings Items API. For now check Seller Central → Manage Inventory → Suppressed.
          </div>
        </div>
      )}

      <div className="space-y-2">
        <CheckGroupSection
          group="blocker"
          checks={grouped.blocker}
          onJumpTo={onJumpTo}
        />
        <CheckGroupSection
          group="required"
          checks={grouped.required}
          onJumpTo={onJumpTo}
        />
        <CheckGroupSection
          group="recommended"
          checks={grouped.recommended}
          onJumpTo={onJumpTo}
        />

        {/* Polish — collapsible to keep the panel tight on tall screens. */}
        <div>
          <button
            type="button"
            onClick={() => setPolishOpen((o) => !o)}
            className="w-full flex items-center justify-between text-left py-1"
          >
            <div className="flex items-center gap-1.5">
              {polishOpen ? (
                <ChevronDown className="w-3 h-3 text-slate-400" />
              ) : (
                <ChevronRight className="w-3 h-3 text-slate-400" />
              )}
              <span className={cn('text-[11px] font-bold uppercase tracking-wide', GROUP_META.polish.tone)}>
                Polish
              </span>
              <span className="text-[11px] text-slate-500">
                {grouped.polish.filter((c) => c.status === 'pass').length}/
                {grouped.polish.length}
              </span>
            </div>
          </button>
          {polishOpen && (
            <div className="pt-1">
              {grouped.polish.map((c) => (
                <CheckRow
                  key={c.id}
                  check={c}
                  onJumpTo={onJumpTo}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="pt-2 border-t border-slate-200 dark:border-slate-800 text-[10.5px] text-slate-400 italic">
        Heuristic scoring — manifest-aware required fields land in AC.5, live suppression reasons in AC.10.
      </div>
    </div>
  )
}

// ── Score donut (SVG, no chart library) ────────────────────────────────
function ScoreDonut({ score, ringClass }: { score: number; ringClass: string }) {
  const R = 22
  const C = 2 * Math.PI * R
  const offset = C * (1 - Math.max(0, Math.min(100, score)) / 100)
  return (
    <div className="relative w-14 h-14 flex-shrink-0">
      <svg viewBox="0 0 56 56" className="w-full h-full -rotate-90">
        <circle
          cx={28}
          cy={28}
          r={R}
          fill="none"
          className="stroke-slate-200 dark:stroke-slate-700"
          strokeWidth={5}
        />
        <circle
          cx={28}
          cy={28}
          r={R}
          fill="none"
          strokeLinecap="round"
          className={cn(ringClass, 'transition-all duration-300')}
          strokeWidth={5}
          strokeDasharray={C}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-[13px] font-bold text-slate-900 dark:text-slate-100">
        {score}
      </div>
    </div>
  )
}

// ── Group section ──────────────────────────────────────────────────────
function CheckGroupSection({
  group,
  checks,
  onJumpTo,
}: {
  group: CheckGroup
  checks: HealthCheck[]
  onJumpTo?: (target: JumpTarget) => void
}) {
  if (checks.length === 0) return null
  const meta = GROUP_META[group]
  const passed = checks.filter((c) => c.status === 'pass').length
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span
          className={cn(
            'text-[11px] font-bold uppercase tracking-wide',
            meta.tone,
          )}
          title={meta.tip}
        >
          {meta.label}
        </span>
        <span className="text-[11px] text-slate-500">
          {passed}/{checks.length}
        </span>
      </div>
      <div>
        {checks.map((c) => (
          <CheckRow key={c.id} check={c} onJumpTo={onJumpTo} />
        ))}
      </div>
    </div>
  )
}

// ── Single check row ───────────────────────────────────────────────────
function CheckRow({
  check,
  onJumpTo,
}: {
  check: HealthCheck
  onJumpTo?: (target: JumpTarget) => void
}) {
  const isPass = check.status === 'pass'
  const isWarn = check.status === 'warn'
  return (
    <button
      type="button"
      onClick={() => onJumpTo?.(check.target)}
      className={cn(
        'w-full text-left py-1 px-1 rounded transition-colors flex items-start gap-1.5',
        'hover:bg-slate-100 dark:hover:bg-slate-800',
        isPass && 'opacity-90',
      )}
      title={check.hint ?? check.label}
    >
      <span
        aria-hidden
        className={cn(
          'w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0',
          isPass
            ? 'bg-emerald-500'
            : isWarn
            ? 'bg-amber-400'
            : 'bg-rose-500',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'text-[11.5px] leading-tight',
              isPass
                ? 'text-slate-700 dark:text-slate-300'
                : 'text-slate-900 dark:text-slate-100 font-medium',
            )}
          >
            {check.label}
          </span>
          {check.value && (
            <span className="font-mono text-[10px] text-slate-400 flex-shrink-0">
              {check.value}
            </span>
          )}
        </div>
        {!isPass && check.hint && (
          <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
            {check.hint}
          </div>
        )}
      </div>
    </button>
  )
}
