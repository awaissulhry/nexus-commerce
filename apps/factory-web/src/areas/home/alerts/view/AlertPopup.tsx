'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlarmClock, CheckCheck, CircleCheck, ExternalLink, ListChecks, UserRound } from 'lucide-react'
import { Banner, Field, Modal, Timeline, type TimelineStep } from '@nexus/ui/components'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Select, Skeleton, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { sentenceOf } from '../../../_shared/rules/model'
import { SnoozeDialog } from '../../today/view/SnoozeDialog'
import { alertSentence, historyWords, kindWords, noteHeld, personAfter, popupIds, stateWords, verbHeld, type AlertRow, type AlertsViewModel } from '../model'
import type { AlertsActions } from './AlertsView'

const NOBODY = '__nobody__'
const tone = (severity: AlertRow['severity']): 'danger' | 'warning' | 'info' => (severity === 'CRITICAL' ? 'danger' : severity === 'WARNING' ? 'warning' : 'info')

/**
 * The alert's popup (design home.alerts popup `alert` "ORD-2026-0042 at risk": what, why — the rule and its values —, the
 * record, the history of this alert, similar open alerts; J/K · D acknowledge · Esc): DetailModal over the list (`?open=`).
 * Acknowledge · Assign · Snooze · Resolve with a note; each held with why (resolved, no right, offline). "Make a task" is
 * Later (ANA-042): not drawn.
 */
