'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, CircleAlert, CircleCheckBig, CircleSlash, ClipboardList, Clock, CloudOff, FileText, House, Layers, Lock, MessageSquareWarning, Printer, ReceiptText, Scale, Send, Timer, Undo2, UserRoundX } from 'lucide-react'
import { Field, MetricStrip, SummaryTable, type Metric } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, IdleOverlay, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { REASON_KIT_NAMESPACE, useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { ListFooter, PinSign, ProblemState, TaskLine, type PinProblem } from '../../shared/view/TaskParts'
import type { MyDay, MyDispute, MyPace, MyStatement, Printed } from '../api'
import { answeredDisputes, canGoBack, canGoForward, MESSAGE_MAX, monthAfter, monthBefore, monthWords, moneyText, openDisputes, printHeld, rateText, reasonsOf, ringShare, rowHeld, rowsOf, sendHeld, type DisputeDraft, type MyDayData, type MyRow, type RecordSpan } from '../model'
import '../myday.css'

/**
 * SCR-171 — Floor › My day (B-W2b-68; design floor.myday, MES-111, -112, -205, -206, -261; c.c. art. 2101; GDPR art. 15; Statuto
 * dei Lavoratori art. 4; Owner answers F1, F2): a worker's own day, tablet first, one job per screen.
 *
 *   Only you         the PIN pad, every time My day opens
 *   Today            own pieces, standard minutes, efficiency and money, each only where it may show; own pace as a ring
 *                    against the LINE's target. No line output, no average, no other person: nothing here compares
 *   Your records     own scans and blocks, today or this period, a row opens the dispute
 *   Dispute an entry reason tiles → Send
 *   Your disputes    the open ones, the answers, the changes made to the records
 *   Statement        pieces per operation, minutes, rates, earnings, make-up; printed at the office, or a PDF on one's own phone
 *
 * The view fetches nothing and keeps nothing: the container (MyDay.tsx) holds the figures and drops them.
 */

export type MyDayStep =
  | { readonly kind: 'pin'; readonly again?: boolean; readonly busy?: boolean; readonly problem?: PinProblem }
  | { readonly kind: 'loading' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'problem'; readonly problem: TaskProblem }
  | { readonly kind: 'station' }
  | { readonly kind: 'today' }
  | { readonly kind: 'records'; readonly span: RecordSpan; readonly done?: 'sent' | 'existing' | null }
  | { readonly kind: 'dispute'; readonly row: MyRow; readonly draft: DisputeDraft; readonly busy?: boolean; readonly problem?: TaskProblem | null }
  | { readonly kind: 'disputes'; readonly done?: 'withdrawn' | null }
  | { readonly kind: 'answer'; readonly dispute: MyDispute; readonly busy?: boolean; readonly problem?: TaskProblem | null }
  | { readonly kind: 'statement'; readonly busy?: boolean; readonly sent?: Printed['printer'] | null; readonly pdfReady?: boolean; readonly problem?: TaskProblem | null }

export interface MyDayViewModel {
  readonly frame: FrameModel
  readonly step: MyDayStep
  readonly data: MyDayData | null
  readonly online: boolean
  /** A person's own phone: the statement opens as a PDF. A shared tablet prints it instead. */
  readonly phone: boolean
  /** Answers not opened yet. */
  readonly unread: number
  /** The last seconds before the figures leave the screen. */
  readonly closing: { readonly secondsLeft: number } | null
  readonly timeZone?: string
}

export type MyDayAction =
  | { type: 'pin'; pin: string }
  | { type: 'back' }
  | { type: 'done' }
  | { type: 'stay' }
  | { type: 'retry' }
  | { type: 'records'; span: RecordSpan }
  | { type: 'row'; row: MyRow }
  | { type: 'reason'; code: string }
  | { type: 'words'; text: string }
  | { type: 'send' }
  | { type: 'disputes' }
  | { type: 'answer'; dispute: MyDispute }
  | { type: 'withdraw' }
  | { type: 'statement' }
  | { type: 'month'; month: string }
  | { type: 'print' }
  | { type: 'pdf' }

export interface MyDayScreenProps {
  model: MyDayViewModel
  onAction?: (action: MyDayAction) => void
  onFrame?: (action: FrameAction) => void
}

export function MyDayScreen(props: MyDayScreenProps) {
  return (
    <WithMessages namespaces={[REASON_KIT_NAMESPACE, 'ds-words']}>
      <Screen {...props} />
    </WithMessages>
  )
}

const KNOWN_REFUSALS = new Set(['NOT_APPROVED', 'NO_PRINTER', 'PHONE_ONLY', 'NOT_DISPUTABLE', 'NOT_YOURS', 'DISPUTE_NOT_OPEN'])

const refusalWords =
  (t: Translate) =>
  (code: string): { message: string; fix: string | null } | null =>
    KNOWN_REFUSALS.has(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null

function ProblemLine({ problem, t }: { problem: TaskProblem | null | undefined; t: Translate }) {
  const tasks = useT('floor-tasks')
  if (!problem) return null
  const known = problem.kind === 'refused' ? refusalWords(t)(problem.code) : null
  const words = problem.kind === 'refused' ? [known?.message ?? t('refusal.other'), known?.fix].filter(Boolean).join(' ') : tasks(`problem.${problem.kind === 'stepUp' ? 'forbidden' : problem.kind}.title`)
  return (
    <TaskLine tone="danger" icon={<CircleAlert />} alert>
      {words}
    </TaskLine>
  )
}

/** Arrows move between the rows; Enter presses the focused one (design floor.myday "Arrows move rows"). */
function useRowKeys() {
  const group = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(group.current?.querySelectorAll<HTMLElement>('.nds-floor-row.is-pressable') ?? [])]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)
    event.preventDefault()
    items[next]?.focus()
  }
  return { group, onKeyDown }
}

