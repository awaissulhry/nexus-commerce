'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, BookOpenCheck, CircleAlert, CloudOff, Eye, FileWarning, House, Layers, ListOrdered, Pause, Play, RotateCcw, ScanLine, Send, ShieldOff, Shirt, Sparkles, TriangleAlert } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, ScanInput, type CameraScanner, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import type { LabelType } from '../../../scan/scan-model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { OpenItem } from '../../scans/timing'
import type { TaskProblem } from '../../shared/task-api'
import { ListFooter, ProblemState, TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import type { DueInstruction, FloorInstruction, FloorSpec, NewerSpec } from '../api'
import { isKnownRefusal, newerLine, NS, seenHeld, sendHeld, type Due, type ProblemDraft } from '../model'
import { MediaSteps, type MediaStepsAction } from './MediaSteps'
import { ProblemBody, type ProblemAction } from './ProblemBody'
import { SpecPages } from './SpecPages'
import { ZoomDialog } from './ZoomDialog'
import '../instructions.css'

/**
 * SCR-174 — Floor › Spec & instructions (B-W2b-232; design floor.instructions; MES-110, MES-119, PRD-195, PRD-258, PRD-259; on
 * the merged APIs of B-W2b-214, -220 and -226). One job per screen inside the floor frame, tablet first, centred:
 *
 *   For this work    opens for the bundle in hand (the Operation screen's, or the one running bundle), or scan a bundle's ticket;
 *                    the person's other open bundles and "New for you" (the versions waiting for their Seen) as rows
 *   Spec changed     a newer spec exists for this work order (B-W2b-220): the floor's words, the frozen pages stay
 *   How to do it     one step per screen, picture first (FloorMediaSteps), read aloud, zoom (pop:instructions.zoom)
 *   Spec for this size  the frozen spec: revision, colourway, size, label, the size's measures, the materials per garment,
 *                    the machine settings, the routing
 *   Seen             the main action when acknowledgement is due, held until every step was on screen
 *   Report a spec problem  type tiles → photo (no faces) → Send, linked to the operation and the work order
 *
 * Status in the head: the version, "New" when Seen waits. Never money. The view fetches nothing: Instructions.tsx reads and maps.
 */

export type ScanProblem = { readonly kind: 'wrongLabel'; readonly type: LabelType; readonly code: string } | { readonly kind: 'unknownCode'; readonly reason: 'otherFactory' | 'typo'; readonly code: string }

export interface OpenWork {
  readonly answer: FloorInstruction
  /** Shown from this tablet (offline): as of when. */
  readonly asOf: string | null
  readonly spec: FloorSpec | null
  readonly specAsOf: string | null
  /** The spec could not be read and none is kept. */
  readonly specProblem: 'offline' | 'unavailable' | null
  readonly newer: NewerSpec | null
  readonly tab: 'steps' | 'spec'
  readonly index: number
  readonly shown: readonly number[]
  /** The medium picked per step (a step with several). */
  readonly media: Readonly<Record<number, number>>
  readonly zoom: { readonly mediaId: string; readonly level: number } | null
  /** Seen waits for this person (FIRST, CHANGED), after what this tablet holds. */
  readonly due: Due | null
  /** Seen tapped here: its ticks, or the refusal's code. */
  readonly seen: { readonly ticks: TickState; readonly refusal: string | null } | null
  readonly busy: boolean
  readonly from: 'operation' | 'start' | 'mywork' | null
}

export interface SentProblem {
  readonly ticks: TickState
  readonly refusal: string | null
  /** The photo taken with it: none, waiting for the request's number, going up, up, or failed. */
  readonly photo: 'none' | 'waiting' | 'sending' | 'sent' | 'failed'
}

export type InstructionsStep =
  | { readonly kind: 'noPermission' }
  | { readonly kind: 'scan'; readonly problem?: ScanProblem | null; readonly prompt?: { readonly operation: string; readonly version: number } | null }
  | { readonly kind: 'loading'; readonly code: string }
  | { readonly kind: 'open'; readonly work: OpenWork }
  | { readonly kind: 'problem'; readonly work: OpenWork; readonly draft: ProblemDraft }
  | { readonly kind: 'sent'; readonly work: OpenWork; readonly sent: SentProblem }
  | { readonly kind: 'failed'; readonly code: string; readonly problem: TaskProblem }
  | { readonly kind: 'notOnTablet'; readonly code: string }

export interface InstructionsViewModel {
  frame: FrameModel
  step: InstructionsStep
  online: boolean
  /** The worker notice holds scans (Seen names the person). */
  held?: boolean
  /** The person's open bundles on this tablet (For this work). */
  inHand?: readonly OpenItem[]
  /** The versions waiting for this person's Seen. */
  due?: readonly DueInstruction[]
  /** mediaId → blob address (null: being read; absent: not read). */
  src?: Readonly<Record<string, string | null | undefined>>
  failed?: readonly string[]
  timeZone?: string
}

export type InstructionsAction =
  | { type: 'scan'; code: string }
  | { type: 'openItem'; code: string; operationId: string }
  | { type: 'openDue'; versionId: string }
  | { type: 'tab'; tab: 'steps' | 'spec' }
  | MediaStepsAction
  | { type: 'zoomLevel'; level: number }
  | { type: 'zoomClose' }
  | { type: 'seen' }
  | { type: 'problemOpen' }
  | ProblemAction
  | { type: 'problemSend' }
  | { type: 'problemBack' }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'retry' }
  | { type: 'scanAnother' }

