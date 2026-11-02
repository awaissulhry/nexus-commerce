'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Plus, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { isListKey, type ListKey } from '../../../../list-frame/model'
import { KeysModal, LiveLine } from '../../_shared/parts'
import { isLatest, monthName, primaryOf, recordHref, sendRowHeld, wizardHref } from '../model'
import type { PayrollActions, PayrollModel } from '../view-model'
import { ColumnsModal, ConfirmModal, ExportModals, ShowModal } from './dialogs'
import { ExportsList } from './ExportsList'
import { MonthPill, PayrollMessages, PayrollNote, PayrollNotice, usePayrollWords, useSaid } from './parts'
import { Wizard } from './Wizard'

/**
 * SCR-159 — People › Skills & pay › Payroll export (design people.payroll, archetype wizard): the band (the month's pill, Code
 * mapping, the month's main action, ⋯), what this page shows said first, and either the five steps or the Exports. Nexus does not
 * run payroll: it makes a file for the labour consultant. The company's whole month, so the top bar's site narrows nothing.
 */
export function PayrollView({ model, actions }: { model: PayrollModel; actions?: PayrollActions }) {
  return (
    <PayrollMessages>
      <Payroll model={model} {...(actions ? { actions } : {})} />
    </PayrollMessages>
  )
}

function Payroll({ model, actions }: { model: PayrollModel; actions?: PayrollActions }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const [helpOwn, setHelp] = useState(false)
  const help = model.help || helpOwn
  const month = model.month.status === 'ready' ? model.month.value : null
  const gateClosed = model.month.status === 'error' && model.month.problem === 'problem.gate'
  const primary = primaryOf(month)
  const latest = month?.latest ?? null
  const startHeld = !model.can.manage ? t('held.noManage') : gateClosed ? t('problem.gate') : model.month.status === 'error' ? t(model.month.problem) : model.month.status === 'loading' ? t('held.notRead') : null

  const start = () => {
    if (!startHeld) actions?.onStart?.()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isListKey(event, event.target as HTMLElement | null) || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (event.key === 'c' && !model.wizard) start()
      else if (event.key === '?' && model.wizard) setHelp(true)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.can.view) {
    return (
      <div className="fw-pp fw-pay">
        <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const sendHeld = latest ? sendRowHeld(latest, model.can) : { key: 'held.noExportYet' }
  const more = [
    { id: 'past', label: t('band.past'), onSelect: () => actions?.onLeave?.() },
    { id: 'send', label: t('band.send'), onSelect: () => latest && actions?.onOpenSend?.(latest), ...(sendHeld ? { disabled: true, description: said(sendHeld) } : {}) },
    { id: 'format', label: t('band.format'), href: wizardHref(model.prefix, month?.month ?? model.address.month, 'send', model.address.layoutId) },
    { id: 'keys', label: t('band.keys'), onSelect: () => setHelp(true) },
  ]
  const keys: ListKey[] = model.wizard
    ? [
        { keys: ['⌘', 'Enter'], does: t('keys.continue') },
        { keys: ['Alt', '←'], does: t('keys.previous') },
        { keys: ['Alt', '→'], does: t('keys.next') },
      ]
    : [{ keys: ['c'], does: t('keys.start') }]

  return (
    <div className="fw-pp fw-pay">
      <div className="fw-pp-band">
        <div className="fw-pp-head">
          <span className="fw-pay-status">
            {month ? <MonthPill month={month} /> : model.month.status === 'loading' ? <Skeleton width={200} height={22} /> : null}
            <LiveLine asOf={model.asOf} live={model.live} />
          </span>
          <span className="fw-pp-actions">
            <Button size="sm" variant="secondary" onClick={() => actions?.onStep?.('mapping')} heldReason={month ? null : startHeld}>
              {t('band.mapping')}
            </Button>
            {!model.wizard && primary === 'start' && (
              <Button size="sm" variant="primary" onClick={start} heldReason={startHeld}>
                <Plus size={14} aria-hidden /> {month ? t('band.start', { month: monthName(month.month, locale) }) : t('band.startPlain')}
              </Button>
            )}
            {!model.wizard && primary === 'correct' && latest && (
              <Button size="sm" variant="primary" onClick={() => actions?.onOpenCorrect?.(latest)} heldReason={isLatest(latest) && model.can.manage ? null : t('held.noManage')}>
                {t('band.correct')}
              </Button>
            )}
            {!model.wizard && primary === 'open' && latest && (
              <Button asChild size="sm" variant="primary">
                <Link href={recordHref(model.prefix, latest.id)}>{t('band.open', { version: latest.revision })}</Link>
              </Button>
            )}
            <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('band.more') }} items={more} />
          </span>
        </div>
        <PayrollNote />
      </div>
      <PayrollNotice notice={model.notice} {...(actions?.onDismissNotice ? { onDismiss: actions.onDismissNotice } : {})} />
      {gateClosed && (
        <Banner tone="warning" title={t('gate.title')}>
          {t('gate.body')}
        </Banner>
      )}
      {model.month.status === 'error' && !gateClosed && !model.wizard && (
        <Banner
          tone="danger"
          title={t('month.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetryMonth?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.month.problem)}
        </Banner>
      )}
      {model.wizard ? (
        gateClosed ? (
          <Card padded>
            <EmptyState title={t('gate.wizardTitle')} description={t('gate.wizardBody')} action={<Button size="sm" onClick={() => actions?.onLeave?.()}>{t('wizard.leave')}</Button>} />
          </Card>
        ) : (
          <Wizard model={model} wizard={model.wizard} {...(actions ? { actions } : {})} />
        )
      ) : (
        <ExportsList model={model} {...(actions ? { actions } : {})} onHelp={() => setHelp(true)} startHeld={startHeld} onStart={start} />
      )}
      {model.show && <ShowModal model={model} dialog={model.show} {...(actions ? { actions } : {})} />}
      {model.columns && <ColumnsModal model={model} dialog={model.columns} {...(actions ? { actions } : {})} />}
      {model.confirm && <ConfirmModal model={model} dialog={model.confirm} {...(actions ? { actions } : {})} />}
      <ExportModals prefix={model.prefix} can={model.can} dialogs={model.dialogs} {...(actions ? { actions } : {})} />
      {help && (
        <KeysModal
          own={keys}
          withSelection={!model.wizard}
          onClose={() => {
            setHelp(false)
          }}
        />
      )}
    </div>
  )
}
