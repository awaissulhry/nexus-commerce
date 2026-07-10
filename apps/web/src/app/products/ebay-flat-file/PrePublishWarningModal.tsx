'use client'

/**
 * Safeguard S2 — pre-publish warning modal (WARN, NEVER BLOCK).
 *
 * Shown right before a "Push to eBay" fires IF (and only if) the family has
 * theme/aspect issues. Each row names the specific axis/SKU/values and its fix.
 * The primary action ALWAYS proceeds ("Publish anyway"); the secondary closes
 * without pushing. There is no blocking path — this is an operator courtesy,
 * never a gate (operator decision 2026-07-10).
 *
 * Lives in the ebay-flat-file dir, which is exempt from the raw-slate token guard.
 */

import { AlertTriangle, Info, Layers } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/components/ui/Button'
import type { PrePublishIssue } from './prePublishIssues.pure'

const KIND_META: Record<PrePublishIssue['kind'], { icon: typeof AlertTriangle; tone: string; label: string }> = {
  conflict:      { icon: AlertTriangle, tone: 'text-amber-500',  label: 'Duplicate aspect' },
  'axis-warning': { icon: Layers,       tone: 'text-amber-500',  label: 'Variation axis' },
  suppressed:    { icon: Info,          tone: 'text-slate-400',  label: 'Auto-resolved' },
}

export function PrePublishWarningModal({
  open,
  issues,
  publishing,
  onPublishAnyway,
  onGoBack,
}: {
  open: boolean
  issues: PrePublishIssue[]
  publishing?: boolean
  onPublishAnyway: () => void
  onGoBack: () => void
}) {
  const count = issues.length
  return (
    <Modal
      open={open}
      onClose={onGoBack}
      size="md"
      title="Review before publishing"
      subtitle={`${count} thing${count !== 1 ? 's' : ''} to double-check — you can publish anyway.`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onGoBack}>Go back &amp; fix</Button>
          <Button size="sm" loading={publishing} onClick={onPublishAnyway}>Publish anyway</Button>
        </div>
      }
    >
      <div className="space-y-2.5">
        {issues.map((issue, i) => {
          const meta = KIND_META[issue.kind]
          const Icon = meta.icon
          return (
            <div
              key={i}
              className="flex items-start gap-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2.5"
            >
              <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${meta.tone}`} />
              <div className="min-w-0">
                <div className="text-[13px] text-slate-800 dark:text-slate-100 leading-snug">
                  {issue.message}
                </div>
                {issue.fix && (
                  <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                    Fix: {issue.fix}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