function Screen({ model, onAction, onFrame }: MyDayScreenProps) {
  const t = useT('floor-myday')
  const frameWords = useT('floor')
  const send = (action: MyDayAction) => onAction?.(action)
  const { step, data } = model
  const back = { label: t('action.back'), icon: <ArrowLeft />, variant: 'secondary' as const, onPress: () => send({ type: 'back' }) }
  const done = { label: t('action.done'), icon: <Lock />, onPress: () => send({ type: 'done' }) }
  const home = { label: t('action.home'), icon: <House />, onPress: () => send({ type: 'done' }) }
  let actions: FloorActions | null = null
  let body: ReactNode = null

  switch (step.kind) {
    case 'pin':
      // Back sits by the words, not in the bar: the whole pad stays on one tablet screen, its message too.
      body = (
        <PinSign
          title={t('pin.title')}
          meaning={t(step.again ? 'pin.again' : 'pin.meaning')}
          onPin={(pin) => send({ type: 'pin', pin })}
          busy={step.busy}
          problem={step.problem}
          summary={
            <FloorButton size="md" variant="quiet" icon={<ArrowLeft />} onClick={() => send({ type: 'back' })}>
              {t('action.back')}
            </FloorButton>
          }
        />
      )
      break
    case 'loading':
      body = <FloorState tone="info" icon={<ClipboardList />} title={t('loading')} busy />
      break
    case 'offline':
      body = <FloorState tone="warning" icon={<CloudOff />} title={t('offline.title')} text={t('offline.body')} />
      actions = [home]
      break
    case 'station':
      body = <FloorState tone="info" icon={<Layers />} title={t('station.title')} text={t('station.body')} />
      actions = [home]
      break
    case 'problem':
      body = <ProblemState problem={step.problem} words={refusalWords(t)} />
      actions = step.problem.kind === 'forbidden' ? [home] : [home, { label: t('action.retry'), icon: <Clock />, onPress: () => send({ type: 'retry' }) }]
      break
    case 'today':
      if (data) body = <Today data={data} model={model} send={send} t={t} />
      actions = [done]
      break
    case 'records':
      if (data) body = <Records data={data} step={step} model={model} send={send} t={t} />
      actions = [back]
      break
    case 'dispute': {
      const why = sendHeld(step.draft)
      if (data) body = <Dispute data={data} step={step} model={model} send={send} t={t} />
      actions = [back, { label: t('action.send'), icon: <Send />, heldReason: step.busy ? t('held.busy') : why ? t(`held.${why}`) : null, onPress: () => send({ type: 'send' }) }]
      break
    }
    case 'disputes':
      if (data) body = <Disputes data={data} step={step} model={model} send={send} t={t} />
      actions = [back]
      break
    case 'answer':
      body = <Answer step={step} model={model} t={t} />
      actions = step.dispute.status === 'OPEN' ? [back, { label: t('action.withdraw'), icon: <Undo2 />, variant: 'danger', heldReason: step.busy ? t('held.busy') : null, onPress: () => send({ type: 'withdraw' }) }] : [back]
      break
    case 'statement': {
      if (data) body = <Statement data={data} step={step} model={model} send={send} t={t} />
      const statement = data?.statement.pay?.statement ?? null
      if (!statement) actions = [back]
      else if (model.phone) actions = [back, { label: t('action.pdf'), icon: <FileText />, heldReason: statement.status === 'APPROVED' ? null : t('held.draft'), onPress: () => send({ type: 'pdf' }) }]
      else {
        const why = data ? printHeld(data.statement, statement) : null
        actions = [back, { label: t('action.print'), icon: <Printer />, heldReason: step.busy ? t('held.busy') : why ? t(`held.${why}`) : null, onPress: () => send({ type: 'print' }) }]
      }
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar actions={actions} label={t('title')} /> : undefined}>
      <div className="fw-md">
        {/* The warning hides the figures at once: only "I am here" brings them back. */}
        {model.closing ? null : body}
        <IdleOverlay
          open={model.closing !== null}
          secondsLeft={model.closing?.secondsLeft ?? 0}
          title={t('closing.title')}
          message={t('closing.body')}
          secondsLabel={(count) => frameWords('frame.idle.seconds', { count })}
          stayLabel={t('closing.stay')}
          onStay={() => send({ type: 'stay' })}
          signOutLabel={t('closing.close')}
          onSignOut={() => send({ type: 'done' })}
        />
      </div>
    </FloorFrameView>
  )
}

