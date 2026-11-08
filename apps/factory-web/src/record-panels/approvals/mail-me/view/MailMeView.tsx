'use client'

import { Mail } from 'lucide-react'
import { Button, Spinner, Toggle } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../i18n'
import '../../approvals.css'

export interface MailMeViewModel {
  read: 'loading' | 'ready' | 'failed'
  on: boolean
  since: string | null
  lastSentAt: string | null
  busy: boolean
  /** A message key of `record-approvals` (the switch was refused or failed). */
  problem: string | null
  timeZone?: string
}

/**
 * PLT-089 — "E-mail me approvals that wait for me": the person's own switch (Home › Approvals). Off by default (nothing is
 * mailed unless asked, PLT-142); on, each approval that waits for their decision comes by e-mail with a link that opens it
 * here after the office sign-in — the mail carries no figure and approves nothing by itself. One view model, nothing fetched.
 */
export function MailMeView({ model, onToggle, onRetry }: { model: MailMeViewModel; onToggle?: (on: boolean) => void; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={['record-approvals']}>
      <MailMe model={model} onToggle={onToggle} onRetry={onRetry} />
    </WithMessages>
  )
}

function MailMe({ model, onToggle, onRetry }: { model: MailMeViewModel; onToggle?: (on: boolean) => void; onRetry?: () => void }) {
  const t = useT('record-approvals')
  const locale = useLocale()
  const labelId = 'fw-ra-mailme-label'
  return (
    <div className="fw-ra-mailme">
      <Mail size={16} aria-hidden />
      <span id={labelId} className="fw-ra-mailme-label">
        {t('mailMe.label')}
      </span>
      {model.read === 'loading' ? (
        <Spinner size={14} aria-label={t('mailMe.loading')} />
      ) : model.read === 'failed' ? (
        <span className="fw-ra-muted" role="status">
          {t('mailMe.failed')}{' '}
          <Button size="sm" variant="quiet" onClick={() => onRetry?.()}>
            {t('retry')}
          </Button>
        </span>
      ) : (
        <>
          <Toggle checked={model.on} aria-labelledby={labelId} aria-busy={model.busy || undefined} onChange={(next) => !model.busy && onToggle?.(next)} />
          <span className="fw-ra-muted" role="status">
            {model.problem
              ? t(model.problem)
              : model.on
                ? model.lastSentAt
                  ? t('mailMe.onLast', { at: formatDateTime(model.lastSentAt, { locale, timeZone: model.timeZone }) })
                  : t('mailMe.on')
                : t('mailMe.off')}
          </span>
        </>
      )}
    </div>
  )
}
