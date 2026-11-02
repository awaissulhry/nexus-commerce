'use client'

import Link from 'next/link'
import { ExternalLink, FileQuestion } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { CheckList } from '@nexus/ui/patterns/checklist/index'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { TIME_ZONE } from '../../_shared/model'
import type { MonthPanel } from '../api'
import { closeHeld, dueTone, monthName, monthWords, movedMonth, showMeOf } from '../model'
import type { AttendanceActions, AttendanceModel } from '../view-model'
import { said, useAttendanceWords } from './parts'

/**
 * Month close (design people.attendance sec:close; D.L. 112/2008 art. 39): the checklist with each item's Show me, the LUL
 * deadline, "Close October" held with the count of open items; after the close the DocumentSeal of the calendar and Go to
 * Payroll export. What the labour consultant must still confirm of this generic calendar is said here, plainly: it is not
 * the consultant's calendar yet (GATE-PAYROLL). The close is the whole company's: a person who does not reach every site is
 * told so.
 */
export function ClosePanel({ model, actions }: { model: AttendanceModel; actions?: AttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const { panel } = model
  if (panel.status === 'hidden') return null
  return (
    <section id="fw-at-close" className="fw-at-section" aria-label={t('close.title')}>
      <h2 className="fw-at-title">{t('close.title')}</h2>
      {panel.status === 'loading' ? (
        <Card padded aria-busy="true">
          <div className="fw-pp-stack tight">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      ) : panel.status === 'noReach' ? (
        <Card padded>
          <p className="fw-pp-hint">{t('close.noReach')}</p>
        </Card>
      ) : panel.status === 'error' ? (
        <Card padded>
          <EmptyState
            icon={<FileQuestion size={22} aria-hidden />}
            title={t('close.failed')}
            description={t(panel.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetryPanel()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : (
        <Panel model={model} value={panel.value} actions={actions} />
      )}
    </section>
  )
}

function Panel({ model, value, actions }: { model: AttendanceModel; value: MonthPanel; actions?: AttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const ds = useDsWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const month = monthWords(value.month, locale)
  const held = closeHeld(value, model.can)
  const closed = value.state === 'CLOSED'
  const payroll = OFFICE_PAGES.has('/people/payroll')
  const previous = movedMonth(value.month, -1)
  const due = t(value.due.daysLeft < 0 ? 'close.overdue' : 'close.due', { date: formatDate(`${value.due.by}T12:00:00Z`, place), count: Math.abs(value.due.daysLeft) })

  const checks = value.checklist.map((entry) => {
    const target = showMeOf(entry.item)
    return {
      id: entry.item,
      state: entry.done ? ('pass' as const) : ('fail' as const),
      name: t(`close.item.${entry.item}`),
      ...(entry.done ? {} : { detail: t('close.itemLeft', { count: entry.left }) }),
      fix: 'page' in target ? { label: t('close.showMe'), href: `${model.prefix}${target.page}` } : { label: t('close.showMe'), onClick: () => actions?.onShowItem(entry.item) },
    }
  })

  return (
    <Card padded>
      <div className="fw-at-close">
        <div className="fw-pp-stack tight">
          <div className="fw-pp-head">
            <span className="fw-pp-row">
              <b>{month}</b>
              <Pill tone={closed ? 'success' : 'info'} dot>
                {t(`monthState.${value.state}`)}
              </Pill>
            </span>
            <Tag tone={dueTone(value.due)}>{due}</Tag>
          </div>
          {!value.monthOver && (
            <p className="fw-pp-hint fw-pp-row">
              {t('hold.close.MONTH_NOT_OVER', { month })}
              <Button size="sm" variant="quiet" onClick={() => actions?.onMonth(previous)}>
                {t('close.goTo', { month: monthWords(previous, locale) })}
              </Button>
            </p>
          )}
          {!closed && <CheckList label={t('close.checklist', { month })} checks={checks} labels={ds.checkList} density="compact" />}
          {value.notes.map((entry) => (
            <Banner key={entry.note} tone="info" title={t(`close.note.${entry.note}`)} />
          ))}
          {value.sites.some((site) => !site.gateOpen) && <p className="fw-pp-hint">{t('close.sitesOff', { sites: value.sites.filter((site) => !site.gateOpen).map((site) => site.code).join(', ') })}</p>}
          {!closed && (
            <span className="fw-pp-row">
              <Button size="sm" variant="primary" heldReason={held ? said(t, held) : null} onClick={() => actions?.onCloseMonth()}>
                {t('close.verb', { month: monthName(value.month, locale) })}
              </Button>
              {held && <span className="fw-pp-hint">{said(t, held)}</span>}
            </span>
          )}
        </div>

        <div className="fw-pp-stack tight">
          {closed && value.seal?.sealed && value.seal.sha256 ? (
            <DocumentSeal title={t('close.sealTitle', { month })} version="v1" sha256={value.seal.sha256} sealedAt={formatDateTime(value.seal.closedAt, place)} timestampSource={t('close.sealClock')} {...(value.seal.closedBy ? { sealedBy: value.seal.closedBy } : {})} labels={ds.documentSeal} />
          ) : closed ? (
            <Banner tone="warning" title={t('close.unsealed')}>
              {value.actions.seal && (
                <Button size="sm" onClick={() => actions?.onSeal()} heldReason={model.panelBusy ? t('held.working') : null}>
                  {t('close.seal')}
                </Button>
              )}
            </Banner>
          ) : null}
          {closed && (
            <span className="fw-pp-row">
              {value.actions.openLul && value.closeId && (
                <Button size="sm" asChild>
                  <Link href={`${model.prefix}/people/attendance/lul?close=${encodeURIComponent(value.closeId)}`} target="_blank">
                    {t('close.openLul')} <ExternalLink size={13} aria-hidden />
                  </Link>
                </Button>
              )}
              {payroll ? (
                <Button size="sm" variant="secondary" asChild>
                  <Link href={`${model.prefix}/people/payroll`}>{t('close.payroll')}</Link>
                </Button>
              ) : (
                <Button size="sm" variant="secondary" heldReason={t('close.payrollLater')}>
                  {t('close.payroll')}
                </Button>
              )}
              {value.corrections > 0 && <Tag tone="warning">{t('close.corrections', { count: value.corrections })}</Tag>}
            </span>
          )}
          <div className="fw-at-confirm">
            <b>{t('close.toConfirmTitle')}</b>
            <p className="fw-pp-hint">{t('close.toConfirmNote')}</p>
            <ol className="fw-at-confirm-list">
              {value.toConfirm.map((_, index) => (
                <li key={index}>{t(`toConfirm.${index}`)}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </Card>
  )
}
