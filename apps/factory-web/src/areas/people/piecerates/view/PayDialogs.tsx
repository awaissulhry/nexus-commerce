'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Banner, Field, KeyValue, Stepper, SummaryTable } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { ActionConfirm, DetailModal, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { isListKey } from '../../../../list-frame/model'
import { TIME_ZONE } from '../../_shared/model'
import { OPEN_REASONS, type OpenReason } from '../api'
import { actionHeld, checkRows, dayText, hasRight, minutesText, moneyText, monthText, PERIOD_STEPS, PERIOD_TONE, rateText, reasonHeld } from '../model'
import type { PieceActions, PieceDialog, PieceModel } from '../view-model'
import { said, usePieceWords } from './parts'

/**
 * Every pop-up about pay: a pay period's record (its steps, what stands in the way, per-line figures that name nobody, its
 * statements as numbers), the Worker statement (J / K, A; each opening recorded), Lock, Back to preview, Resolve held scan,
 * an entry's record and Correct, Do not pay.
 */
export function PayDialogs({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const { dialog } = model
  return (
    <>
      {model.period && <PeriodRecord model={model} actions={actions} />}
      {model.statement && <StatementRecord model={model} actions={actions} />}
      {model.heldRecord && <HeldRecordModal model={model} actions={actions} />}
      {model.entry && <EntryModal model={model} actions={actions} />}
      {dialog?.kind === 'lock' && <LockDialog model={model} dialog={dialog} actions={actions} />}
      {(dialog?.kind === 'backToPreview' || dialog?.kind === 'notPaid') && <ReasonDialog dialog={dialog} actions={actions} />}
      {dialog?.kind === 'correct' && <CorrectDialog dialog={dialog} actions={actions} />}
      {dialog?.kind === 'leadOpen' && <LeadOpenDialog dialog={dialog} actions={actions} />}
    </>
  )
}

function PeriodRecord({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const period = model.period!
  const read = period.detail
  const detail = read.status === 'ready' ? read.value : null
  const row = detail?.period
  const statements = period.statements ?? []
  const held = (action: keyof NonNullable<typeof detail>['actions']) => (detail ? said(t, actionHeld(detail.actions[action])) || null : null)
  const canRun = detail?.canManage ?? false
  const right = hasRight(model.can)
  return (
    <DetailModal
      open
      onClose={() => actions?.onOpenPeriod(null)}
      title={row ? monthText(row.month, locale) : t('record.loading')}
      loading={read.status === 'loading'}
      error={read.status === 'failed' ? said(t, read.problem) : undefined}
      onRetry={() => actions?.onRetry()}
      meta={
        row ? (
          <Pill tone={PERIOD_TONE[row.status]} dot>
            {t(`period.${row.status}`)}
          </Pill>
        ) : undefined
      }
      actions={
        canRun && row ? (
          <span className="fw-pp-actions">
            {(row.status === 'OPEN' || row.status === 'PREVIEW') && (
              <Button size="sm" heldReason={period.busy ? t('common.working') : held('run')} onClick={() => actions?.onPeriodStep('run')}>
                {t('periods.run')}
              </Button>
            )}
            {row.status === 'PREVIEW' && (
              <Button size="sm" variant="primary" heldReason={period.busy ? t('common.working') : held('startReview')} onClick={() => actions?.onPeriodStep('review')}>
                {t('periods.startReview')}
              </Button>
            )}
            {row.status === 'PREVIEW' && (
              <Button size="sm" variant="quiet" heldReason={held('reopen')} onClick={() => actions?.onPeriodStep('reopen')}>
                {t('periods.reopen')}
              </Button>
            )}
            {row.status === 'REVIEW' && (
              <Button size="sm" variant="quiet" heldReason={held('back')} onClick={() => actions?.onBack()}>
                {t('periods.back')}
              </Button>
            )}
            {row.status === 'REVIEW' && (
              <Button size="sm" variant="primary" heldReason={held('lock')} onClick={() => actions?.onLock()}>
                {t('periods.lock')}
              </Button>
            )}
          </span>
        ) : undefined
      }
    >
      {detail && row && (
        <div className="fw-pr8-stack">
          {period.problem && <Banner tone="danger" title={said(t, period.problem)} />}
          <Stepper steps={PERIOD_STEPS.map((step) => ({ key: step, label: t(`period.${step}`) }))} current={PERIOD_STEPS.indexOf(row.status)} />
          {checkRows(detail).length > 0 && (
            <ul className="fw-pr8-list" aria-label={t('periods.checks')}>
              {checkRows(detail).map((check) => (
                <li key={check.code}>
                  {check.blocking ? <b>{said(t, check.words)}</b> : said(t, check.words)}
                </li>
              ))}
            </ul>
          )}
          {row.status === 'LOCKED' && <Banner tone="info" title={t('periods.lockedBody')} />}
          <h3 className="fw-pr8-h3">{t('periods.lines')}</h3>
          {detail.lines.length === 0 ? (
            <p className="fw-pr8-hint">{t('periods.noLines')}</p>
          ) : (
            <SummaryTable
              label={t('periods.lines')}
              stackOnPhone
              columns={[t('record.line'), t('periods.people'), t('ledger.pieces'), t('periods.earnings'), t('periods.makeUp')]}
              align={['left', 'right', 'right', 'right', 'right']}
              rows={detail.lines.map((line) => ({
                id: line.line?.id ?? 'none',
                cells: [line.line ? `${line.line.code} · ${line.line.name}` : t('record.anyLine'), line.tooFew ? t('periods.tooFewShort') : (line.people ?? '—'), line.pieces ?? '—', moneyText(line.earnings, row.currency, locale) ?? '—', moneyText(line.makeUp, row.currency, locale) ?? '—'],
              }))}
            />
          )}
          <h3 className="fw-pr8-h3">{t('periods.statements')}</h3>
          <p className="fw-pr8-hint">{t('periods.statementsHint')}</p>
          {statements.length === 0 ? (
            <p className="fw-pr8-hint">{t('periods.noStatements')}</p>
          ) : (
            <SummaryTable
              label={t('periods.statements')}
              density="roomy"
              stackOnPhone
              columns={[t('statement.number'), t('periods.status'), t('statement.review'), '']}
              rows={statements.map((statement, index) => ({
                id: statement.id,
                cells: [
                  t('statement.nOfM', { n: index + 1, of: statements.length }),
                  `${t(`statementStatus.${statement.status}`)}${statement.stale ? ` · ${t('statement.stale')}` : ''}`,
                  statement.leadReviewed ? t('statement.leadReviewed') : '—',
                  right ? (
                    <Button key="open" size="sm" onClick={() => actions?.onOpenStatement(statement.id)}>
                      {t('statement.open')}
                    </Button>
                  ) : (
                    <Button key="open" size="sm" heldReason={model.can.review ? null : t('statement.heldRight')} onClick={() => actions?.onLeadOpen(statement.id)}>
                      {t('statement.openLead')}
                    </Button>
                  ),
                ],
              }))}
            />
          )}
        </div>
      )}
    </DetailModal>
  )
}

function StatementRecord({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const ds = useDsWords()
  const state = model.statement!
  const read = state.read
  const value = read.status === 'ready' ? read.value : null
  const list = model.period?.statements ?? []
  // A approves. J / K are the DS DetailModal's own (its `nav`): each step opens one statement, and that opening is recorded.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (!isListKey(event, target ? ({ tagName: target.tagName, isContentEditable: target.isContentEditable } as HTMLElement) : null) || model.dialog) return
      if (event.key.toLowerCase() !== 'a' || !value?.canApprove) return
      actions?.onApprove()
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const money = (minor: number | null | undefined) => (value ? (moneyText(minor, value.currency, locale) ?? t('statement.noPay')) : '')
  const rate = (figure: string | null | undefined) => (value ? (rateText(figure, value.currency, locale) ?? '—') : '')
  const page = list.findIndex((row) => row.id === value?.id)
  return (
    <DetailModal
      open
      onClose={() => actions?.onOpenStatement(null)}
      title={value ? t('statement.title', { name: value.person.name }) : t('statement.opening')}
      {...(value ? { subtitle: monthText(value.month, locale) } : {})}
      loading={read.status === 'loading'}
      error={read.status === 'failed' ? said(t, read.problem) : undefined}
      onRetry={() => actions?.onRetry()}
      {...(list.length > 1 && page >= 0 && value?.openedAs === 'HR'
        ? { nav: { ids: list.map((row) => row.id), current: list[page]!.id, noun: t('statement.noun'), onGo: (id: string) => actions?.onOpenStatement(id) } }
        : {})}
      actions={
        value ? (
          <span className="fw-pp-actions">
            {value.openedAs === 'HR' && (
              <a className="fw-pp-link" href={`${model.prefix}/people/piecerates/statement/${encodeURIComponent(value.id)}`} target="_blank" rel="noreferrer">
                {t('statement.pdf')}
              </a>
            )}
            {value.openedAs === 'HR' && (
              <Link className="fw-pp-link" href={`${model.prefix}/people/employees/${value.person.employeeId}?tab=pay`} target="_blank">
                {t('statement.employee')}
              </Link>
            )}
            {value.openedAs === 'LEAD' && value.status === 'DRAFT' && !value.leadReview && (
              <Button size="sm" variant="primary" heldReason={state.busy ? t('common.working') : value.periodStatus === 'REVIEW' ? null : t('statement.heldReview')} onClick={() => actions?.onLeadReview()}>
                {t('statement.leadLooksRight')}
              </Button>
            )}
            {value.status === 'DRAFT' && value.openedAs === 'HR' && (
              <Button size="sm" variant="primary" heldReason={state.busy ? t('common.working') : value.canApprove ? null : t(value.periodStatus === 'REVIEW' ? 'statement.heldOwn' : 'statement.heldReview')} onClick={() => actions?.onApprove()}>
                {t('statement.approve')}
              </Button>
            )}
          </span>
        ) : undefined
      }
    >
      {value && (
        <div className="fw-pr8-stack">
          <PrivacyNote level="individual" variant="pill" text={t('statement.privacy')} whoMore={t('statement.whoMore')} labels={ds.privacyNote} />
          {state.problem && <Banner tone="danger" title={said(t, state.problem)} />}
          {value.stale && <Banner tone="warning" title={t('statement.staleBody')} />}
          {value.leadReview && <Banner tone="info" title={t('statement.leadReviewed')}>{value.leadReview.byName ?? ''}</Banner>}
          {value.status === 'SUPERSEDED' && <Banner tone="info" title={t('statement.superseded')} />}
          <KeyValue
            columns={3}
            items={[
              { label: t('statement.earnings'), value: money(value.earningsAmount) },
              { label: t('statement.makeUp'), value: money(value.makeUpAmount) },
              { label: t('periods.status'), value: t(`statementStatus.${value.status}`) },
              ...(value.attendance ? [{ label: t('statement.ordinary'), value: minutesText(value.attendance.ordinaryMinutes, locale) ?? '—' }, { label: t('statement.overtime'), value: minutesText(value.attendance.approvedOvertimeMinutes, locale) ?? '—' }] : []),
              { label: t('statement.held'), value: t('statement.heldValue', value.held) },
            ]}
          />
          <h3 className="fw-pr8-h3">{t('statement.pieces')}</h3>
          {value.lines.length === 0 ? (
            <p className="fw-pr8-hint">{t('statement.noPieces')}</p>
          ) : (
            <SummaryTable
              label={t('statement.pieces')}
              stackOnPhone
              columns={[t('rates.operation'), t('ledger.pieces'), t('statement.minutes'), t('ledger.rate'), t('ledger.amount')]}
              widths={['44%']}
              align={['left', 'right', 'right', 'right', 'right']}
              rows={value.lines.map((line, index) => ({ id: `${line.operationCode}-${index}`, cells: [`${line.operationCode} · ${line.operationName}${line.sharePct ? ` (${line.sharePct}%)` : ''}`, line.pieces, minutesText(line.minutes, locale) ?? '—', rate(line.rate), money(line.amount)] }))}
            />
          )}
          {value.time.length > 0 && (
            <>
              <h3 className="fw-pr8-h3">{t('statement.time')}</h3>
              <SummaryTable label={t('statement.time')} stackOnPhone columns={[t('statement.code'), t('statement.minutes'), t('ledger.rate'), t('ledger.amount')]} align={['left', 'right', 'right', 'right']} rows={value.time.map((line) => ({ id: line.code, cells: [line.code, minutesText(line.minutes, locale) ?? '—', rate(line.rate), money(line.amount)] }))} />
            </>
          )}
          {value.corrections.length > 0 && (
            <>
              <h3 className="fw-pr8-h3">{t('statement.corrections')}</h3>
              <SummaryTable label={t('statement.corrections')} stackOnPhone columns={[t('ledger.source'), t('ledger.corrects'), t('ledger.amount')]} align={['left', 'left', 'right']} rows={value.corrections.map((line, index) => ({ id: String(index), cells: [t(`kind.ledger.${line.kind}`), line.month ? monthText(line.month, locale) : '—', money(line.amount)] }))} />
            </>
          )}
          {value.makeUp && <p className="fw-pr8-hint">{t('statement.makeUpLine', { guaranteed: money(value.makeUp.guaranteed), earned: money(value.makeUp.earned), amount: money(value.makeUp.amount) })}</p>}
          <h3 className="fw-pr8-h3">{t('statement.disputes')}</h3>
          {value.disputes.length === 0 ? (
            <p className="fw-pr8-hint">{t('statement.noDisputes')}</p>
          ) : (
            <SummaryTable
              label={t('statement.disputes')}
              columns={[t('ledger.date'), t('periods.status'), '']}
              rows={value.disputes.map((row) => {
                return {
                  id: row.id,
                  cells: [
                    dayText(row.workDate, locale),
                    t(`dispute.${row.status === 'OPEN' ? 'OPEN' : 'ANSWERED'}`),
                    <Link key="resolve" className="fw-pp-link" href={`${model.prefix}/production/labour?open=DISPUTE:${encodeURIComponent(row.id)}`} target="_blank">
                      {t('statement.resolve')}
                    </Link>,
                  ],
                }
              })}
            />
          )}
        </div>
      )}
    </DetailModal>
  )
}

function HeldRecordModal({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const state = model.heldRecord!
  const value = state.read.status === 'ready' ? state.read.value : null
  const open = value?.status === 'OPEN'
  const manage = model.can.managePay
  return (
    <Modal
      open
      size="lg"
      onClose={() => actions?.onOpenHeld(null)}
      title={t('resolve.title')}
      footer={
        value && open && manage ? (
          <>
            <Button variant="quiet" onClick={() => actions?.onOpenHeld(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="secondary" onClick={() => actions?.onNotPaid()}>
              {t('resolve.notPay')}
            </Button>
            <Button variant="primary" heldReason={state.busy ? t('common.working') : value.voided ? t('refusal.SCAN_VOIDED') : value.canCount ? null : t('resolve.heldCount')} onClick={() => actions?.onCountHeld()}>
              {t('resolve.count')}
            </Button>
          </>
        ) : undefined
      }
    >
      {state.read.status === 'loading' && <p className="fw-pr8-hint">{t('common.reading')}</p>}
      {state.read.status === 'failed' && <Banner tone="danger" title={said(t, state.read.problem)} />}
      {value && (
        <div className="fw-pr8-stack">
          {state.problem && <Banner tone="danger" title={said(t, state.problem)} />}
          <KeyValue
            columns={2}
            items={[
              { label: t('held.time'), value: formatDateTime(value.at, { locale, timeZone: TIME_ZONE }) },
              { label: t('held.why'), value: t(`hold.${value.reason}`) },
              { label: t('ledger.bundle'), value: value.bundle },
              { label: t('rates.operation'), value: `${value.operation.code} · ${value.operation.name}` },
              { label: t('ledger.pieces'), value: value.pieces },
              { label: t('periods.status'), value: t(`holdStatus.${value.status}`) },
            ]}
          />
          {value.peopleShown ? (
            <ul className="fw-pr8-list" aria-label={t('resolve.people')}>
              {value.people.map((person) => (
                <li key={person.employeeId}>
                  <Link className="fw-pp-link" href={`${model.prefix}/people/employees/${person.employeeId}?tab=pay`} target="_blank">
                    {person.name}
                  </Link>{' '}
                  · {t(person.clockedIn ? 'resolve.clockedIn' : 'resolve.notClockedIn')}
                </li>
              ))}
            </ul>
          ) : (
            <p className="fw-pr8-hint">{t('resolve.noNames')}</p>
          )}
          {open && <p className="fw-pr8-hint">{t(value.canCount ? 'resolve.canCount' : 'resolve.needsFix')}</p>}
          {open && model.built.attendance && value.attendanceDayId && (
            <a className="fw-pp-link" href={`${model.built.attendance}?open=${encodeURIComponent(value.attendanceDayId)}`} target="_blank" rel="noreferrer">
              {t('resolve.attendance')}
            </a>
          )}
          {open && manage && (
            <Field label={t('resolve.note')}>
              <Input value={state.note} onChange={(event) => actions?.onHeldNote(event.target.value)} />
            </Field>
          )}
          {value.resolution?.note && <p className="fw-pr8-hint">{value.resolution.note}</p>}
        </div>
      )}
    </Modal>
  )
}

function EntryModal({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const read = model.entry!
  const value = read.status === 'ready' ? read.value : null
  return (
    <DetailModal
      open
      onClose={() => actions?.onOpenEntry(null)}
      title={value ? t(`kind.ledger.${value.reversesId ? 'REVERSAL' : value.kind}`) : t('record.loading')}
      {...(value ? { subtitle: dayText(value.workDate, locale) ?? '' } : {})}
      loading={read.status === 'loading'}
      error={read.status === 'failed' ? said(t, read.problem) : undefined}
      onRetry={() => actions?.onRetry()}
      actions={
        value && model.can.managePay ? (
          <Button size="sm" heldReason={value.canCorrect ? null : t(value.reversesId ? 'refusal.IS_REVERSAL' : 'refusal.ALREADY_REVERSED')} onClick={() => actions?.onCorrect()}>
            {t('correct.open')}
          </Button>
        ) : undefined
      }
    >
      {value && (
        <KeyValue
          columns={2}
          items={[
            { label: t('entry.person'), value: <Link className="fw-pp-link" href={`${model.prefix}/people/employees/${value.person.employeeId}?tab=pay`}>{value.person.name}</Link> },
            { label: t('ledger.bundle'), value: value.bundle ?? '—' },
            { label: t('rates.operation'), value: value.operation ? `${value.operation.code} · ${value.operation.name}` : '—' },
            { label: t('ledger.pieces'), value: value.pieces ?? '—' },
            { label: t('ledger.minutes'), value: minutesText(value.minutes, locale) ?? '—' },
            { label: t('ledger.rate'), value: rateText(value.rate, value.currency, locale) ?? '—' },
            { label: t('ledger.amount'), value: moneyText(value.amount, value.currency, locale) ?? '—' },
            ...(value.correctsMonth ? [{ label: t('ledger.corrects'), value: monthText(value.correctsMonth, locale) }] : []),
            ...(value.reason ? [{ label: t('ledger.reason'), value: value.reason }] : []),
          ]}
        />
      )}
    </DetailModal>
  )
}

function LockDialog({ model, dialog, actions }: { model: PieceModel; dialog: Extract<PieceDialog, { kind: 'lock' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const detail = model.period?.detail.status === 'ready' ? model.period.detail.value : null
  if (!detail) return null
  const month = monthText(detail.period.month, locale)
  return (
    <ActionConfirm
      impact={{
        level: 'type-to-confirm',
        reach: 'local-destructive',
        title: t('lock.title', { month }),
        confirmLabel: t('lock.apply'),
        consequences: [t('lock.final'), t('lock.corrections'), t('lock.people', { count: detail.period.people })],
        reversal: { verb: t('lock.never'), fidelity: 'none' },
        subject: { kind: 'external-id', value: detail.lockPhrase },
        confirmPhrase: detail.lockPhrase,
        ...(dialog.problem ? { refusal: { reason: said(t, dialog.problem) } } : {}),
      }}
      onConfirm={() => actions?.onLockSave()}
      onCancel={() => actions?.onCloseDialog()}
    />
  )
}

function ReasonDialog({ dialog, actions }: { dialog: Extract<PieceDialog, { kind: 'backToPreview' | 'notPaid' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const notPaid = dialog.kind === 'notPaid'
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog()}
      title={notPaid ? t('held.notPayTitle', { count: dialog.ids.length }) : t('periods.backTitle')}
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.cancel')}
          </Button>
          <Button variant={notPaid ? 'danger' : 'primary'} heldReason={dialog.busy ? t('common.working') : reasonHeld(dialog.reason) ? t('common.reasonHeld') : null} onClick={() => (notPaid ? actions?.onNotPaidSave() : actions?.onBackSave())}>
            {notPaid ? t('held.notPayN', { count: dialog.ids.length }) : t('periods.back')}
          </Button>
        </>
      }
    >
      <div className="fw-pr8-stack">
        {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
        <p className="fw-pr8-hint">{t(notPaid ? 'held.notPayBody' : 'periods.backBody')}</p>
        <Field label={t('common.why')} required>
          <Textarea value={dialog.reason} rows={2} onChange={(event) => actions?.onDialogReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** A lead opens a statement of someone they lead: pieces and minutes, no money; why is recorded, and the gate decides. */
function LeadOpenDialog({ dialog, actions }: { dialog: Extract<PieceDialog, { kind: 'leadOpen' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog()}
      title={t('statement.leadTitle')}
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={dialog.busy ? t('common.working') : dialog.reason ? null : t('statement.leadHeld')} onClick={() => actions?.onLeadOpenSave()}>
            {t('statement.open')}
          </Button>
        </>
      }
    >
      <div className="fw-pr8-stack">
        {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
        <p className="fw-pr8-hint">{t('statement.leadBody')}</p>
        <Field label={t('common.why')} required>
          <Select value={dialog.reason} onChange={(event) => actions?.onLeadReason(event.target.value as OpenReason | '')}>
            <option value="">{t('common.choose')}</option>
            {OPEN_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {t(`openReason.${reason}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

function CorrectDialog({ dialog, actions }: { dialog: Extract<PieceDialog, { kind: 'correct' }>; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog()}
      title={t('correct.title')}
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={dialog.busy ? t('common.working') : reasonHeld(dialog.reason) ? t('common.reasonHeld') : null} onClick={() => actions?.onCorrectSave()}>
            {t('correct.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-pr8-stack">
        {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
        <p className="fw-pr8-hint">{t('correct.lead')}</p>
        <Field label={t('correct.amount')} hint={t('correct.amountHint')}>
          <Input value={dialog.amount} inputMode="decimal" onChange={(event) => actions?.onCorrectDraft({ amount: event.target.value })} />
        </Field>
        <Field label={t('common.why')} required>
          <Textarea value={dialog.reason} rows={2} onChange={(event) => actions?.onCorrectDraft({ reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