interface PartProps {
  data: MyDayData
  model: MyDayViewModel
  send: (action: MyDayAction) => void
  t: Translate
}

function Privacy({ t }: { t: Translate }) {
  const ds = useDsWords()
  return <PrivacyNote level="individual" text={t('privacy.text')} law={<LawRef law={t('privacy.law')} plain={t('privacy.plain')} labels={ds.lawRef} />} labels={ds.privacyNote} />
}

// ---- Today ----------------------------------------------------------------------------------------------------------

/** The ring (composed: the DS has none): own pace, the share also in words, never colour alone. */
function PaceRing({ pace, t }: { pace: MyPace; t: Translate }) {
  const share = ringShare(pace.percent)
  const radius = 42
  const length = 2 * Math.PI * radius
  return (
    <div className="fw-md-ring" data-pace={pace.pace}>
      <svg viewBox="0 0 100 100" aria-hidden="true" className="fw-md-ring-art">
        <circle className="fw-md-ring-track" cx="50" cy="50" r={radius} />
        <circle className="fw-md-ring-fill" cx="50" cy="50" r={radius} strokeDasharray={`${(share / 100) * length} ${length}`} />
      </svg>
      <span className="fw-md-ring-value">{pace.percent === null ? t('pace.none') : `${pace.percent}%`}</span>
    </div>
  )
}

function Pace({ pace, performance, t }: { pace: MyPace; performance: NonNullable<MyDay['performance']>; t: Translate }) {
  return (
    <section className="fw-md-pace" aria-labelledby="fw-md-pace">
      <PaceRing pace={pace} t={t} />
      <div className="fw-md-pace-words">
        <h2 id="fw-md-pace" className="fw-floor-subtitle">
          {t('pace.title')}
        </h2>
        <p className="fw-floor-lead">{t(`pace.${pace.pace}`)}</p>
        <p className="fw-floor-muted">{[pace.targetSoFar !== null ? t('pace.soFar', { done: pace.done, target: pace.targetSoFar }) : null, pace.hourTarget !== null ? t('pace.hour', { target: pace.hourTarget }) : null].filter(Boolean).join(' · ')}</p>
        {performance.sharedReports > 0 ? <p className="fw-floor-muted">{t('pace.shared', { count: performance.sharedReports })}</p> : null}
        <p className="fw-floor-muted">{[pace.line ? t('pace.line', { line: `${pace.line.code} ${pace.line.name}` }) : null, t('pace.only')].filter(Boolean).join(' · ')}</p>
      </div>
    </section>
  )
}

