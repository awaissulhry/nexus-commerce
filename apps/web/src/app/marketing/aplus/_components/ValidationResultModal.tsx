'use client'

// MC.8.8 — server-side validation result modal.
//
// Renders the structured ValidationResult from /validate. Blocking
// vs warning issues split into their own sections. Module-scoped
// issues link by index (we don't drop the operator on the canvas
// row — the module is already visible in the canvas behind the
// modal — but the index lets them eyeball where to look).

import { AlertTriangle, AlertOctagon, CheckCircle2, X } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'

export interface ValidationIssue {
  severity: 'blocking' | 'warning'
  code: string
  message: string
  moduleIndex?: number
}

export interface ValidationResult {
  ok: boolean
  blocking: ValidationIssue[]
  warnings: ValidationIssue[]
  summary: {
    moduleCount: number
    tier: 'standard' | 'premium'
    moduleCap: number
  }
}

interface Props {
  open: boolean
  onClose: () => void
  result: ValidationResult | null
}

export default function ValidationResultModal({
  open,
  onClose,
  result,
}: Props) {
  const { t } = useTranslations()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('aplus.validate.title')}
      size="lg"
    >
      <ModalBody>
        {!result ? null : (
          <div className="space-y-3">
            {/* Document summary banner */}
            <div
              className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                result.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200'
                  : 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200'
              }`}
            >
              {result.ok ? (
                <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertOctagon className="w-5 h-5 flex-shrink-0 mt-0.5" />
              )}
              <div>
                <p className="font-medium">
                  {result.ok
                    ? t('aplus.validate.passed')
                    : t('aplus.validate.failed', {
                        n: result.blocking.length.toString(),
                      })}
                </p>
                <p className="text-xs opacity-80">
                  {t('aplus.validate.summary', {
                    count: result.summary.moduleCount.toString(),
                    cap: result.summary.moduleCap.toString(),
                    tier: result.summary.tier,
                  })}
                </p>
              </div>
            </div>

            {/* Blocking issues */}
            {result.blocking.length > 0 && (
              <section>
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
                  <AlertOctagon className="w-3.5 h-3.5" />
                  {t('aplus.validate.blockingTitle', {
                    n: result.blocking.length.toString(),
                  })}
                </h3>
                <ul className="mt-1.5 space-y-1.5">
                  {result.blocking.map((issue, idx) => (
                    <IssueRow key={idx} issue={issue} tone="blocking" />
                  ))}
                </ul>
              </section>
            )}

            {/* Warnings */}
            {result.warnings.length > 0 && (
              <section>
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {t('aplus.validate.warningTitle', {
                    n: result.warnings.length.toString(),
                  })}
                </h3>
                <ul className="mt-1.5 space-y-1.5">
                  {result.warnings.map((issue, idx) => (
                    <IssueRow key={idx} issue={issue} tone="warning" />
                  ))}
                </ul>
              </section>
            )}

            {result.blocking.length === 0 && result.warnings.length === 0 && (
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {t('aplus.validate.cleanRun')}
              </p>
            )}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onClose}>
          <X className="w-4 h-4 mr-1" />
          {t('common.close')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

function IssueRow({
  issue,
  tone,
}: {
  issue: ValidationIssue
  tone: 'blocking' | 'warning'
}) {
  const colors =
    tone === 'blocking'
      ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200'
      : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200'
  return (
    <li className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${colors}`}>
      <span className="rounded bg-black/10 px-1 font-mono text-[10px] dark:bg-white/10">
        {issue.code}
      </span>
      <span className="flex-1">
        {typeof issue.moduleIndex === 'number' && (
          <span className="font-semibold">
            #{issue.moduleIndex + 1}{' '}
          </span>
        )}
        {issue.message}
      </span>
    </li>
  )
}