export interface InstructionsViewProps {
  model: InstructionsViewModel
  onFrame?: (action: FrameAction) => void
  onAction?: (action: InstructionsAction) => void
  camera?: CameraScanner
}

export function InstructionsView({ model, onFrame = () => undefined, onAction = () => undefined, camera }: InstructionsViewProps) {
  const t = useT(NS)
  const scansT = useT('floor-scans')
  const floor = useT('floor')
  const locale = useLocale()
  const send = onAction
  const place = { locale, timeZone: model.timeZone }
  const time = (value: string) => formatTime(value, place)
  const day = (value: string) => formatDate(value, place)
  const { step } = model
  let body: ReactNode = null
  let actions: FloorActions | null = null
  let start: ReactNode = null
  const home: FloorAction = { label: t('action.home'), icon: <House />, variant: 'secondary', onPress: () => send({ type: 'home' }) }
  const another: FloorAction = { label: t('action.scanAnother'), icon: <ScanLine />, onPress: () => send({ type: 'scanAnother' }) }

  switch (step.kind) {
    case 'noPermission':
      actions = [home]
      body = <FloorState tone="warning" icon={<ShieldOff />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      break

    case 'scan':
      actions = [home]
      body = (
        <div className="fw-task-split">
          <section className="fw-floor-stack" aria-labelledby="fw-fi-open">
            <h2 id="fw-fi-open" className="fw-floor-section-title">
              {t('open.title')}
            </h2>
            <ScanInput
              label={t('open.scan')}
              hint={model.held ? floor('tile.held.notice') : t('open.hint')}
              scannedLabel={(code) => floor('scan.read', { code })}
              keyboardLabel={floor('scan.type')}
              disabled={Boolean(model.held)}
              camera={camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined}
              onScan={(code) => send({ type: 'scan', code })}
            />
            {step.problem ? <ScanProblemLine problem={step.problem} t={t} floor={floor} /> : null}
            {step.prompt ? (
              <TaskLine tone="info" icon={<ScanLine />}>
                {t('open.prompt', { operation: step.prompt.operation, n: step.prompt.version })}
              </TaskLine>
            ) : null}
            <p className="fw-floor-muted">{t('open.paper')}</p>
            {!model.online ? (
              <TaskLine tone="info" icon={<CloudOff />}>
                {t('open.offline')}
              </TaskLine>
            ) : null}
          </section>
          <div className="fw-floor-stack">
            {model.inHand && model.inHand.length > 0 ? (
              <section className="fw-floor-stack" aria-labelledby="fw-fi-inhand">
                <h3 id="fw-fi-inhand" className="fw-floor-subtitle">
                  {t('open.inHand')}
                </h3>
                <FloorList label={t('open.inHand')}>
                  {model.inHand.map((item) => (
                    <FloorListRow
                      key={`${item.bundleId}:${item.operation.id}`}
                      icon={item.state === 'RUNNING' ? <Play /> : <Pause />}
                      tone={item.state === 'RUNNING' ? 'success' : 'warning'}
                      title={item.bundleCode}
                      meta={`${scansT('opShort', { seq: item.operation.seq })} · ${item.operation.code} · ${item.operation.name}`}
                      status={t(`open.state.${item.state === 'RUNNING' ? 'running' : 'paused'}`)}
                      onPress={() => send({ type: 'openItem', code: item.bundleCode, operationId: item.operation.id })}
                    />
                  ))}
                </FloorList>
              </section>
            ) : null}
            {model.due && model.due.length > 0 ? (
              <section className="fw-floor-stack" aria-labelledby="fw-fi-due">
                <h3 id="fw-fi-due" className="fw-floor-subtitle">
                  {t('open.due')}
                </h3>
                <FloorList label={t('open.due')}>
                  {model.due.map((row) => (
                    <FloorListRow
                      key={row.versionId}
                      icon={<Sparkles />}
                      tone="primary"
                      title={`${row.operation.code} · ${row.operation.name}`}
                      meta={t('open.dueMeta', { number: row.number, n: row.versionNumber, date: row.publishedAt ? day(row.publishedAt) : '—' })}
                      status={t(`due.${row.reason}`)}
                      onPress={() => send({ type: 'openDue', versionId: row.versionId })}
                    />
                  ))}
                </FloorList>
                <ListFooter count={t('open.dueCount', { count: model.due.length })} keys={[{ key: 'Tab ↵', does: t('keys.open') }]} />
              </section>
            ) : null}
          </div>
        </div>
      )
      break

    case 'loading':
      actions = [home]
      body = <FloorState tone="info" icon={<BookOpenCheck />} title={t('loading.title')} text={step.code} />
      break

    case 'notOnTablet':
      actions = [home, another]
      body = <FloorState tone="warning" icon={<CloudOff />} title={t('notOnTablet.title')} text={t('notOnTablet.body', { code: step.code })} alert />
      break

    case 'failed': {
      actions = [home, another]
      const refused = step.problem.kind === 'refused' ? step.problem : null
      // A refusal the Operation screen knows speaks its words (floor-scans), else the page's general words; never the API's English.
      const params = { code: step.code, scanned: step.code, number: '', status: '', seq: '', operation: '' }
      const known = refused ? scansT(`refusal.${refused.code}.message`, params) : null
      const fix = refused ? scansT(`refusal.${refused.code}.fix`, params) : null
      const words = refused && known && known !== `refusal.${refused.code}.message` ? { message: known, fix: fix && fix !== `refusal.${refused.code}.fix` ? fix : null } : refused ? { message: t('failed.refused'), fix: null } : null
      body =
        step.problem.kind === 'notFound' ? (
          <FloorState tone="warning" icon={<CircleAlert />} title={t('failed.notFound.title')} text={t('failed.notFound.body', { code: step.code })} alert />
        ) : (
          <ProblemState problem={step.problem} code={step.code} words={() => words} />
        )
      break
    }

    case 'open': {
      const { work } = step
      const instruction = work.answer.instruction
      const held = seenHeld({ count: instruction?.steps.length ?? 0, shown: work.shown, busy: work.busy })
      const heldWords = held ? (held.key === 'steps' ? t('seen.held', { seen: held.seen, count: held.count }) : held.key === 'busy' ? t('seen.busy') : null) : null
      const backLabel = work.from === 'operation' || work.from === 'start' ? t('action.backToBundle') : t('action.back')
      const back: FloorAction = { label: backLabel, icon: <ArrowLeft />, variant: 'secondary', onPress: () => send({ type: 'back' }) }
      // The bar holds Back and the main action (Seen when it is due); Spec problem is the head's third button (design: secondary).
      if (work.due && instruction && (!work.seen || work.seen.ticks === 'refused')) {
        actions = [back, { label: t('action.seen'), icon: <Eye />, onPress: () => send({ type: 'seen' }), heldReason: heldWords, id: 'seen' }]
        start = heldWords
      } else {
        actions = [{ ...back, variant: 'primary' }]
      }
      const medium = work.zoom ? instruction?.steps.flatMap((entry) => entry.media).find((entry) => entry.id === work.zoom!.mediaId) : null
      body = (
        <>
          <WorkHead work={work} t={t} scansT={scansT} day={day} />
          <div className="fw-fi-tabs" role="group" aria-label={t('tabs.label')}>
            <FloorButton size="lg" block variant={work.tab === 'steps' ? 'primary' : 'secondary'} icon={<ListOrdered />} aria-pressed={work.tab === 'steps'} onClick={() => send({ type: 'tab', tab: 'steps' })}>
              {t('tabs.steps')}
            </FloorButton>
            <FloorButton size="lg" block variant={work.tab === 'spec' ? 'primary' : 'secondary'} icon={<Shirt />} aria-pressed={work.tab === 'spec'} onClick={() => send({ type: 'tab', tab: 'spec' })}>
              {t('tabs.spec')}
            </FloorButton>
            <FloorButton size="lg" block variant="secondary" icon={<FileWarning />} onClick={() => send({ type: 'problemOpen' })}>
              {t('action.problem')}
            </FloorButton>
          </div>
          <NewerBanner newer={work.newer} t={t} />
          {instruction && work.due === 'CHANGED' && instruction.version.changeNote ? (
            <TaskLine tone="info" icon={<Sparkles />}>
              {t('card.changeNote', { note: instruction.version.changeNote })}
            </TaskLine>
          ) : null}
          {work.seen ? <SeenLine seen={work.seen} t={t} /> : null}
          {work.asOf ? (
            <TaskLine tone="info" icon={<CloudOff />}>
              {t('asOf', { time: time(work.asOf) })}
            </TaskLine>
          ) : null}
          {work.tab === 'spec' ? (
            <SpecPages spec={work.spec} settings={work.answer.settings} asOf={work.specAsOf} problem={work.specProblem} locale={locale} timeZone={model.timeZone} t={t} />
          ) : instruction && instruction.steps.length > 0 ? (
            <MediaSteps
              model={{ steps: instruction.steps, index: work.index, shown: work.shown, medium: work.media[work.index] ?? 0, src: model.src ?? {}, failed: model.failed ?? [], asked: work.answer.language, online: model.online }}
              t={t}
              send={send}
            />
          ) : (
            <FloorState tone="info" icon={<Layers />} title={t('none.title')} text={t('none.body', { operation: `${work.answer.operation.code} · ${work.answer.operation.name}` })} />
          )}
          <ZoomDialog zoom={work.zoom} src={work.zoom ? (model.src?.[work.zoom.mediaId] ?? null) : null} alt={medium?.caption ?? t('zoom.title')} t={t} onLevel={(level) => send({ type: 'zoomLevel', level })} onClose={() => send({ type: 'zoomClose' })} />
        </>
      )
      break
    }

    case 'problem': {
      const { work, draft } = step
      const why = sendHeld(draft)
      actions = draft.capture
        ? null
        : [
            { label: t('action.back'), icon: <ArrowLeft />, variant: 'secondary', onPress: () => send({ type: 'problemBack' }) },
            { label: t('action.send'), icon: <Send />, onPress: () => send({ type: 'problemSend' }), heldReason: why ? t(`problem.held.${why}`) : null, id: 'send' },
          ]
      start = why && !draft.capture ? t(`problem.held.${why}`) : null
      body = <ProblemBody draft={draft} subject={`${work.answer.workOrder.number} · ${scansT('opShort', { seq: work.answer.operation.seq })} ${work.answer.operation.code}`} online={model.online} t={t} send={send} />
      break
    }

    case 'sent': {
      const { work, sent } = step
      actions = [
        { label: t('action.backToInstruction'), icon: <BookOpenCheck />, variant: 'secondary', onPress: () => send({ type: 'problemBack' }) },
        { label: work.from === 'operation' || work.from === 'start' ? t('action.backToBundle') : t('action.home'), icon: work.from === 'operation' || work.from === 'start' ? <ArrowLeft /> : <House />, onPress: () => send({ type: work.from === 'operation' || work.from === 'start' ? 'back' : 'home' }) },
      ]
      body = (
        <section className="fw-floor-stack fw-fi-sent" aria-labelledby="fw-fi-sent">
          <h2 id="fw-fi-sent" className="fw-floor-section-title">
            {t(sent.ticks === 'refused' ? 'sent.notSent' : 'sent.title')}
          </h2>
          {sent.ticks === 'refused' ? null : <p className="fw-floor-lead">{t('sent.body', { number: work.answer.workOrder.number, seq: work.answer.operation.seq })}</p>}
          <Ticks state={sent.ticks} />
          {sent.refusal ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {isKnownRefusal(sent.refusal) ? t(`refusal.${sent.refusal}`) : t('sent.failed')}
            </TaskLine>
          ) : null}
          {sent.photo !== 'none' ? (
            <TaskLine tone={sent.photo === 'failed' ? 'danger' : sent.photo === 'sent' ? 'success' : 'info'} icon={sent.photo === 'failed' ? <CircleAlert /> : sent.photo === 'sent' ? <Eye /> : <RotateCcw />}>
              {t(`sent.photo.${sent.photo}`)}
            </TaskLine>
          ) : null}
          <p className="fw-floor-muted">{t('sent.next')}</p>
        </section>
      )
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} start={start ?? undefined} /> : undefined}>
      <div className="fw-fi">{body}</div>
    </FloorFrameView>
  )
}