function Today({ data, model, send, t }: PartProps) {
  const locale = useLocale()
  const ds = useDsWords()
  const { day, mine } = data
  const { work, performance, pay } = day
  const minutes = (value: string) => formatNumber(Number(value), locale, { maximumFractionDigits: 1 })
  const metrics: Metric[] = [
    { label: t('today.pieces'), value: formatNumber(work.pieces, locale), hint: work.scrap + work.rework > 0 ? t('today.defects', { scrap: work.scrap, rework: work.rework }) : t('today.reports', { count: work.reports }) },
    ...(performance
      ? [
          { label: t('today.minutes'), value: minutes(performance.earnedMinutes), hint: t('today.minutesHint') },
          { label: t('today.efficiency'), value: performance.efficiency === null ? '—' : `${formatNumber(Number(performance.efficiency), locale, { maximumFractionDigits: 1 })}%`, hint: performance.efficiency === null ? t('today.noTiming') : t('today.efficiencyHint') },
        ]
      : []),
    ...(pay && day.paysToday ? [{ label: t('today.earned'), value: moneyText(pay.todayEarnings, pay.currency, locale), hint: t('today.earnedHint') }] : []),
  ]
  const records = rowsOf(mine, 'today', day.today).length
  return (
    <div className="fw-floor-stack">
      <Privacy t={t} />
      {day.linked ? null : (
        <TaskLine tone="warning" icon={<CircleAlert />}>
          {t('today.notLinked')}
        </TaskLine>
      )}
      <section className="fw-floor-section" aria-labelledby="fw-md-today">
        <h2 id="fw-md-today" className="fw-floor-subtitle">
          {t('today.title')}
        </h2>
        <MetricStrip metrics={metrics} className="fw-md-metrics" minTileWidth={170} />
      </section>
      {performance ? (
        performance.traineeDay ? (
          <TaskLine tone="info" icon={<Timer />}>
            {t('today.trainee')}
          </TaskLine>
        ) : (
          <Pace pace={performance.pace} performance={performance} t={t} />
        )
      ) : day.linked ? (
        <TaskLine tone="info" icon={<Scale />}>
          <span>{t('today.gateOff')}</span> <LawRef law={t('gate.law')} plain={t('gate.plain')} labels={ds.lawRef} />
        </TaskLine>
      ) : null}
      {pay && pay.held > 0 ? (
        <TaskLine tone="warning" icon={<Timer />}>
          {t('today.held', { count: pay.held })}
        </TaskLine>
      ) : null}
      <FloorTileGrid label={t('today.more')} columns={pay ? 3 : 2}>
        <FloorTile icon={<ClipboardList />} label={t('records.title')} hint={t('tile.records', { count: records })} tone="primary" onPress={() => send({ type: 'records', span: 'today' })} />
        <FloorTile icon={<MessageSquareWarning />} label={t('disputes.title')} hint={model.unread > 0 ? t('tile.answers', { count: model.unread }) : t('tile.disputes', { count: openDisputes(mine).length })} {...(model.unread > 0 ? { count: model.unread, countLabel: t('tile.answers', { count: model.unread }) } : {})} tone={model.unread > 0 ? 'warning' : 'primary'} onPress={() => send({ type: 'disputes' })} />
        {pay ? <FloorTile icon={<ReceiptText />} label={t('statement.title')} hint={pay.statement ? t('tile.statement', { month: monthWords(pay.month, locale) }) : t('tile.noStatement')} tone="primary" onPress={() => send({ type: 'statement' })} /> : null}
      </FloorTileGrid>
    </div>
  )
}

// ---- Your records ---------------------------------------------------------------------------------------------------

function rowTone(row: MyRow): FloorTone {
  const held = rowHeld(row)
  if (held === 'open') return 'warning'
  if (row.report?.state === 'UNDONE') return 'neutral'
  return 'primary'
}