export function AlertPopup({ model, openId, rows, held, onGo, actions }: { model: AlertsViewModel; openId: string | null; rows: readonly AlertRow[]; held: string | null; onGo: (id: string | null) => void; actions?: AlertsActions }) {
  const t = useT('home-alerts')
  const r = useT('rules')
  const locale = useLocale()
  const open = model.open && model.open.id === openId ? model.open : null
  const detail = open?.detail.status === 'ready' ? open.detail.data : null
  const alert = detail?.alert ?? (openId ? (rows.find((row) => row.id === openId) ?? null) : null)
  const ids = popupIds(rows)
  const ackHeld = alert ? verbHeld(alert, 'ACKNOWLEDGE', held) : null
  // D acknowledges while the popup is open (not in a field).
  useEffect(() => {
    if (!alert) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'd' || event.metaKey || event.ctrlKey || event.altKey || model.dialog !== null) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (ackHeld) return
      event.preventDefault()
      actions?.onAcknowledge?.(alert.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [alert, ackHeld, actions, model.dialog])
  if (!openId) return null

  const words = (key: string | null) => (key ? t(key) : null)
  const history: TimelineStep[] = (detail?.history ?? []).map((entry, index) => ({
    key: `${entry.verb}:${index}`,
    label: historyWords(entry, t, locale),
    tone: entry.verb === 'RESOLVED' ? 'success' : entry.verb === 'RAISED' ? tone(alert?.severity ?? 'INFO') : 'neutral',
    detail: (
      <>
        {formatDateTime(entry.at, { locale })}
        {entry.note ? ` · ${entry.note}` : ''}
      </>
    ),
  }))
  const rule = open?.rule?.status === 'ready' ? open.rule.data : null
  return (
    <DetailModal
      open
      onClose={() => onGo(null)}
      title={alert ? t(`popup.kindTitle.${alert.ruleKind}`, { record: alert.record.label }).replace(`popup.kindTitle.${alert.ruleKind}`, alert.record.label) : t('popup.reading')}
      subtitle={
        alert ? (
          <a href={alert.recordHref} className="fw-alerts-record">
            {t('popup.openRecord', { record: alert.record.label })} <ExternalLink size={12} aria-hidden />
          </a>
        ) : undefined
      }
      meta={
        alert ? (
          <span className="fw-alerts-meta">
            <Tag tone={tone(alert.severity)}>{r(`severity.${alert.severity}`)}</Tag>
            <Tag tone={alert.state === 'RESOLVED' ? 'success' : alert.state === 'ACKNOWLEDGED' ? 'info' : 'neutral'}>{stateWords(alert, t, locale)}</Tag>
            {alert.assigned && (
              <Tag tone="neutral">
                <UserRound size={12} aria-hidden /> {t('popup.assignedTo', { name: personAfter(alert.assigned.to, t) })}
              </Tag>
            )}
            {alert.forMe && <Tag tone="info">{t('row.forMe')}</Tag>}
          </span>
        ) : undefined
      }
      nav={ids.includes(openId) ? { ids, current: openId, onGo: (id) => onGo(id), noun: t('popup.noun') } : undefined}
      loading={!detail && open?.detail.status !== 'error'}
      error={open?.detail.status === 'error' ? t(open.detail.problem) : undefined}
      onRetry={() => actions?.onRetryOpen?.()}
      footer={
        alert ? (
          <span className="fw-alerts-buttons">
            <Button variant="secondary" heldReason={words(verbHeld(alert, 'SNOOZE', held))} onClick={() => actions?.onDialog?.({ kind: 'snooze', id: alert.id })}>
              <AlarmClock size={14} aria-hidden /> {t('popup.snooze')}
            </Button>
            <Button variant="secondary" heldReason={words(verbHeld(alert, 'ASSIGN', held))} onClick={() => actions?.onDialog?.({ kind: 'assign', id: alert.id })}>
              <UserRound size={14} aria-hidden /> {t('popup.assign')}
            </Button>
            <Button variant="secondary" heldReason={words(ackHeld)} onClick={() => actions?.onAcknowledge?.(alert.id)} aria-keyshortcuts="d">
              <CheckCheck size={14} aria-hidden /> {t('popup.acknowledge')}
            </Button>
            <Button variant="primary" heldReason={words(verbHeld(alert, 'RESOLVE', held))} onClick={() => actions?.onDialog?.({ kind: 'resolve', id: alert.id })}>
              <CircleCheck size={14} aria-hidden /> {t('popup.resolve')}
            </Button>
          </span>
        ) : undefined
      }
    >
      {alert && (
        <div className="fw-alerts-popup">
          <section className="fw-alerts-popup-part" aria-labelledby="fw-alert-what">
            <h3 id="fw-alert-what" className="fw-alerts-h3">
              {t('popup.what')}
            </h3>
            <p className="fw-alerts-what">{alertSentence(alert, t, locale)}</p>
            <p className="fw-alerts-muted">
              {t(alert.occurrence > 1 ? 'popup.raisedAgain' : 'popup.raised', { date: formatDateTime(alert.raisedAt, { locale }), count: alert.occurrence })}
              {alert.placeLabel ? ` · ${alert.placeLabel}` : ''}
            </p>
            {alert.resolved && (
              <Banner tone="success" title={alert.resolved.by ? t('popup.resolvedBy', { who: personAfter(alert.resolved.by, t), date: formatDateTime(alert.resolved.at, { locale }) }) : t('popup.cleared', { date: formatDateTime(alert.resolved.at, { locale }) })}>
                {alert.resolved.note}
              </Banner>
            )}
          </section>

          <section className="fw-alerts-popup-part" aria-labelledby="fw-alert-why">
            <h3 id="fw-alert-why" className="fw-alerts-h3">
              {t('popup.why')}
            </h3>
            {open?.rule?.status === 'loading' ? (
              <Skeleton height={40} />
            ) : rule ? (
              <>
                <p className="fw-alerts-text">{sentenceOf(rule, locale)}</p>
                {!rule.enabled && <p className="fw-alerts-muted">{t('popup.ruleOff')}</p>}
                <span>
                  <Link
                    href={`${model.prefix}/home/alerts?rule=${encodeURIComponent(rule.id)}`}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                      event.preventDefault()
                      actions?.onRule?.(rule.id)
                    }}
                  >
                    <ListChecks size={13} aria-hidden /> {t('popup.openRule')}
                  </Link>
                </span>
              </>
            ) : (
              <p className="fw-alerts-text">{kindWords(alert.ruleKind, r)}</p>
            )}
          </section>

          <section className="fw-alerts-popup-part" aria-labelledby="fw-alert-history">
            <h3 id="fw-alert-history" className="fw-alerts-h3">
              {t('popup.history')}
            </h3>
            {detail ? <Timeline steps={history} label={t('popup.history')} now={model.now} /> : <Skeleton height={60} />}
          </section>

          <section className="fw-alerts-popup-part" aria-labelledby="fw-alert-similar">
            <h3 id="fw-alert-similar" className="fw-alerts-h3">
              {t('popup.similar')}
            </h3>
            {!detail ? (
              <Skeleton height={32} />
            ) : detail.similar.length === 0 ? (
              <p className="fw-alerts-muted">{t('popup.noSimilar')}</p>
            ) : (
              <ul className="fw-alerts-similar">
                {detail.similar.map((other) => (
                  <li key={other.id}>
                    <Tag tone={tone(other.severity)}>{r(`severity.${other.severity}`)}</Tag>{' '}
                    <Link
                      href={other.href}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                        event.preventDefault()
                        onGo(other.id)
                      }}
                    >
                      {other.record.label}
                    </Link>
                    <span className="fw-alerts-muted"> · {formatDateTime(other.raisedAt, { locale })}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </DetailModal>
  )
}

/** The popup's dialogs: Assign (who may be given it), Resolve (with a note), Snooze (the site's times, at most 30 days). */
export function AlertsDialogs({ model, rows, held, actions }: { model: AlertsViewModel; rows: readonly AlertRow[]; held: string | null; actions?: AlertsActions }) {
  const t = useT('home-alerts')
  const locale = useLocale()
  const dialog = model.dialog
  if (!dialog || dialog.kind === 'help') return null
  const alert = rows.find((row) => row.id === dialog.id) ?? (model.open?.detail.status === 'ready' && model.open.detail.data.alert.id === dialog.id ? model.open.detail.data.alert : null)
  if (!alert) return null
  const close = () => actions?.onDialog?.(null)
  if (dialog.kind === 'snooze')
    return <SnoozeDialog what={alertSentence(alert, t, locale)} now={model.now} untilChange={false} maxDays={30} held={held} onSnooze={(until) => (until ? actions?.onSnooze?.(alert.id, until) : undefined)} onClose={close} />
  if (dialog.kind === 'assign') return <AssignDialog alert={alert} people={dialog.people} busy={model.busy} held={held} onAssign={actions?.onAssign} onRetry={actions?.onRetryPeople} onClose={close} />
  return <ResolveDialog alert={alert} busy={model.busy} held={held} onResolve={actions?.onResolve} onClose={close} />
}

function AssignDialog({ alert, people, busy, held, onAssign, onRetry, onClose }: { alert: AlertRow; people: Extract<NonNullable<AlertsViewModel['dialog']>, { kind: 'assign' }>['people']; busy: boolean; held: string | null; onAssign?: (id: string, assigneeId: string | null) => Promise<boolean>; onRetry?: () => void; onClose: () => void }) {
  const t = useT('home-alerts')
  const locale = useLocale()
  const [to, setTo] = useState('')
  const list = people.status === 'ready' ? people.data : []
  const current = alert.assigned?.to.id ?? null
  const chosen = to === NOBODY ? null : to
  const heldText = held ?? (busy ? t('held.busy') : to === '' ? t('assign.pickFirst') : chosen === current ? t('assign.same') : null)
  const go = () => {
    if (heldText || !onAssign) return
    void onAssign(alert.id, chosen)
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('assign.title')}
      subtitle={alertSentence(alert, t, locale)}
      footer={
        <span className="fw-alerts-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={go}>
            <UserRound size={14} aria-hidden /> {t(chosen === null && to === NOBODY ? 'assign.takeBack' : 'assign.go')}
          </Button>
        </span>
      }
    >
      <div className="fw-alerts-dialog">
        <p className="fw-alerts-muted">{alert.assigned ? (alert.assigned.to.me ? t('assign.nowMine') : t('assign.now', { name: alert.assigned.to.name })) : t('assign.nobodyNow')}</p>
        <Field label={t('assign.to')} hint={t('assign.toHint')}>
          {people.status === 'loading' ? (
            <Skeleton height={32} />
          ) : people.status === 'error' ? (
            <Banner tone="danger" title={t(people.problem)} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('retry')}</Button> : undefined} />
          ) : (
            <Select value={to} onChange={(event) => setTo(event.target.value)}>
              <option value="">{t('assign.pick')}</option>
              {list.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.me ? t('assign.me', { name: person.name }) : person.name}
                </option>
              ))}
              {current !== null && <option value={NOBODY}>{t('assign.nobody')}</option>}
            </Select>
          )}
        </Field>
        {people.status === 'ready' && list.length === 0 && <p className="fw-alerts-muted">{t('assign.noPeople')}</p>}
        <p className="fw-alerts-muted">{t('assign.told')}</p>
      </div>
    </Modal>
  )
}

function ResolveDialog({ alert, busy, held, onResolve, onClose }: { alert: AlertRow; busy: boolean; held: string | null; onResolve?: (id: string, note: string) => Promise<boolean>; onClose: () => void }) {
  const t = useT('home-alerts')
  const locale = useLocale()
  const [note, setNote] = useState('')
  const problem = noteHeld(note)
  const heldText = held ?? (busy ? t('held.busy') : problem ? t(problem) : null)
  const go = () => {
    if (heldText || !onResolve) return
    void onResolve(alert.id, note)
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('resolve.title')}
      subtitle={alertSentence(alert, t, locale)}
      footer={
        <span className="fw-alerts-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={go}>
            <CircleCheck size={14} aria-hidden /> {t('resolve.go')}
          </Button>
        </span>
      }
    >
      <div className="fw-alerts-dialog">
        <Field label={t('resolve.note')} hint={t('resolve.noteHint')} required error={note.trim().length > 1000 ? t('resolve.noteLong') : undefined}>
          <Textarea
            rows={4}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                go()
              }
            }}
          />
        </Field>
        <p className="fw-alerts-muted">{t('resolve.final')}</p>
      </div>
    </Modal>
  )
}