function ScanProblemLine({ problem, t, floor }: { problem: ScanProblem; t: Translate; floor: Translate }) {
  if (problem.kind === 'wrongLabel') {
    return (
      <TaskLine tone="warning" icon={<TriangleAlert />} alert>
        {t(problem.type === 'workOrder' ? 'open.workOrder' : 'open.wrongLabel', { what: floor(`label.${problem.type}`), code: problem.code })}
      </TaskLine>
    )
  }
  return (
    <TaskLine tone="warning" icon={<TriangleAlert />} alert>
      {floor(`scan.unknown.${problem.reason}.title`)}
    </TaskLine>
  )
}

/**
 * The head (design h.status "Version n", "'New' when changed"): the operation in hand big, the bundle, work order, instruction and
 * since when it is in force in one line, the version and, when Seen waits, "New" (or "First time"). Compact, so the step's picture
 * and words fit a tablet's screen with the bar.
 */
function WorkHead({ work, t, scansT, day }: { work: OpenWork; t: Translate; scansT: Translate; day: (value: string) => string }) {
  const { answer } = work
  const version = answer.instruction?.version ?? null
  const facts = [
    t('head.bundle', { code: answer.bundle.code }),
    answer.workOrder.number,
    answer.instruction?.number ?? null,
    version?.publishedAt ? t('head.since', { date: day(version.publishedAt) }) : null,
    answer.acknowledgement?.seenAt && !work.due ? t('head.seenOn', { date: day(answer.acknowledgement.seenAt) }) : null,
  ].filter((fact): fact is string => Boolean(fact))
  return (
    <header className="fw-fi-head" aria-labelledby="fw-fi-head-title">
      <span className="fw-fi-head-icon" aria-hidden="true">
        <BookOpenCheck />
      </span>
      <div className="fw-fi-head-text">
        <h2 id="fw-fi-head-title" className="fw-fi-op">
          {scansT('opCode', { seq: answer.operation.seq, code: answer.operation.code })} · {answer.operation.name}
        </h2>
        <p className="fw-fi-head-facts">{facts.join(' · ')}</p>
      </div>
      <span className="fw-fi-head-pills">
        <span className="fw-floor-pill" data-tone={version ? 'neutral' : 'warning'}>
          {version ? t('card.version', { n: version.number }) : t('card.noInstruction')}
        </span>
        {version && work.due ? (
          <span className="fw-floor-pill fw-fi-new" data-tone="primary">
            <Sparkles aria-hidden="true" />
            {t(`head.due.${work.due}`)}
          </span>
        ) : null}
      </span>
    </header>
  )
}

/** sec:spec-banner (PRD-195): the floor's words for the newer spec, its tone by what the office decided. */
export function NewerBanner({ newer, t }: { newer: NewerSpec | null | undefined; t: Translate }) {
  const line = newerLine(newer)
  if (!line) return null
  return (
    <div className="fw-fi-banner" data-tone={line.tone} role="note" aria-labelledby="fw-fi-banner-title">
      <p id="fw-fi-banner-title" className="fw-fi-banner-title">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <TriangleAlert />
        </span>
        {t('spec.banner.title')}
      </p>
      <p className="fw-floor-lead">{t(line.key, line.params)}</p>
      {line.newPages ? <p className="fw-floor-muted">{t('spec.banner.newPages')}</p> : null}
    </div>
  )
}

function SeenLine({ seen, t }: { seen: NonNullable<OpenWork['seen']>; t: Translate }) {
  if (seen.refusal) {
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {isKnownRefusal(seen.refusal) ? t(`refusal.${seen.refusal}`) : t('seen.failed')}
      </TaskLine>
    )
  }
  return (
    <div className="fw-fi-seen" role="status">
      <span className="fw-floor-lead">{t('seen.done')}</span>
      <Ticks state={seen.ticks} />
    </div>
  )
}
