'use client'

import { BadgeCheck, CircleAlert, CloudOff, ImagePlus, Lock, Mic, OctagonX, Send, Siren, TriangleAlert } from 'lucide-react'
import { FloorButton, FloorList, FloorListRow } from '@nexus/ui/floor'
import { FloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { formatTime } from '../../../../lib/i18n/format'
import { Timeline, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { iconOf } from '../../../../lib/plant/symptom-icons'
import { ListFooter, ProblemState, TaskCard, TaskLine } from '../../shared/view/TaskParts'
import type { TaskProblem } from '../../shared/task-api'
import type { FloorRequest, FloorRequestRecord, QueueEntry, StoredMedia } from '../api'
import { mediaHeld, progressRows, progressTone, queueOrder, stationOrder } from '../depth'
import { labelOf, MACHINE_TONE, statusKey } from '../model'
import { StoredList, type Place } from './MediaParts'

/**
 * What follows a machine report on the floor (B-W2b-102; design floor.machine "Progress": "Acknowledged → on the way →
 * fixed; the requester confirms 'It works'", QHS-180; "Live: job acknowledged or fixed → the station sees it"):
 *
 *   Reported here     the station's reports still under way, the ones waiting for "It works" first (a section of
 *                     "Which machine?"; a row opens the report)
 *   Requests          the technician's queue: the site's open requests, the ones sent to me first (a section of My jobs)
 *   The report        its timeline (the DS Timeline at floor size), why "It works" waits (locked, not fixed yet), its photos
 *                     and voice notes (opened on the tablet), Add a photo / Add a voice note while it is under way
 *
 * People as kinds only: nobody's name, ever.
 */

/** What a report row says: the machine's tag and the symptom (or the reporter's words). */
const requestTitle = (request: Pick<FloorRequest, 'machine' | 'symptom' | 'description'>, locale: 'it' | 'en', t: Translate) => (
  <span>
    <span className="fw-floor-code">{request.machine.assetNumber}</span> · {request.symptom ? labelOf(request.symptom, locale) : (request.description ?? t('job.noSymptom'))}
  </span>
)

const requestIcon = (request: Pick<FloorRequest, 'locking' | 'symptom'>) => {
  const Icon = iconOf(request.symptom?.icon ?? null)
  return request.locking ? <Lock /> : <Icon />
}

// ---- Reported here (the station) ----------------------------------------------------------------------------------------

/** The list's "List changed · Show" (B-W2b-28), drawn only while rows wait. */
function Updates({ pending, onShow }: { pending: number; onShow: () => void }) {
  const ds = useDsWords()
  return pending > 0 ? <FloorListUpdates pending={pending} onShow={onShow} labels={ds.floorListUpdates} /> : null
}

export function StationRequests({ requests, pending, onShow, t, locale, place, onOpen }: { requests: readonly FloorRequest[]; pending: number; onShow: () => void; t: Translate; locale: 'it' | 'en'; place: Place; onOpen: (id: string) => void }) {
  if (requests.length === 0) return null
  return (
    <section className="fw-floor-section" aria-labelledby="fw-mc-reported">
      <h2 id="fw-mc-reported" className="fw-floor-subtitle">
        {t('reported.title')}
      </h2>
      <FloorList label={t('reported.title')} updates={pending > 0 ? <Updates pending={pending} onShow={onShow} /> : undefined}>
        {stationOrder(requests).map((request) => (
          <FloorListRow
            key={request.id}
            icon={requestIcon(request)}
            tone={progressTone(request)}
            title={requestTitle(request, locale, t)}
            meta={t('reported.at', { time: formatTime(request.reportedAt, place) })}
            status={request.locking ? t('status.LOCKED') : t(`progress.row.${request.progress.step}`)}
            onPress={() => onOpen(request.id)}
          />
        ))}
      </FloorList>
      <ListFooter
        count={t('reported.count', { count: requests.length })}
        keys={[
          { key: 'Tab', does: t('keys.nextReport') },
          { key: '↵', does: t('keys.openReport') },
        ]}
      />
    </section>
  )
}

// ---- Requests (the technician's queue) ----------------------------------------------------------------------------------

export function QueueList({ entries, pending, onShow, t, locale, place, onOpen }: { entries: readonly QueueEntry[]; pending: number; onShow: () => void; t: Translate; locale: 'it' | 'en'; place: Place; onOpen: (id: string) => void }) {
  return (
    <section className="fw-floor-section" aria-labelledby="fw-mc-queue">
      <h2 id="fw-mc-queue" className="fw-floor-section-title">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <Siren />
        </span>
        {t('queue.title')}
      </h2>
      {entries.length === 0 ? (
        <p className="fw-floor-muted">{t('queue.empty')}</p>
      ) : (
        <FloorList label={t('queue.title')} updates={pending > 0 ? <Updates pending={pending} onShow={onShow} /> : undefined}>
          {queueOrder(entries).map(({ request, toMe }) => (
            <FloorListRow
              key={request.id}
              icon={requestIcon(request)}
              tone={request.locking ? 'danger' : toMe ? 'warning' : 'neutral'}
              title={requestTitle(request, locale, t)}
              meta={[request.station?.code ?? null, t('reported.at', { time: formatTime(request.reportedAt, place) }), toMe ? t('queue.toMe') : null, request.routing.escalationLevel > 0 ? t('queue.escalated') : null].filter(Boolean).join(' · ')}
              status={request.locking ? t('status.LOCKED') : t(`progress.row.${request.progress.step}`)}
              onPress={() => onOpen(request.id)}
            />
          ))}
        </FloorList>
      )}
      {entries.length > 0 ? (
        <ListFooter
          count={t('queue.count', { count: entries.length })}
          keys={[
            { key: 'Tab', does: t('keys.nextReport') },
            { key: '↵', does: t('keys.openReport') },
          ]}
        />
      ) : null}
    </section>
  )
}

// ---- the report ----------------------------------------------------------------------------------------------------------

/** What the last step on the report did (one line). */
export type RequestDone = 'works' | 'acknowledged' | 'onTheWay' | 'leadConfirmed' | 'added' | 'kept'

export interface RequestBodyProps {
  readonly record: FloorRequestRecord
  readonly t: Translate
  readonly locale: 'it' | 'en'
  readonly place: Place
  readonly online: boolean
  readonly canReport: boolean
  readonly done?: RequestDone | null
  readonly problem?: TaskProblem | null
  readonly busy?: boolean
  readonly uploading?: boolean
  readonly failed?: boolean
  readonly asOf?: string | null
  readonly refusalWords: (code: string) => { message: string; fix: string | null } | null
  readonly onOpen: (file: StoredMedia) => void
  readonly onAdd: (kind: 'PHOTO' | 'AUDIO') => void
}

export function RequestBody({ record, t, locale, place, online, canReport, done, problem, busy, uploading, failed, asOf, refusalWords, onOpen, onAdd }: RequestBodyProps) {
  const { request } = record
  const machine = request.machine
  const Icon = iconOf(request.symptom?.icon ?? machine.class.icon)
  const closedForFiles = request.status === 'MERGED' || request.status === 'CLOSED'
  const addHeld = !canReport ? t('held.noReport') : closedForFiles ? t('held.mediaClosed') : (() => {
    const key = mediaHeld({ online, count: 0, busy: uploading || busy })
    return key ? t(key) : null
  })()
  return (
    <div className="fw-floor-stack">
      {asOf ? <TaskLine tone="warning" icon={<CloudOff />}>{t('asOf', { time: formatTime(asOf, place) })}</TaskLine> : null}
      {done ? <TaskLine tone="success" icon={<BadgeCheck />}>{t(`done.request.${done}`, { machine: machine.assetNumber, job: request.job?.number ?? '' })}</TaskLine> : null}
      {problem ? <ProblemState problem={problem} words={refusalWords} /> : null}
      {!online ? <TaskLine tone="info" icon={<CloudOff />}>{t('request.offline')}</TaskLine> : null}
      <TaskCard
        id="fw-mc-request"
        icon={<Icon />}
        type={t('request.type', { time: formatTime(request.reportedAt, place) })}
        code={machine.assetNumber}
        status={request.locking ? t('status.LOCKED') : t(`progress.row.${request.progress.step}`)}
        statusTone={request.locking ? 'danger' : progressTone(request) === 'success' ? 'success' : progressTone(request) === 'info' ? 'info' : 'neutral'}
        facts={[
          { label: t('fact.symptom'), value: request.symptom ? labelOf(request.symptom, locale) : t('job.noSymptom') },
          ...(request.description ? [{ label: t('fact.words'), value: request.description }] : []),
          { label: t('fact.machineNow'), value: t(statusKey({ status: machine.status, locked: request.locking })) },
          { label: t('fact.where'), value: request.station ? `${request.station.code} · ${request.station.name}` : '—' },
          ...(request.job ? [{ label: t('fact.job'), value: `${request.job.number} · ${t(`jobStatus.${request.job.status}`)}` }] : []),
        ]}
        flags={
          request.locking ? (
            <TaskLine tone="danger" icon={<OctagonX />}>
              {t('progress.locked', { machine: machine.assetNumber })}
            </TaskLine>
          ) : MACHINE_TONE[machine.status] === 'warning' ? (
            <TaskLine tone="warning" icon={<TriangleAlert />}>
              {t('job.machineNow', { machine: machine.assetNumber, status: t(statusKey({ status: machine.status, locked: false })) })}
            </TaskLine>
          ) : null
        }
      />
      {request.status === 'MERGED' ? <TaskLine tone="info" icon={<CircleAlert />}>{t('progress.merged', { machine: machine.assetNumber })}</TaskLine> : null}
      {request.progress.closedWithoutJob ? <TaskLine tone="info" icon={<CircleAlert />}>{t('progress.closed')}</TaskLine> : null}
      {request.progress.step === 'REPORTED' && request.routing.escalationLevel > 0 ? <TaskLine tone="warning" icon={<Send />}>{t('progress.escalated')}</TaskLine> : null}
      {request.progress.canConfirm ? (
        <TaskLine tone="success" icon={<BadgeCheck />} alert>
          {t('progress.askWorks', { machine: machine.assetNumber })}
        </TaskLine>
      ) : null}
      <section className="fw-floor-section" aria-labelledby="fw-mc-progress">
        <h2 id="fw-mc-progress" className="fw-floor-subtitle">
          {t('progress.title')}
        </h2>
        <Timeline
          className="fw-mc-progress"
          label={t('progress.title')}
          steps={progressRows(request).map((row) => ({
            key: row.key,
            label: t(`progress.step.${row.key}`),
            tone: row.at ? (row.key === 'CLOSED' ? 'neutral' : 'success') : 'neutral',
            at: row.at,
            ...(row.key === 'REPORTED' && request.routing.routedTo ? { detail: t(`progress.routed.${request.routing.routedTo.kind}`) } : {}),
          }))}
        />
      </section>
      <section className="fw-floor-section" aria-labelledby="fw-mc-request-media">
        <h2 id="fw-mc-request-media" className="fw-floor-subtitle">
          {t('media.title')}
        </h2>
        <StoredList files={record.files} t={t} place={place} online={online} onOpen={onOpen} />
        {uploading ? (
          <p className="fw-floor-muted" role="status" aria-busy="true">
            {t('media.uploading')}
          </p>
        ) : null}
        {failed ? (
          <TaskLine tone="danger" icon={<CircleAlert />} alert>
            {t('media.failed')}
          </TaskLine>
        ) : null}
        <div className="fw-mc-toggles">
          <FloorButton size="lg" variant="secondary" icon={<ImagePlus />} heldReason={addHeld} onClick={() => onAdd('PHOTO')}>
            {t('media.addPhoto')}
          </FloorButton>
          <FloorButton size="lg" variant="secondary" icon={<Mic />} heldReason={addHeld} onClick={() => onAdd('AUDIO')}>
            {t('media.addVoice')}
          </FloorButton>
        </div>
      </section>
    </div>
  )
}

// ---- "Guard missing also offers Report an incident" (B-W2b-137) -------------------------------------------------------------

/** Opens Report an incident (SCR-230) with this machine passed on. */
export function IncidentOffer({ t, onOpen }: { t: Translate; onOpen: () => void }) {
  return (
    <div className="fw-mc-incident">
      <FloorButton size="lg" variant="secondary" icon={<TriangleAlert />} onClick={onOpen}>
        {t('action.incident')}
      </FloorButton>
    </div>
  )
}
