'use client'

import { useMemo, type ReactNode } from 'react'
import { ArrowLeft, BadgeCheck, Camera, CircleAlert, ClipboardList, Cog, Footprints, Hammer, History, House, ListChecks, Lock, Mic, OctagonX, Play, RotateCcw, ScanLine, ShieldCheck, Sparkles, ThumbsUp, TriangleAlert, Undo2, Wrench } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, ScanInput, type CameraScanner, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { REASON_KIT_NAMESPACE, useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { iconOf } from '../../../../lib/plant/symptom-icons'
import { WithMessages } from '../../../../record-panels/i18n'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, PinSign, ProblemState, TaskCard, TaskLine, Ticks, type PinProblem, type TickState } from '../../shared/view/TaskParts'
import type { FloorJob, FloorMachine, FloorRequest, FloorRequestRecord, JobRecord, MachineStatus, Place, QueueEntry, SafeAfter, StationMachine, StoredMedia, TechnicianMove } from '../api'
import { closeHeld, leadHeld, leadOffered, mediaHeld, offersIncident, techHeld, worksHeld, type CloseCapture, type CloseDraft, type MediaKind, type MediaUpload } from '../depth'
import {
  ageParts,
  bannerOf,
  isKnownRefusal,
  isUnsafe,
  labelOf,
  lockingRequests,
  MACHINE_TONE,
  machineHeld,
  moveHeld,
  movesOf,
  NOTE_MAX,
  pickedSymptom,
  problemBeyond,
  priorityTone,
  reportHeld,
  reporterWords,
  signHeld,
  statusKey,
  symptomTiles,
  WORDS_MAX,
  wordsAsked,
  type MachineCan,
  type ReportDraft,
  type SignDraft,
} from '../model'
import { CloseBody, type CloseAction } from './CloseBody'
import { CaptureStep, PeekDialog, StoredList, TakenList, UploadList, type Peek } from './MediaParts'
import { IncidentOffer, QueueList, RequestBody, StationRequests, type RequestDone } from './ProgressParts'
import '../machine.css'

/**
 * SCR-179 — Floor › Machine problem & jobs (B-W2a-73; B-W2b-102 for the W2b parts; design floor.machine, QHS-178, QHS-180,
 * QHS-184, QHS-189, QHS-190; Owner answer H1): one job per screen inside the floor frame, tablet first, centred.
 *
 *   Which machine?   scan the machine's tag, or tap one of this station's machines (each with its state); the station's
 *                    banner in our words; "Reported here": the station's reports still under way (B-W2b-102)
 *   What is wrong?   the machine's symptom icons (DS ReasonGrid D20; an unsafe one locks the machine at once), a few words
 *                    for "Other", "It is unsafe: lock it" (anyone may: H1), an optional photo or voice note (B-W2b-102,
 *                    QHS-189; held offline: a picture needs the network); "Guard missing" also offers Report an incident
 *                    (held until B-W2b-137); Report · it still runs, or Report · machine down (main)
 *   Sent             saved on this tablet first (the floor queue), then "Recorded by the office" (two ticks); the photos
 *                    and voice notes go up once the office named the report; Follow it opens its progress
 *   The report       (B-W2b-102, QHS-180) the timeline reported → acknowledged → on the way → fixed → works again; "It
 *                    works" (queued offline), the line lead's confirmation, the technician's Seen / On my way; photos and
 *                    voice notes opened on the tablet, more added while it is under way
 *   My jobs          (technician: plant.jobs.work) the site's requests, the ones sent to me first (B-W2b-102), then the
 *                    jobs given to me or to nobody, P1 first
 *   The job          what the technician needs to fix it: the symptom, the reporters' words, the photos and voice notes,
 *                    the machine's last three jobs; Start, Wait for parts, Hand back, Take back to work; each unsafe
 *                    request behind it signs safe here with the PIN (H1)
 *   Hand back        close on one screen (B-W2b-102, QHS-190): what was done, the failure code, the time (the office's
 *                    count), before and after photos, the machine after (running only once nothing locks it)
 *
 * Never money, never a person's name. The view fetches nothing: the container (Machine.tsx) reads and maps.
 */