function Records({ data, step, model, send, t }: PartProps & { step: Extract<MyDayStep, { kind: 'records' }> }) {
  const locale = useLocale()
  const { group, onKeyDown } = useRowKeys()
  const { day, mine } = data
  const rows = rowsOf(mine, step.span, day.today)
  const when = (row: MyRow) => (step.span === 'today' ? formatTime(row.at, { locale, timeZone: model.timeZone }) : `${formatDate(row.at, { locale, timeZone: model.timeZone })} ${formatTime(row.at, { locale, timeZone: model.timeZone })}`)
  return (
    <div className="fw-floor-stack">
      {step.done ? (
        <TaskLine tone="success" icon={<CircleCheckBig />}>
          {t(`records.done.${step.done}`)}
        </TaskLine>
      ) : null}
      <div className="fw-md-span" role="group" aria-label={t('records.title')}>
        {(['today', 'period'] as const).map((span) => (
          <FloorButton key={span} size="md" variant={step.span === span ? 'primary' : 'secondary'} aria-pressed={step.span === span} onClick={() => send({ type: 'records', span })}>
            {t(`records.span.${span}`)}
          </FloorButton>
        ))}
      </div>
      {rows.length === 0 ? (
        <FloorState tone="info" icon={<ClipboardList />} title={t(`records.none.${step.span}`)} />
      ) : (
        <>
          <div ref={group} onKeyDown={onKeyDown}>
            <FloorList label={t('records.title')}>
              {rows.map((row) => (
                <RecordRow key={row.key} row={row} when={when(row)} locale={locale} send={send} t={t} />
              ))}
            </FloorList>
          </div>
          <ListFooter count={t('records.count', { count: rows.length })} keys={[{ key: '↑ ↓', does: t('keys.move') }, { key: 'Enter', does: t('keys.open') }, { key: 'Esc', does: t('keys.back') }]} />
        </>
      )}
    </div>
  )
}

function RecordRow({ row, when, locale, send, t }: { row: MyRow; when: string; locale: Locale; send: (action: MyDayAction) => void; t: Translate }) {
  const held = rowHeld(row)
  const status = row.dispute ? t(`dispute.status.${row.dispute.status}`) : row.report?.state === 'CORRECTED' ? t('records.corrected') : row.report?.state === 'UNDONE' ? t('records.undone') : undefined
  if (row.report) {
    const { report } = row
    const facts = [when, report.counts.scrap > 0 ? t('records.scrap', { count: report.counts.scrap }) : null, report.counts.rework > 0 ? t('records.rework', { count: report.counts.rework }) : null, report.minutes ? t('records.minutes', { minutes: formatNumber(Number(report.minutes), locale, { maximumFractionDigits: 1 }) }) : null, report.enteredByLead ? t('records.byLead') : null].filter(Boolean).join(' · ')
    return <FloorListRow icon={<Layers />} tone={rowTone(row)} title={`${report.bundle.code} · ${t('records.operation', { seq: report.operation?.seq ?? '', name: report.operation?.name ?? '' })}`} meta={facts} status={status} count={report.counts.good} countLabel={t('records.pieces')} onPress={held ? undefined : () => send({ type: 'row', row })} heldReason={held ? t(`held.row.${held}`) : null} />
  }
  const block = row.block!
  const label = block.code.labelI18n[locale] ?? (locale === 'it' ? block.code.labelIt : block.code.labelEn)
  return <FloorListRow icon={<Clock />} tone={rowTone(row)} title={label} meta={when} status={status ?? t(`records.block.${block.status}`)} count={block.minutes} countLabel={t('records.min')} onPress={held ? undefined : () => send({ type: 'row', row })} heldReason={held ? t(`held.row.${held}`) : null} />
}

// ---- Dispute an entry -----------------------------------------------------------------------------------------------

const REASON_ICON: Readonly<Record<string, ReactNode>> = {
  WRONG_QUANTITY: <Layers />,
  WRONG_OPERATION: <ClipboardList />,
  NOT_ME: <UserRoundX />,
  WRONG_TIME: <Clock />,
  WRONG_CODE: <CircleSlash />,
  OTHER: <MessageSquareWarning />,
}

