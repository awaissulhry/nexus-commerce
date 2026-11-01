'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ArrowLeft, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, EmptyState, Field, Menu } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { StepUpModal, Textarea } from '../../../../lib/i18n/ds-parts'
import { isListKey } from '../../../../list-frame/model'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { DialogFrame } from '../../_shared/parts'
import { accountingHref, cancelHeld, LOCK_TONE, monthWords, wizardHref } from '../model'
import type { AccountingActions, AccountingModel } from '../view-model'
import { HistoryList } from './HistoryList'
import { LockDialog } from './LockPanel'
import { Wizard } from './Wizard'
import '../../_shared/finance.css'
import '../accounting.css'

export type { AccountingActions, AccountingModel } from '../view-model'

/**
 * SCR-156 — Finance › Close › Accounting export (design finance.accounting; FIN-046, LOG-098, LOG-100, FIN-106, FIN-151):
 * the band (the period lock of this month and the two before, as of, live; New export; ⋯ Lock a period, Account mapping
 * (W2b)), then either the Exports (every numbered batch, what it carried, its files, the documents changed since) or the
 * export wizard (`?new=1`, `?month=&step=`: period, checks, contents, Intrastat rows, review, export and lock). Nexus's
 * default layout until the accountant names theirs (to confirm with the accountant); nothing is sent to the accountant
 * or to any authority: a person hands the files over. No money in the history; the wizard's sums by their grain.
 */
export function AccountingView({ model, actions }: { model: AccountingModel; actions?: AccountingActions }) {
  return (
    <WithMessages namespaces={['finance-accounting', 'finance', 'lists']}>
      <Accounting model={model} actions={actions} />
    </WithMessages>
  )
}

function Accounting({ model, actions }: { model: AccountingModel; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const locale = useLocale()
  const wizard = model.wizard

  // `c` — New export (on the history, when the person may make one).
  useEffect(() => {
    if (wizard || !model.can.export) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' || !isListKey(event, event.target as HTMLElement | null)) return
      event.preventDefault()
      actions?.onNew?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wizard, model.can.export, actions])

  if (!model.can.view) {
    return (
      <div className="fw-fac">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const cancel = model.cancelDialog
  const cancelHold = cancel ? cancelHeld(cancel.row, model.can) ?? (cancel.reason.trim() === '' ? { key: 'cancel.held.reason' } : cancel.busy ? { key: 'held.busy' } : null) : null

  return (
    <div className="fw-fac">
      <div className="fw-fac-band" role="group" aria-label={t('band.label')}>
        <span className="fw-fac-inline">
          <span className="fw-fac-muted">{t('band.locks')}</span>
          {model.recent ? (
            model.recent.map((entry) => (
              <Pill key={entry.month} tone={LOCK_TONE[entry.state]} onClick={() => actions?.onOpenLock?.(entry.month)} aria-label={t('band.lockPillLabel', { month: monthWords(entry.month, locale), state: t(`lockState.${entry.state}`) })}>
                {`${monthWords(entry.month, locale)} · ${t(`lockState.${entry.state}`)}`}
              </Pill>
            ))
          ) : (
            <span className="fw-fac-muted">{t('band.reading')}</span>
          )}
          {model.history.readAt !== null ? <span className="fw-fac-muted">{t('band.readAt', { time: formatTime(model.history.readAt, { locale }) })}</span> : null}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-fac-inline">
          {wizard ? (
            <Button asChild size="sm">
              <Link href={accountingHref(model.prefix)}>
                <ArrowLeft size={13} aria-hidden /> {t('band.toHistory')}
              </Link>
            </Button>
          ) : (
            <Button size="sm" variant="primary" heldReason={model.can.export ? undefined : t('held.noExport')} asChild={model.can.export} aria-keyshortcuts="c">
              {model.can.export ? (
                <Link href={wizardHref(model.prefix, null)}>
                  <Plus size={14} aria-hidden /> {t('band.new')}
                </Link>
              ) : (
                <>
                  <Plus size={14} aria-hidden /> {t('band.new')}
                </>
              )}
            </Button>
          )}
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'lock', label: t('band.lockPeriod'), onSelect: () => actions?.onOpenLock?.(null) },
              { id: 'mapping', label: t('band.mapping'), disabled: true, description: t('band.mappingHeld') },
            ]}
          />
        </span>
      </div>

      <p className="fw-fac-muted">{t('layout.long')}</p>

      {model.notice && (
        <Banner
          tone="success"
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      {wizard ? <Wizard model={model} wizard={wizard} actions={actions} /> : <HistoryList model={model} actions={actions} />}

      {model.lockDialog && <LockDialog model={model.lockDialog} can={model.can} actions={actions?.dialogLock} onClose={() => actions?.onCloseLock?.()} />}

      {cancel && (
        <DialogFrame
          title={t('cancel.title', { month: monthWords(cancel.row.period.month, locale) })}
          held={cancelHold ? t(cancelHold.key) : null}
          go={() => actions?.onConfirmCancel?.()}
          goLabel={t('cancel.go')}
          tone="danger"
          onClose={() => actions?.onCloseCancel?.()}
          problem={cancel.problem ? { key: `finance-accounting:${cancel.problem.key}`, params: cancel.problem.params } : null}
        >
          <p className="fw-fac-muted">{t('cancel.body')}</p>
          <Field label={t('cancel.reason')} required>
            <Textarea autoFocus value={cancel.reason} maxLength={1000} rows={3} onChange={(event) => actions?.onCancelReason?.(event.target.value)} />
          </Field>
        </DialogFrame>
      )}

      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(`finance:${model.stepUp.problem}`) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </div>
  )
}
