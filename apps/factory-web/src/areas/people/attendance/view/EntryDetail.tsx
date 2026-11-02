'use client'

import Link from 'next/link'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { DetailModal, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../_shared/model'
import { blockingLimit, checkWords, dayLong, ENTRY_TONE, hoursWords, LIMIT_LAW, toneOf } from '../model'
import type { AttendanceActions, EntryState } from '../view-model'
import { Footer, Form, Problem } from './DayDialogs'
import { said, useAttendanceWords } from './parts'

const REASON_MIN = 3

/**
 * One overtime entry (design sec:overtime + pop:reject-ot): the person, the hours, the class, the planned request and what went
 * beyond it, and each limit in words with its law. Overtime is decided on an approved day; Reject asks a reason; a limit that
 * blocks stands only with a reason on the audit row (the hours were worked: B-W2b-42, accepted by the lead).
 */
export function EntryDetail({ state, ids, prefix, actions, canPeople }: { state: EntryState; ids: readonly string[]; prefix: string; actions?: AttendanceActions | undefined; canPeople: boolean }) {
  const t = useAttendanceWords()
  const ds = useDsWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const value = state.loaded.status === 'ready' ? state.loaded.value : null
  const held = value ? (value.holds[0] ? t(`hold.entry.${value.holds[0].code}`) : !value.actions.approve ? t('held.noReview') : state.busy ? t('held.working') : null) : t('held.notRead')
  const problem = state.loaded.status === 'error' ? t(state.loaded.problem) : state.loaded.status === 'notFound' ? t('problem.notFound') : state.loaded.status === 'forbidden' ? t('problem.forbidden') : undefined
  const name = value ? (canPeople ? <Link href={`${prefix}/people/employees/${encodeURIComponent(value.person.employeeId)}?tab=attendance`}>{value.person.name}</Link> : value.person.name) : t('entry.title')
  return (
    <>
      <DetailModal
        open
        onClose={() => actions?.onOpenEntry(null)}
        title={name}
        subtitle={value ? `${dayLong(value.date, locale)} · ${t(`class.${value.class}`)}` : undefined}
        meta={value ? <Pill tone={ENTRY_TONE[value.status]} dot>{t(`entryStatus.${value.status}`)}</Pill> : undefined}
        actions={
          value ? (
            <span className="fw-pp-row">
              {value.actions.reopen && (
                <Button size="sm" onClick={() => actions?.onEntryReopen()}>
                  {t('entry.verb.reopen')}
                </Button>
              )}
              {value.status === 'PENDING' && (
                <Button size="sm" onClick={() => actions?.onEntryReject()} heldReason={value.actions.reject ? null : held}>
                  {t('entry.verb.reject')}
                </Button>
              )}
              {value.status === 'PENDING' && (
                <Button size="sm" variant="primary" onClick={() => actions?.onEntryApprove()} heldReason={held}>
                  {t('entry.verb.approve')}
                </Button>
              )}
            </span>
          ) : undefined
        }
        loading={state.loaded.status === 'loading'}
        error={problem}
        {...(actions ? { onRetry: actions.onRetryEntry } : {})}
        nav={{ ids, current: state.id, onGo: (id) => actions?.onOpenEntry(id), noun: t('entry.noun') }}
      >
        {value && (
          <div className="fw-at-day">
            {state.problem && <Banner tone="danger" title={said(t, state.problem)} />}
            <KeyValue
              columns={3}
              dense
              phoneColumns={2}
              labelCase="sentence"
              items={[
                { label: t('entry.hours'), value: hoursWords(value.minutes, locale) },
                { label: t('col.class'), value: t(`class.${value.class}`) },
                {
                  label: t('col.request'),
                  value: value.request ? <Link href={`${prefix}/people/shifts?open=${encodeURIComponent(value.request.id)}`}>{t('entry.request', { hours: hoursWords(value.request.minutes, locale) })}</Link> : t('overtime.notPlanned'),
                  ...(value.beyondRequestMinutes ? { hint: t('entry.beyond', { hours: hoursWords(value.beyondRequestMinutes, locale) }) } : {}),
                },
              ]}
            />
            {value.day && (
              <p className="fw-pp-hint">
                {t('entry.day', { status: t(`status.${value.day.status}`) })}{' '}
                <Link href={`?open=${encodeURIComponent(value.day.id)}`} scroll={false}>
                  {t('entry.openDay')}
                </Link>
              </p>
            )}
            <section className="fw-pp-stack tight" aria-label={t('col.limits')}>
              <h3 className="fw-at-sub">{t('col.limits')}</h3>
              <ul className="fw-at-anomalies">
                {value.checks.map((check) => (
                  <li key={check.rule}>
                    <span className="fw-pp-row">
                      <Tag tone={toneOf(check)}>{t(`limitState.${check.state}`)}</Tag>
                      <span>{said(t, checkWords(check, locale))}</span>
                    </span>
                    <LawRef law={check.law} plain={t(LIMIT_LAW[check.rule])} labels={ds.lawRef} />
                  </li>
                ))}
              </ul>
              {blockingLimit(value.checks) && <p className="fw-pp-hint">{t('entry.blocks')}</p>}
            </section>
            {value.decision.approvedAt && <p className="fw-pp-hint">{t('entry.approvedBy', { who: value.decision.approvedBy ?? '—', at: formatDateTime(value.decision.approvedAt, place) })}</p>}
            {value.decision.rejectedAt && <p className="fw-pp-hint">{t('entry.rejectedBy', { who: value.decision.rejectedBy ?? '—', at: formatDateTime(value.decision.rejectedAt, place), reason: value.decision.rejectReason ?? '—' })}</p>}
          </div>
        )}
      </DetailModal>
      {state.dialog && <EntryDialog state={state} actions={actions} />}
    </>
  )
}

function EntryDialog({ state, actions }: { state: EntryState; actions?: AttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const dialog = state.dialog!
  const held = dialog.reason.trim().length < REASON_MIN ? t('held.reason') : null
  const close = () => actions?.onEntryClose()
  const save = () => actions?.onEntrySave()
  return (
    <Modal open onClose={close} title={t(`entry.${dialog.kind}.title`)} size="sm" className="fw-at-over" footer={<Footer t={t} held={held} busy={dialog.busy} danger={dialog.kind === 'reject'} label={t(`entry.${dialog.kind}.submit`)} onCancel={close} onSave={save} />}>
      <Form held={held} onSave={save}>
        <Problem t={t} words={dialog.problem} />
        {dialog.kind === 'override' && (
          <Banner tone="warning" title={t('entry.override.body')}>
            {dialog.rules.map((rule) => t(`limit.${rule}.name`)).join(' · ')}
          </Banner>
        )}
        <Field label={t(dialog.kind === 'override' ? 'entry.override.reason' : 'field.reason')} required>
          <Textarea value={dialog.reason} maxLength={500} rows={3} onChange={(event) => actions?.onEntryReason(event.target.value)} />
        </Field>
      </Form>
    </Modal>
  )
}