function Dispute({ data, step, send, t }: PartProps & { step: Extract<MyDayStep, { kind: 'dispute' }> }) {
  const locale = useLocale()
  const words = useReasonWords()
  const tiles: ReasonTile[] = reasonsOf(data.mine, step.row).map((code) => ({ id: code, label: t(`dispute.reason.${code}`), icon: REASON_ICON[code] ?? <MessageSquareWarning /> }))
  const { row } = step
  const title = row.report ? `${row.report.bundle.code} · ${t('records.operation', { seq: row.report.operation?.seq ?? '', name: row.report.operation?.name ?? '' })}` : (row.block?.code.labelI18n[locale] ?? (locale === 'it' ? row.block?.code.labelIt : row.block?.code.labelEn) ?? '')
  return (
    <div className="fw-floor-stack">
      <p className="fw-floor-subtitle">{title}</p>
      <ProblemLine problem={step.problem} t={t} />
      <ReasonGrid label={t('dispute.question')} reasons={tiles} value={step.draft.reason} onChange={(code) => send({ type: 'reason', code })} words={words} locale={INTL_LOCALE[locale]} />
      {step.draft.reason === 'OTHER' ? (
        <Field label={t('dispute.words')} required htmlFor="fw-md-words">
          <Textarea id="fw-md-words" value={step.draft.words} rows={3} limit={MESSAGE_MAX} maxLength={MESSAGE_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
        </Field>
      ) : null}
      <p className="fw-floor-muted">{t('dispute.who')}</p>
    </div>
  )
}

// ---- Your disputes --------------------------------------------------------------------------------------------------

function DisputeRow({ dispute, model, send, t }: { dispute: MyDispute; model: MyDayViewModel; send: (action: MyDayAction) => void; t: Translate }) {
  const locale = useLocale()
  const tone: FloorTone = dispute.status === 'OPEN' ? 'warning' : dispute.status === 'UPHELD' ? 'success' : 'neutral'
  return <FloorListRow icon={dispute.status === 'OPEN' ? <MessageSquareWarning /> : <Check />} tone={tone} title={t(`dispute.reason.${dispute.reason}`)} meta={[formatDate(dispute.raisedAt, { locale, timeZone: model.timeZone }), dispute.answer].filter(Boolean).join(' · ')} status={t(`dispute.status.${dispute.status}`)} onPress={() => send({ type: 'answer', dispute })} />
}

function Disputes({ data, step, model, send, t }: PartProps & { step: Extract<MyDayStep, { kind: 'disputes' }> }) {
  const locale = useLocale()
  const { group, onKeyDown } = useRowKeys()
  const open = openDisputes(data.mine)
  const answered = answeredDisputes(data.mine)
  const { edits } = data.mine
  return (
    <div className="fw-floor-stack" ref={group} onKeyDown={onKeyDown}>
      {step.done ? (
        <TaskLine tone="success" icon={<CircleCheckBig />}>
          {t(`disputes.done.${step.done}`)}
        </TaskLine>
      ) : null}
      {open.length + answered.length === 0 ? <FloorState tone="info" icon={<MessageSquareWarning />} title={t('disputes.none.title')} text={t('disputes.none.body')} /> : null}
      {open.length > 0 ? (
        <section className="fw-floor-section" aria-labelledby="fw-md-open">
          <h2 id="fw-md-open" className="fw-floor-subtitle">
            {t('disputes.open')}
          </h2>
          <FloorList label={t('disputes.open')}>
            {open.map((dispute) => (
              <DisputeRow key={dispute.id} dispute={dispute} model={model} send={send} t={t} />
            ))}
          </FloorList>
        </section>
      ) : null}
      {answered.length > 0 ? (
        <section className="fw-floor-section" aria-labelledby="fw-md-answered">
          <h2 id="fw-md-answered" className="fw-floor-subtitle">
            {t('disputes.answered')}
          </h2>
          <FloorList label={t('disputes.answered')}>
            {answered.map((dispute) => (
              <DisputeRow key={dispute.id} dispute={dispute} model={model} send={send} t={t} />
            ))}
          </FloorList>
        </section>
      ) : null}
      {edits.length > 0 ? (
        <section className="fw-floor-section" aria-labelledby="fw-md-edits">
          <h2 id="fw-md-edits" className="fw-floor-subtitle">
            {t('disputes.edits')}
          </h2>
          <ul className="fw-md-edits">
            {edits.map((edit) => (
              <li key={edit.id}>
                <span className="fw-floor-muted">{formatDate(edit.at, { locale, timeZone: model.timeZone })}</span> {edit.changes.map((change) => t('disputes.change', { from: change.from ?? '—', to: change.to ?? '—' })).join(' · ')}
                {edit.reason ? <span className="fw-floor-muted"> · {edit.reason}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function Answer({ step, model, t }: { step: Extract<MyDayStep, { kind: 'answer' }>; model: MyDayViewModel; t: Translate }) {
  const locale = useLocale()
  const { dispute } = step
  return (
    <div className="fw-floor-stack">
      <ProblemLine problem={step.problem} t={t} />
      <p className="fw-floor-subtitle">{t(`dispute.reason.${dispute.reason}`)}</p>
      <p className="fw-floor-muted">{t('answer.raised', { date: formatDate(dispute.raisedAt, { locale, timeZone: model.timeZone }) })}</p>
      {dispute.words ? <p className="fw-floor-lead">{dispute.words}</p> : null}
      <TaskLine tone={dispute.status === 'OPEN' ? 'info' : dispute.status === 'UPHELD' ? 'success' : 'warning'} icon={dispute.status === 'OPEN' ? <Timer /> : <Check />}>
        {t(`dispute.status.${dispute.status}`)}
      </TaskLine>
      {dispute.answer ? <p className="fw-floor-lead">{dispute.answer}</p> : null}
    </div>
  )
}

// ---- Statement ------------------------------------------------------------------------------------------------------

function Lines({ statement, t, locale }: { statement: MyStatement; t: Translate; locale: Locale }) {
  const money = (amount: number) => moneyText(amount, statement.currency, locale)
  const minutes = (value: string) => formatNumber(Number(value), locale, { maximumFractionDigits: 3 })
  const rows = [
    ...statement.lines.map((line, index) => ({ id: `l${index}`, cells: [`${line.operationCode} ${line.operationName}${line.sharePct ? ` (${t('statement.share', { share: line.sharePct })})` : ''}`, line.pieces, minutes(line.minutes), rateText(line.rate, locale), money(line.amount)] })),
    ...statement.time.map((line, index) => ({ id: `t${index}`, cells: [`${line.code} ${t('statement.time')}`, '', minutes(line.minutes), rateText(line.rate, locale), money(line.amount)] })),
  ]
  const earnings = statement.earningsAmount ?? 0
  const makeUp = statement.makeUpAmount ?? 0
  return (
    <>
      {rows.length > 0 ? <SummaryTable label={t('statement.title')} columns={[t('statement.operation'), t('statement.pieces'), t('statement.minutes'), t('statement.rate'), t('statement.amount')]} rows={rows} align={[undefined, 'right', 'right', 'right', 'right']} widths={['40%']} stackOnPhone density="roomy" /> : <p className="fw-floor-lead">{t('statement.noLines')}</p>}
      <dl className="fw-md-totals">
        <div>
          <dt>{t('statement.earnings')}</dt>
          <dd>{money(earnings)}</dd>
        </div>
        <div>
          <dt>{t('statement.makeUp')}</dt>
          <dd>{money(makeUp)}</dd>
        </div>
        <div data-strong="true">
          <dt>{t('statement.total')}</dt>
          <dd>{money(earnings + makeUp)}</dd>
        </div>
      </dl>
    </>
  )
}

function Statement({ data, step, model, send, t }: PartProps & { step: Extract<MyDayStep, { kind: 'statement' }> }) {
  const locale = useLocale()
  const day = data.statement
  const pay = day.pay
  const statement = pay?.statement ?? null
  const month = day.month
  const earlier = monthBefore(month)
  const later = monthAfter(month)
  return (
    <div className="fw-floor-stack">
      <div className="fw-md-month">
        <FloorButton size="md" icon={<ChevronLeft />} aria-label={t('statement.earlier')} heldReason={canGoBack(month, day.today) ? null : t('held.months')} onClick={() => send({ type: 'month', month: earlier })} />
        <h2 className="fw-floor-subtitle">{monthWords(month, locale)}</h2>
        <FloorButton size="md" icon={<ChevronRight />} aria-label={t('statement.later')} heldReason={canGoForward(month, day.today) ? null : t('held.thisMonth')} onClick={() => send({ type: 'month', month: later })} />
      </div>
      <ProblemLine problem={step.problem} t={t} />
      {step.sent ? (
        <TaskLine tone="success" icon={<Printer />}>
          {t('statement.sent', { printer: step.sent.code })}
        </TaskLine>
      ) : null}
      {step.pdfReady ? (
        <TaskLine tone="info" icon={<FileText />}>
          {t('statement.pdfReady')}
        </TaskLine>
      ) : null}
      {statement ? (
        <>
          {statement.status === 'APPROVED' ? (
            <p className="fw-floor-muted">{t('statement.approved', { revision: statement.revision })}</p>
          ) : (
            <TaskLine tone="warning" icon={<Timer />}>
              {t('statement.draft')}
            </TaskLine>
          )}
          <Lines statement={statement} t={t} locale={locale} />
        </>
      ) : (
        <FloorState tone="info" icon={<ReceiptText />} title={t('statement.none.title')} text={t(pay ? 'statement.none.body' : 'statement.none.noPay')} />
      )}
      {statement && !model.phone && !day.printer && statement.status === 'APPROVED' ? <p className="fw-floor-muted">{t('held.noPrinter')}</p> : null}
    </div>
  )
}