export type MachineStep =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'which'
      readonly station: Place | null
      readonly machines: readonly StationMachine[]
      /** Every machine at the station is do-not-use: its scans are refused until one is signed safe. */
      readonly blocked: boolean
      /** Offline: the machines as this tablet read them, with the time. */
      readonly asOf?: string | null
      /** The tag being looked up. */
      readonly reading?: string | null
      /** The last tag scanned that opened nothing. */
      readonly scanned?: { readonly code: string; readonly why: 'notFound' | 'offline' | 'unavailable' } | null
      /** B-W2b-102: the station's reports still under way (null: not read). */
      readonly requests?: readonly FloorRequest[] | null
      /** B-W2b-102: rows the live stream changed, waiting behind Show (B-W2b-28: rows never move under a finger). */
      readonly requestsPending?: number
    }
  | {
      readonly kind: 'symptom'
      readonly machine: StationMachine
      readonly draft: ReportDraft
      readonly asOf?: string | null
      /** B-W2b-102: the camera or the recorder is open in place of the screen. */
      readonly capture?: MediaKind | null
    }
  | {
      readonly kind: 'sent'
      readonly machine: Pick<FloorMachine, 'assetNumber' | 'status' | 'locked'>
      readonly symptom: string | null
      readonly unsafe: boolean
      readonly down: boolean
      readonly ticks: TickState
      /** The office refused it: its code and words (Waiting to send has the fix too). */
      readonly refusal?: { readonly code: string; readonly message: string } | null
      /** The machine as the office has it now (read again once recorded); null: not read yet. */
      readonly now?: Pick<FloorMachine, 'status' | 'locked'> | null
      /** B-W2b-102: the report the office made of it (once recorded). */
      readonly requestId?: string | null
      /** B-W2b-102: the photos and voice notes taken with it, going up once the office has it. */
      readonly uploads?: readonly MediaUpload[]
      /** B-W2b-102: the symptom also offers an incident report (Guard missing). */
      readonly incident?: boolean
    }
  | {
      readonly kind: 'request'
      readonly record: FloorRequestRecord
      readonly back: 'which' | 'jobs'
      readonly asOf?: string | null
      readonly busy?: boolean
      readonly problem?: TaskProblem | null
      readonly done?: RequestDone | null
      readonly capture?: MediaKind | null
      readonly uploading?: boolean
      readonly failed?: boolean
      readonly peek?: Peek | null
    }
  | {
      readonly kind: 'jobs'
      readonly jobs: readonly FloorJob[]
      readonly asOf?: string | null
      /** B-W2b-102: the site's open requests (the technician's queue; null: not read or not a technician). */
      readonly queue?: readonly QueueEntry[] | null
      readonly queuePending?: number
    }
  | { readonly kind: 'job'; readonly record: JobRecord; readonly asOf?: string | null; readonly busy?: boolean; readonly problem?: TaskProblem | null; readonly done?: JobDone | null; readonly peek?: Peek | null }
  | {
      readonly kind: 'handBack'
      readonly record: JobRecord
      readonly draft: CloseDraft
      /** The job's photos and voice notes (B-W2b-102): the record's, and the ones added on this screen. */
      readonly files: readonly StoredMedia[]
      readonly busy?: boolean
      readonly problem?: TaskProblem | null
      readonly capture?: CloseCapture | null
      readonly uploading?: boolean
      readonly failed?: boolean
      readonly peek?: Peek | null
    }
  | {
      readonly kind: 'sign'
      readonly record: JobRecord
      readonly request: FloorRequest
      readonly draft: SignDraft
      /** The PIN is asked (403 stepUp): the same act is sent again after it. */
      readonly pin?: boolean
      readonly pinProblem?: PinProblem
      readonly busy?: boolean
      readonly problem?: TaskProblem | null
    }
  | { readonly kind: 'problem'; readonly problem: TaskProblem; readonly code?: string | null; readonly back: 'which' | 'jobs' }

/** What the last move did (one line on the job). */
export type JobDone = 'started' | 'waiting' | 'reopened' | 'signed' | 'handedBack' | 'leadConfirmed'

export interface MachineViewModel {
  readonly frame: FrameModel
  readonly can: MachineCan
  readonly online: boolean
  readonly step: MachineStep
  /** The site's time zone. */
  readonly timeZone?: string
}

export type MachineAction =
  | { type: 'scan'; code: string }
  | { type: 'machine'; id: string }
  | { type: 'symptom'; id: string }
  | { type: 'words'; text: string }
  | { type: 'unsafe'; on: boolean }
  | { type: 'report'; down: boolean }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'another' }
  | { type: 'jobs' }
  | { type: 'job'; id: string }
  | { type: 'move'; move: Exclude<TechnicianMove, 'handBack'> }
  | { type: 'handBack' }
  | { type: 'sendHandBack' }
  | { type: 'sign'; requestId: string }
  | { type: 'safeAfter'; after: SafeAfter }
  | { type: 'sendSign' }
  | { type: 'pin'; pin: string }
  | { type: 'retry' }
  // B-W2b-102
  | { type: 'capture'; kind: MediaKind }
  | { type: 'captureCancel' }
  | { type: 'taken'; kind: MediaKind; blob: Blob }
  | { type: 'removeMedia'; id: string }
  | { type: 'retryUpload'; id: string }
  | { type: 'request'; id: string }
  | { type: 'follow' }
  | { type: 'works' }
  | { type: 'acknowledge' }
  | { type: 'onTheWay' }
  | { type: 'leadConfirm' }
  | { type: 'peekClose' }
  | { type: 'incident' }
  | { type: 'showRequests' }
  | { type: 'showQueue' }
  | CloseAction

export interface MachineViewProps {
  model: MachineViewModel
  onAction?: (action: MachineAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

export function MachineView(props: MachineViewProps) {
  return (
    <WithMessages namespaces={[REASON_KIT_NAMESPACE]}>
      <Screen {...props} />
    </WithMessages>
  )
}

/** A floor-machine word with its params; the API's words for a code this screen does not know. */
function refusalWords(t: Translate, code: string): { message: string; fix: string | null } | null {
  return isKnownRefusal(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null
}

function Screen({ model, onAction, onFrame, camera }: MachineViewProps) {
  const t = useT('floor-machine')
  const locale = useLocale()
  const send = (action: MachineAction) => onAction?.(action)
  const { step, can } = model
  const place = { locale, timeZone: model.timeZone }
  const age = (minutes: number) => {
    const parts = ageParts(minutes)
    return t(parts.key, parts.params)
  }
  const held = (key: string | null): string | null => (key ? t(key) : null)
  const words = (code: string) => refusalWords(t, code)

  let actions: FloorActions | null = null
  /** A short line at the start of the action bar (what the buttons do). */
  let start: string | null = null
  let body: ReactNode = null

  switch (step.kind) {
    case 'loading':
      body = <FloorState tone="info" icon={<Cog />} title={t('loading')} busy />
      break

    case 'which': {
      const banner = bannerOf(step.machines)
      body = (
        <div className="fw-floor-stack">
          {step.asOf ? <TaskLine tone="warning" icon={<History />}>{t('asOf', { time: formatTime(step.asOf, place) })}</TaskLine> : null}
          {banner.map((line) => (
            <TaskLine key={`${line.key}-${line.assetNumber}`} tone={line.tone} icon={line.tone === 'danger' ? <OctagonX /> : <TriangleAlert />} alert={line.tone === 'danger'}>
              {t(line.key, { machine: line.assetNumber })}
            </TaskLine>
          ))}
          {step.blocked ? <TaskLine tone="danger" icon={<Lock />}>{t('banner.blocked')}</TaskLine> : null}
          <ScanInput
            label={t('which.scan')}
            hint={can.report ? t('which.scanHint') : t('held.noReport')}
            scannedLabel={(code) => t('which.read', { code })}
            keyboardLabel={t('which.type')}
            disabled={!can.report}
            camera={camera ? { scanner: camera, startLabel: t('camera.start'), stopLabel: t('camera.stop'), errorLabel: t('camera.error') } : undefined}
            onScan={(code) => send({ type: 'scan', code })}
          />
          {step.reading ? (
            <p className="fw-floor-muted" role="status">
              {t('which.reading', { code: step.reading })}
            </p>
          ) : null}
          {step.scanned ? (
            <TaskLine tone="warning" icon={<CircleAlert />} alert>
              {t(`which.scanned.${step.scanned.why}`, { code: step.scanned.code })}
            </TaskLine>
          ) : null}
          <section className="fw-floor-section" aria-labelledby="fw-mc-station">
            <h2 id="fw-mc-station" className="fw-floor-subtitle">
              {step.station ? t('which.station', { station: `${step.station.code} · ${step.station.name}` }) : t('which.noStation')}
            </h2>
            {step.machines.length === 0 ? (
              <p className="fw-floor-lead">{step.station ? t('which.none') : t('which.noStationBody')}</p>
            ) : (
              <FloorTileGrid label={t('which.machines')}>
                {step.machines.map((machine) => {
                  const Icon = iconOf(machine.class.icon)
                  const why = machineHeld(machine)
                  return (
                    <FloorTile
                      key={machine.id}
                      icon={<Icon />}
                      label={machine.assetNumber}
                      hint={`${labelOf(machine.class, locale)} · ${t(statusKey(machine))}`}
                      tone={machine.status === 'DO_NOT_USE' ? 'danger' : machine.status === 'DOWN' ? 'warning' : 'neutral'}
                      heldReason={why ? t(why) : can.report ? null : t('held.noReport')}
                      onPress={() => send({ type: 'machine', id: machine.id })}
                    />
                  )
                })}
              </FloorTileGrid>
            )}
          </section>
          {can.report ? <StationRequests requests={step.requests ?? []} pending={step.requestsPending ?? 0} onShow={() => send({ type: 'showRequests' })} t={t} locale={locale} place={place} onOpen={(id) => send({ type: 'request', id })} /> : null}
        </div>
      )
      if (can.work) actions = [{ label: t('action.myJobs'), icon: <ClipboardList />, onPress: () => send({ type: 'jobs' }) }]
      break
    }

    case 'symptom': {
      const { machine, draft } = step
      if (step.capture) {
        body = (
          <CaptureStep
            kind={step.capture}
            title={t(step.capture === 'AUDIO' ? 'media.voiceFor' : 'media.photoFor', { machine: machine.assetNumber })}
            t={t}
            onPhoto={(blob) => send({ type: 'taken', kind: 'PHOTO', blob })}
            onVoice={(blob) => send({ type: 'taken', kind: 'AUDIO', blob })}
            onCancel={() => send({ type: 'captureCancel' })}
          />
        )
        break
      }
      const symptom = pickedSymptom(machine, draft)
      const unsafe = isUnsafe(symptom, draft)
      const asked = wordsAsked(symptom)
      const heldKey = reportHeld({ can, machine, symptom, words: draft.words })
      const mediaKey = mediaHeld({ online: model.online, count: draft.media.length })
      body = (
        <div className="fw-floor-stack">
          {step.asOf ? <TaskLine tone="warning" icon={<History />}>{t('asOf', { time: formatTime(step.asOf, place) })}</TaskLine> : null}
          <MachineCardView machine={machine} t={t} locale={locale} />
          {!model.online ? <TaskLine tone="info" icon={<ShieldCheck />}>{t('symptom.offline')}</TaskLine> : null}
          <SymptomGrid machine={machine} value={draft.symptomId} onPick={(id) => send({ type: 'symptom', id })} t={t} />
          {asked ? (
            <Field label={symptom ? t('symptom.words') : t('symptom.wordsOrPick')} required={asked} hint={t('symptom.wordsHint')} htmlFor="fw-mc-words">
              <Textarea id="fw-mc-words" value={draft.words} rows={3} limit={WORDS_MAX} maxLength={WORDS_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
            </Field>
          ) : null}
          <FloorButton
            size="lg"
            block
            variant={unsafe ? 'danger' : 'secondary'}
            icon={<Lock />}
            aria-pressed={unsafe}
            heldReason={symptom?.unsafe ? t('symptom.unsafeBySymptom') : null}
            onClick={() => send({ type: 'unsafe', on: !draft.unsafe })}
          >
            {unsafe ? t('symptom.unsafeOn') : t('symptom.unsafe')}
          </FloorButton>
          {unsafe ? (
            <TaskLine tone="danger" icon={<OctagonX />} alert>
              {t('symptom.unsafeBody', { machine: machine.assetNumber })}
            </TaskLine>
          ) : null}
          {offersIncident(symptom) ? <IncidentOffer t={t} onOpen={() => send({ type: 'incident' })} /> : null}
          <section className="fw-floor-section" aria-labelledby="fw-mc-media-title">
            <h3 id="fw-mc-media-title" className="fw-floor-subtitle">
              {t('media.optional')}
            </h3>
            <div className="fw-mc-toggles">
              <FloorButton size="lg" variant="secondary" icon={<Camera />} heldReason={held(mediaKey)} onClick={() => send({ type: 'capture', kind: 'PHOTO' })}>
                {t('media.addPhoto')}
              </FloorButton>
              <FloorButton size="lg" variant="secondary" icon={<Mic />} heldReason={held(mediaKey)} onClick={() => send({ type: 'capture', kind: 'AUDIO' })}>
                {t('media.addVoice')}
              </FloorButton>
            </div>
            <TakenList media={draft.media} t={t} onRemove={(id) => send({ type: 'removeMedia', id })} />
            {draft.media.length > 0 ? <p className="fw-floor-muted">{t('media.afterReport')}</p> : null}
          </section>
        </div>
      )
      const back: FloorAction = { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'quiet' }
      start = t('action.reportAs')
      actions = unsafe
        ? [back, { label: t('action.reportLock'), icon: <Lock />, variant: 'danger', heldReason: held(heldKey), onPress: () => send({ type: 'report', down: true }) }]
        : [
            back,
            { label: t('action.reportRuns'), icon: <Wrench />, variant: 'secondary', heldReason: held(heldKey), onPress: () => send({ type: 'report', down: false }) },
            { label: t('action.reportDown'), icon: <OctagonX />, heldReason: held(heldKey), onPress: () => send({ type: 'report', down: true }) },
          ]
      break
    }

    case 'sent': {
      const refused = step.ticks === 'refused'
      const now = step.now ?? null
      const uploads = step.uploads ?? []
      body = refused ? (
        <FloorState tone="danger" icon={<CircleAlert />} title={refusalWords(t, step.refusal?.code ?? '')?.message ?? step.refusal?.message ?? t('sent.refusedTitle')} alert>
          <p className="fw-floor-card-code">{step.machine.assetNumber}</p>
          <p className="fw-floor-state-text">{refusalWords(t, step.refusal?.code ?? '')?.fix ?? t('sent.refusedFix')}</p>
          {uploads.length > 0 ? <p className="fw-floor-state-text">{t('media.dropped')}</p> : null}
        </FloorState>
      ) : (
        <div className="fw-floor-stack">
          <FloorState tone={step.unsafe ? 'danger' : 'success'} icon={step.unsafe ? <Lock /> : <ShieldCheck />} title={t(step.unsafe ? 'sent.titleUnsafe' : 'sent.title', { machine: step.machine.assetNumber })}>
            {step.symptom ? <p className="fw-floor-state-text">{step.symptom}</p> : null}
            <p className="fw-mc-ticks">
              <Ticks state={step.ticks} />
            </p>
            <p className="fw-floor-state-text">
              {step.ticks === 'recorded'
                ? now
                  ? t('sent.now', { machine: step.machine.assetNumber, status: t(statusKey(now)) })
                  : t('sent.recorded')
                : model.online
                  ? t('sent.sending')
                  : t('sent.waits')}
            </p>
            {step.unsafe ? <p className="fw-floor-state-text">{t('sent.unsafeNext')}</p> : step.down ? <p className="fw-floor-state-text">{t('sent.downNext')}</p> : null}
          </FloorState>
          {uploads.length > 0 ? (
            <section className="fw-floor-section" aria-labelledby="fw-mc-sent-media">
              <h3 id="fw-mc-sent-media" className="fw-floor-subtitle">
                {t('media.title')}
              </h3>
              <UploadList uploads={uploads} t={t} onRetry={(id) => send({ type: 'retryUpload', id })} />
              {uploads.some((entry) => entry.state === 'waiting' || entry.state === 'sending') ? <p className="fw-floor-muted">{t('media.waitReport')}</p> : null}
            </section>
          ) : null}
          {step.incident ? <IncidentOffer t={t} onOpen={() => send({ type: 'incident' })} /> : null}
        </div>
      )
      const home: FloorAction = { label: t('action.home'), icon: <House />, variant: 'secondary', onPress: () => send({ type: 'home' }) }
      const another: FloorAction = { label: t('action.another'), icon: <ScanLine />, onPress: () => send({ type: 'another' }) }
      actions = step.requestId && !refused ? [home, { label: t('action.follow'), icon: <Footprints />, variant: 'secondary', onPress: () => send({ type: 'follow' }) }, another] : [home, another]
      break
    }

    case 'request': {
      const { record } = step
      if (step.capture) {
        body = (
          <CaptureStep
            kind={step.capture}
            title={t(step.capture === 'AUDIO' ? 'media.voiceFor' : 'media.photoFor', { machine: record.request.machine.assetNumber })}
            t={t}
            onPhoto={(blob) => send({ type: 'taken', kind: 'PHOTO', blob })}
            onVoice={(blob) => send({ type: 'taken', kind: 'AUDIO', blob })}
            onCancel={() => send({ type: 'captureCancel' })}
          />
        )
        break
      }
      body = (
        <RequestBody
          record={record}
          t={t}
          locale={locale}
          place={place}
          online={model.online}
          canReport={can.report}
          done={step.done ?? null}
          problem={step.problem ?? null}
          busy={step.busy}
          uploading={step.uploading}
          failed={step.failed}
          asOf={step.asOf ?? null}
          refusalWords={words}
          onOpen={(file) => send({ type: 'open', file })}
          onAdd={(kind) => send({ type: 'capture', kind })}
        />
      )
      const list: FloorAction[] = [{ label: t('action.back'), icon: <ArrowLeft />, variant: 'quiet', onPress: () => send({ type: 'back' }) }]
      let mainHeld: string | null = null
      if (can.work && (record.canAcknowledge || record.canGo)) {
        if (record.canAcknowledge) list.push({ label: t('action.acknowledge'), icon: <BadgeCheck />, variant: 'secondary', heldReason: held(techHeld(record.canAcknowledge, can.work, step.busy)), onPress: () => send({ type: 'acknowledge' }) })
        mainHeld = held(techHeld(record.canGo, can.work, step.busy))
        list.push({ label: t('action.onTheWay'), icon: <Footprints />, heldReason: mainHeld, onPress: () => send({ type: 'onTheWay' }) })
      } else {
        if (leadOffered(record.request, can.lead)) list.push({ label: t('action.leadConfirm'), icon: <ShieldCheck />, variant: 'secondary', heldReason: held(leadHeld(model.online, step.busy)), onPress: () => send({ type: 'leadConfirm' }) })
        mainHeld = held(worksHeld(record.request, can.report, step.busy))
        list.push({ label: t('action.works'), icon: <ThumbsUp />, variant: 'success', heldReason: mainHeld, onPress: () => send({ type: 'works' }) })
      }
      // A held main action says why on screen too (a gloved hand gets no tooltip).
      start = mainHeld
      actions = list as unknown as FloorActions
      break
    }

    case 'jobs': {
      body = (
        <div className="fw-floor-stack">
          {step.asOf ? <TaskLine tone="warning" icon={<History />}>{t('asOf', { time: formatTime(step.asOf, place) })}</TaskLine> : null}
          {step.queue ? <QueueList entries={step.queue} pending={step.queuePending ?? 0} onShow={() => send({ type: 'showQueue' })} t={t} locale={locale} place={place} onOpen={(id) => send({ type: 'request', id })} /> : null}
          <h2 className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <ClipboardList />
            </span>
            {t('jobs.title')}
          </h2>
          {step.jobs.length === 0 ? (
            <FloorState tone="success" icon={<Sparkles />} title={t('jobs.empty')} text={t('jobs.emptyBody')} />
          ) : (
            <>
              <FloorList label={t('jobs.title')}>
                {step.jobs.map((job) => {
                  const Icon = iconOf(job.symptom?.icon ?? null)
                  return (
                    <FloorListRow
                      key={job.id}
                      icon={job.machine.locked ? <Lock /> : <Icon />}
                      tone={priorityTone(job)}
                      title={
                        <span>
                          <span className="fw-floor-code">{job.machine.assetNumber}</span> · {job.symptom ? labelOf(job.symptom, locale) : labelOf(job.machine.class, locale)}
                        </span>
                      }
                      meta={[job.number, t(`jobStatus.${job.status}`), t(`priority.${job.priority}`), job.machine.line?.code ?? job.machine.station?.code ?? null, job.machine.locked ? t('status.LOCKED') : null, job.ownership === 'NOBODY' ? t('jobs.nobody') : null].filter(Boolean).join(' · ')}
                      status={t('jobs.waiting', { age: age(job.ageMinutes) })}
                      onPress={() => send({ type: 'job', id: job.id })}
                    />
                  )
                })}
              </FloorList>
              <ListFooter
                count={t('jobs.count', { count: step.jobs.length })}
                keys={[
                  { key: 'Tab', does: t('keys.next') },
                  { key: '↵', does: t('keys.open') },
                  { key: 'Esc', does: t('keys.back') },
                ]}
              />
            </>
          )}
        </div>
      )
      actions = can.report ? [{ label: t('action.report'), icon: <Wrench />, onPress: () => send({ type: 'another' }) }] : null
      break
    }

    case 'job': {
      const { record } = step
      const job = record.job
      const moveWhy = moveHeld(job, can, model.online, step.busy)
      const moves = movesOf(job)
      const locking = lockingRequests(record)
      body = (
        <div className="fw-floor-stack">
          {step.asOf ? <TaskLine tone="warning" icon={<History />}>{t('asOf', { time: formatTime(step.asOf, place) })}</TaskLine> : null}
          {step.done ? <TaskLine tone="success" icon={<ShieldCheck />}>{t(`done.${step.done}`, { job: job.number, machine: job.machine.assetNumber })}</TaskLine> : null}
          {step.problem ? <ProblemState problem={step.problem} words={words} /> : null}
          {!model.online ? <HeldLine text={t('held.offline')} /> : null}
          {job.ownership === 'OTHER' ? <TaskLine tone="warning" icon={<CircleAlert />}>{t('job.notYours')}</TaskLine> : null}
          {locking.length > 0 ? (
            <section className="fw-floor-section fw-mc-locks" aria-labelledby="fw-mc-locks">
              <h2 id="fw-mc-locks" className="fw-floor-subtitle">
                {t('job.locksTitle', { machine: job.machine.assetNumber })}
              </h2>
              {locking.map((request) => (
                <div key={request.id} className="fw-mc-lock">
                  <span className="fw-mc-lock-text">
                    <span className="fw-floor-inline-icon" aria-hidden="true">
                      <Lock />
                    </span>
                    {t('job.lock', { symptom: request.symptom ? labelOf(request.symptom, locale) : (request.description ?? t('job.noSymptom')), time: formatTime(request.reportedAt, place) })}
                  </span>
                  <FloorButton size="md" variant="danger" icon={<ShieldCheck />} heldReason={can.signSafe ? (!model.online ? t('held.offline') : step.busy ? t('held.busy') : null) : t('held.noSign')} onClick={() => send({ type: 'sign', requestId: request.id })}>
                    {t('action.signSafe')}
                  </FloorButton>
                </div>
              ))}
            </section>
          ) : null}
          <JobCard record={record} t={t} locale={locale} place={place} age={age} />
          <section className="fw-floor-section" aria-labelledby="fw-mc-job-media">
            <h2 id="fw-mc-job-media" className="fw-floor-subtitle">
              {t('media.title')}
            </h2>
            <StoredList files={[...record.requestFiles, ...record.files]} t={t} place={place} online={model.online} onOpen={(file) => send({ type: 'open', file })} />
          </section>
        </div>
      )
      const list: FloorAction[] = [{ label: t('action.back'), icon: <ArrowLeft />, variant: 'quiet', onPress: () => send({ type: 'jobs' }) }]
      for (const move of moves) {
        if (move === 'handBack') list.push({ label: t('action.handBack'), icon: <Undo2 />, heldReason: held(moveWhy), onPress: () => send({ type: 'handBack' }) })
        else list.push({ label: t(`action.${move}`), icon: move === 'wait' ? <Hammer /> : move === 'reopen' ? <RotateCcw /> : <Play />, variant: move === 'wait' ? 'secondary' : undefined, heldReason: held(moveWhy), onPress: () => send({ type: 'move', move }) })
      }
      if (record.canConfirm) list.push({ label: t('action.leadConfirm'), icon: <ShieldCheck />, variant: 'success', heldReason: held(leadHeld(model.online, step.busy)), onPress: () => send({ type: 'leadConfirm' }) })
      actions = (list.length > 3 ? [list[0]!, ...list.slice(-2)] : list) as unknown as FloorActions
      break
    }

    case 'handBack': {
      const { record, draft } = step
      if (step.capture) {
        const capture = step.capture
        body = (
          <CaptureStep
            kind={capture.kind}
            title={t(capture.kind === 'AUDIO' ? 'media.voiceFor' : capture.category === 'BEFORE_WORK' ? 'close.photoBeforeFor' : 'close.photoAfterFor', { machine: record.job.machine.assetNumber })}
            t={t}
            onPhoto={(blob) => send({ type: 'taken', kind: 'PHOTO', blob })}
            onVoice={(blob) => send({ type: 'taken', kind: 'AUDIO', blob })}
            onCancel={() => send({ type: 'captureCancel' })}
          />
        )
        break
      }
      const why = closeHeld(draft, record.job.machine, model.online, step.busy || step.uploading)
      body = (
        <CloseBody
          record={record}
          draft={draft}
          files={step.files}
          online={model.online}
          busy={step.busy}
          uploading={step.uploading}
          failed={step.failed}
          problem={step.problem ?? null}
          t={t}
          locale={locale}
          place={place}
          age={age}
          refusalWords={words}
          send={send}
        />
      )
      start = held(why)
      actions = [
        { label: t('action.back'), icon: <ArrowLeft />, variant: 'quiet', onPress: () => send({ type: 'back' }) },
        { label: t('action.handBack'), icon: <Undo2 />, heldReason: held(why), onPress: () => send({ type: 'sendHandBack' }) },
      ]
      break
    }

    case 'sign': {
      const { record, request, draft } = step
      const machine = record.job.machine
      const why = signHeld(draft, can, model.online, step.busy)
      const summary = (
        <p className="fw-floor-lead">
          {t('sign.what', { machine: machine.assetNumber, symptom: request.symptom ? labelOf(request.symptom, locale) : (request.description ?? t('job.noSymptom')) })}
        </p>
      )
      body = step.pin ? (
        <PinSign title={t('sign.pinTitle', { machine: machine.assetNumber })} meaning={t('sign.meaning')} summary={summary} onPin={(pin) => send({ type: 'pin', pin })} busy={step.busy} problem={step.pinProblem ?? null} />
      ) : (
        <div className="fw-floor-stack">
          {step.problem ? <ProblemState problem={step.problem} words={words} /> : null}
          <h2 className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <ShieldCheck />
            </span>
            {t('sign.title', { machine: machine.assetNumber })}
          </h2>
          {summary}
          {!model.online ? <HeldLine text={t('held.offline')} /> : null}
          <Field label={t('sign.checked')} required hint={t('sign.checkedHint')} htmlFor="fw-mc-checked">
            <Textarea id="fw-mc-checked" value={draft.words} rows={3} limit={NOTE_MAX} maxLength={NOTE_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
          </Field>
          <section className="fw-floor-section" aria-labelledby="fw-mc-safe-after">
            <h3 id="fw-mc-safe-after" className="fw-floor-subtitle">
              {t('sign.after')}
            </h3>
            <div className="fw-mc-after" role="group" aria-labelledby="fw-mc-safe-after">
              {(['RUNNING', 'UNDER_MAINTENANCE'] as const).map((after) => (
                <FloorButton key={after} size="lg" block variant={draft.after === after ? 'success' : 'secondary'} aria-pressed={draft.after === after} onClick={() => send({ type: 'safeAfter', after })}>
                  {t(`safeAfter.${after}`)}
                </FloorButton>
              ))}
            </div>
          </section>
          <p className="fw-floor-muted">{t('sign.law')}</p>
        </div>
      )
      actions = step.pin
        ? [{ label: t('action.back'), icon: <ArrowLeft />, variant: 'quiet', onPress: () => send({ type: 'back' }) }]
        : [
            { label: t('action.back'), icon: <ArrowLeft />, variant: 'quiet', onPress: () => send({ type: 'back' }) },
            { label: t('action.signSafe'), icon: <ShieldCheck />, variant: 'danger', heldReason: held(why), onPress: () => send({ type: 'sendSign' }) },
          ]
      break
    }

    case 'problem':
      body = <ProblemState problem={step.problem} code={step.code ?? null} words={words} />
      actions = [
        { label: t('action.back'), icon: <ArrowLeft />, variant: 'secondary', onPress: () => send({ type: 'back' }) },
        { label: t('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) },
      ]
      break
  }

  const peek = 'peek' in step ? (step.peek ?? null) : null
  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} start={start ?? undefined} /> : undefined}>
      <div className="fw-mc">{body}</div>
      <PeekDialog peek={peek} t={t} onClose={() => send({ type: 'peekClose' })} />
    </FloorFrameView>
  )
}

// ---- the machine's card -------------------------------------------------------------------------------------------------

function MachineCardView({ machine, t, locale }: { machine: FloorMachine; t: Translate; locale: 'it' | 'en' }) {
  const Icon = iconOf(machine.class.icon)
  return (
    <TaskCard
      id="fw-mc-machine"
      icon={<Icon />}
      type={labelOf(machine.class, locale)}
      code={machine.assetNumber}
      status={t(statusKey(machine))}
      statusTone={MACHINE_TONE[machine.status]}
      facts={[
        { label: t('fact.makeModel'), value: [machine.make, machine.modelName].filter(Boolean).join(' ') || '—' },
        { label: t('fact.station'), value: machine.station ? `${machine.station.code} · ${machine.station.name}` : '—' },
        { label: t('fact.line'), value: machine.line ? machine.line.code : '—' },
        { label: t('fact.openJobs'), value: String(machine.openJobs) },
        { label: t('fact.openRequests'), value: String(machine.openRequests) },
      ]}
      flags={
        machine.status === 'DO_NOT_USE' ? (
          <TaskLine tone="danger" icon={<OctagonX />}>
            {t(machine.locked ? 'banner.locked' : 'banner.doNotUse', { machine: machine.assetNumber })}
          </TaskLine>
        ) : null
      }
    />
  )
}

// ---- the symptom tiles (DS ReasonGrid D20) ---------------------------------------------------------------------------------

function SymptomGrid({ machine, value, onPick, t }: { machine: StationMachine; value: string | null; onPick: (id: string) => void; t: Translate }) {
  const locale = useLocale()
  const words = useReasonWords()
  const tiles = useMemo<ReasonTile[]>(
    () =>
      symptomTiles(machine.symptoms, locale).map((tile) => {
        const Icon = iconOf(tile.icon)
        return { id: tile.id, label: tile.label, hint: tile.unsafe ? t('symptom.locks') : tile.needsDetail ? t('symptom.saysWords') : undefined, icon: <Icon />, tone: tile.unsafe ? 'danger' : 'neutral' }
      }),
    [machine.symptoms, locale, t],
  )
  if (tiles.length === 0) return <TaskLine tone="info" icon={<ListChecks />}>{t('symptom.none')}</TaskLine>
  return <ReasonGrid label={t('symptom.title')} reasons={tiles} value={value} onChange={(id) => onPick(id)} words={words} locale={INTL_LOCALE[locale]} />
}

// ---- the job's card ---------------------------------------------------------------------------------------------------------

function JobCard({ record, t, locale, place, age }: { record: JobRecord; t: Translate; locale: 'it' | 'en'; place: { locale: 'it' | 'en'; timeZone?: string }; age: (minutes: number) => string }) {
  const { job, card, requests } = record
  const Icon = iconOf(job.symptom?.icon ?? job.machine.class.icon)
  const reporters = reporterWords(requests)
  const status: MachineStatus = job.machine.status
  const beyond = problemBeyond(job)
  return (
    <TaskCard
      id="fw-mc-job"
      icon={<Icon />}
      type={t('job.type', { number: job.number, type: t(`jobType.${job.type}`) })}
      code={job.machine.assetNumber}
      status={t(`jobStatus.${job.status}`)}
      statusTone={job.status === 'IN_PROGRESS' ? 'info' : job.status === 'WAITING_PARTS' ? 'warning' : job.status === 'HANDED_BACK' ? 'success' : 'neutral'}
      flags={
        <>
          <TaskLine tone={MACHINE_TONE[status] === 'success' ? 'success' : MACHINE_TONE[status] === 'danger' ? 'danger' : MACHINE_TONE[status] === 'warning' ? 'warning' : 'info'} icon={job.machine.locked ? <Lock /> : <Cog />}>
            {t('job.machineNow', { machine: job.machine.assetNumber, status: t(statusKey(job.machine)) })}
          </TaskLine>
          {job.leadConfirmed ? (
            <TaskLine tone="success" icon={<BadgeCheck />}>
              {t('job.leadConfirmed', { time: formatTime(job.leadConfirmed.at, place) })}
            </TaskLine>
          ) : null}
        </>
      }
      facts={[
        { label: t('fact.symptom'), value: job.symptom ? labelOf(job.symptom, locale) : t('job.noSymptom') },
        ...(beyond ? [{ label: t('fact.problem'), value: beyond }] : []),
        { label: t('fact.reporters'), value: reporters.length > 0 ? reporters.join(' · ') : '—' },
        { label: t('fact.priority'), value: `${t(`priority.${job.priority}`)}${job.overdue ? ` · ${t('job.overdue')}` : ''}` },
        { label: t('fact.waiting'), value: age(job.ageMinutes) },
        { label: t('fact.where'), value: [job.machine.line?.code, job.machine.station ? `${job.machine.station.code} · ${job.machine.station.name}` : null].filter(Boolean).join(' · ') || '—' },
        ...(job.handedBack?.minutesSpent != null ? [{ label: t('fact.timeSpent'), value: age(job.handedBack.minutesSpent) }] : []),
      ]}
    >
      <section className="fw-floor-section" aria-labelledby="fw-mc-last">
        <h3 id="fw-mc-last" className="fw-floor-subtitle">
          {t('job.last')}
        </h3>
        {card.lastJobs.filter((entry) => entry.id !== job.id).length === 0 ? (
          <p className="fw-floor-muted">{t('job.lastNone')}</p>
        ) : (
          <ul className="fw-mc-last">
            {card.lastJobs
              .filter((entry) => entry.id !== job.id)
              .slice(0, 3)
              .map((entry) => (
                <li key={entry.id}>
                  <span>
                    <span className="fw-floor-code">{entry.number}</span> · {formatDate(entry.createdAt, place)} · {t(`jobType.${entry.type}`)} · {t(`jobStatus.${entry.status}`)}
                  </span>
                  <span className="fw-mc-last-problem">{entry.problem}</span>
                </li>
              ))}
          </ul>
        )}
        {card.repeatFailure ? <TaskLine tone="warning" icon={<TriangleAlert />}>{t('job.repeat', { count: card.requestsIn30Days })}</TaskLine> : null}
      </section>
    </TaskCard>
  )
}
