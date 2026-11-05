'use client'

import { useMemo, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CircleAlert,
  CloudOff,
  Construction,
  Eye,
  EyeOff,
  History,
  House,
  MapPin,
  MessageSquareText,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Siren,
  ToggleLeft,
  ToggleRight,
  TriangleAlert,
  UserRound,
  Cog,
  LayoutGrid,
  X,
} from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { Input } from '@nexus/ui/primitives'
import { FloorActionBar, FloorButton, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { FloorNamePicker } from '@nexus/ui/floor/FloorNamePicker/index'
import type { ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import type { IncidentKind } from '@nexus/factory-domain/safety/incidents/rules'
import { REASON_KIT_NAMESPACE } from '../../../../lib/ds-words/reason-grid'
import { formatTime } from '../../../../lib/i18n/format'
import { Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { WithMessages } from '../../../../record-panels/i18n'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { CaptureStep, TakenList, UploadList } from '../../machine/view/MediaParts'
import type { TaskProblem } from '../../shared/task-api'
import { TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import { isKnownRefusal, KINDS, mayGoWithoutName, NAME_MAX, peopleAsked, personHeld, photoHeld, PHOTO_MINUTES, PHOTOS_MAX, PLACE_MAX, sendHeld, whereId, WORDS_MAX, type IncidentDraft, type PhotoUpload, type Stage, type WherePick } from '../model'
import { EmergencyBanner, EmergencyLine, PeopleSection, PickStep, RefusalLine, type EmergencyAction, type EmergencyModel, type PeopleAction } from './IncidentParts'
import '../../machine/machine.css'
import '../incident.css'

/**
 * SCR-230 — Floor › Report an incident (B-W2b-137; design floor.incident, QHS-265; on the merged API of B-W2b-125): one job per
 * screen inside the floor frame, tablet first, centred. Someone hurt comes FIRST.
 *
 *   What happened?   the emergency before anything else ("Someone badly hurt? Call 112 first", the site's first aiders, the call
 *                    for help in one tap), then the three tiles: Incident (someone hurt) · Near miss · Hazard (DS ReasonGrid)
 *   Where?           "Here: this station" first, this station's machines, the site's areas, somewhere else in a few words
 *   Photo and people optional: a photo ("no faces", up to 4; it needs the network), the people of an incident (me, another worker
 *                    of this tablet by name, someone from outside), a few words; a near miss or a hazard may go without the
 *                    name ("Your name is not stored with this report"); Send (main)
 *   Sent             saved on this tablet first (with the name) and the two ticks, or sent at once (without it); the number;
 *                    "Seen by safety at 10:45" (live, and read again while in view); the photos going up
 *   Not sent yet     a report without a name with no network: it waits on this screen (never kept on the tablet) and goes
 *                    when the network is back; or it goes with the name, saved on the tablet
 *
 * Three taps on the usual path: Hazard → Here → Send. Never money; the injury itself is the office's (GDPR art. 9). The view
 * fetches nothing: the container (Incident.tsx) reads and maps.
 */

export interface StationRef {
  readonly code: string
  readonly name: string
}

export type IncidentStep =
  | {
      readonly kind: 'report'
      readonly stage: Stage
      readonly draft: IncidentDraft
      readonly where: readonly WherePick[]
      readonly station: StationRef | null
      /** The kinds that may go without a name (the API's start, else factory-domain's). */
      readonly anonymousKinds: readonly IncidentKind[]
      /** The areas and machines as this tablet read them earlier (offline), with the time. */
      readonly asOf?: string | null
      /** The person signed in (the "Me" row). */
      readonly me: { readonly id: string; readonly name: string }
      /** This tablet's workers to pick another worker from (names, as sign-in by name shows them). */
      readonly roster: readonly { readonly id: string; readonly name: string }[]
      /** The camera, the name picker or the outside name's field is open in place of the step. */
      readonly open?: 'photo' | 'worker' | 'outside' | null
      readonly outsideName?: string
      readonly busy?: boolean
      readonly problem?: TaskProblem | null
    }
  | {
      readonly kind: 'held'
      readonly draft: IncidentDraft
      /** Why it did not go: no network, or the office did not answer. */
      readonly why: 'offline' | 'unavailable'
      readonly busy?: boolean
      readonly problem?: TaskProblem | null
    }
  | {
      readonly kind: 'sent'
      readonly report: SentReport
      readonly capture?: boolean
    }

export interface SentReport {
  readonly kind: IncidentKind
  readonly anonymous: boolean
  /** Saved on this tablet, being sent, recorded, refused (a report without a name is recorded once answered). */
  readonly ticks: TickState
  readonly refusal?: { readonly code: string; readonly message: string } | null
  /** The office's number, once it has the report. */
  readonly number: string | null
  readonly seenAt: string | null
  readonly closed?: boolean
  readonly uploads: readonly PhotoUpload[]
  /** Why another photo cannot be added now (a key), or null. */
  readonly photoHeld: string | null
  readonly where: WherePick | null
  readonly place?: string
}

export interface IncidentViewModel {
  readonly frame: FrameModel
  readonly online: boolean
  readonly step: IncidentStep
  readonly emergency: EmergencyModel
  readonly timeZone?: string
}

export type IncidentAction =
  | { readonly type: 'kind'; readonly kind: IncidentKind; readonly advance: boolean }
  | { readonly type: 'where'; readonly id: string; readonly advance: boolean }
  | { readonly type: 'place'; readonly text: string }
  | { readonly type: 'next' }
  | { readonly type: 'back' }
  | { readonly type: 'home' }
  | { readonly type: 'send' }
  | { readonly type: 'withoutName'; readonly on: boolean }
  | { readonly type: 'openWords' }
  | { readonly type: 'words'; readonly text: string }
  | { readonly type: 'capture' }
  | { readonly type: 'taken'; readonly blob: Blob }
  | { readonly type: 'captureCancel' }
  | { readonly type: 'removePhoto'; readonly id: string }
  | { readonly type: 'retryUpload'; readonly id: string }
  | { readonly type: 'pickWorker'; readonly workerId: string }
  | { readonly type: 'outsideName'; readonly text: string }
  | { readonly type: 'addOutsideName' }
  | { readonly type: 'closeOpen' }
  | { readonly type: 'withName' }
  | { readonly type: 'retry' }
  | { readonly type: 'discard' }
  | { readonly type: 'another' }
  | EmergencyAction
  | PeopleAction

export interface IncidentViewProps {
  model: IncidentViewModel
  onAction?: (action: IncidentAction) => void
  onFrame?: (action: FrameAction) => void
}

export function IncidentView(props: IncidentViewProps) {
  return (
    <WithMessages namespaces={[REASON_KIT_NAMESPACE]}>
      <Screen {...props} />
    </WithMessages>
  )
}

const KIND_ICON: Readonly<Record<IncidentKind, ReactNode>> = { INJURY: <Siren />, NEAR_MISS: <TriangleAlert />, HAZARD: <Construction /> }
const KIND_TONE = { INJURY: 'danger', NEAR_MISS: 'warning', HAZARD: 'warning' } as const

/** Where it happened in words (the tile's label and its second line). */
export function whereWords(where: WherePick, t: Translate, station: StationRef | null, place = ''): { label: string; hint?: string } {
  switch (where.kind) {
    case 'here':
      return { label: t('where.here'), hint: station ? `${station.code} · ${station.name}` : undefined }
    case 'machine':
      return { label: t('where.machine', { machine: where.assetNumber }), hint: where.here ? t('where.machineHere') : t('where.machineReported') }
    case 'area':
      return { label: where.name, hint: t('where.area', { code: where.code }) }
    case 'elsewhere':
      return place.trim() ? { label: t('where.elsewhere'), hint: place.trim() } : { label: t('where.elsewhere'), hint: t('where.elsewhereHint') }
  }
}

const whereIcon = (where: WherePick): ReactNode => (where.kind === 'here' ? <MapPin /> : where.kind === 'machine' ? <Cog /> : where.kind === 'area' ? <LayoutGrid /> : <MessageSquareText />)

/** The words of a refusal this screen knows, else the API's. */
const refusalOf = (t: Translate, code: string, message: string): string => (isKnownRefusal(code) ? t(`refusal.${code}`) : message)

function Screen({ model, onAction, onFrame }: IncidentViewProps) {
  const t = useT('floor-incident')
  const locale = useLocale()
  const ds = useDsWords()
  const send = (action: IncidentAction) => onAction?.(action)
  const { step, emergency } = model
  const place = { locale, timeZone: model.timeZone }
  const held = (key: string | null): string | null => (key ? t(key) : null)

  const kindTiles = useMemo<ReasonTile[]>(
    () => KINDS.map((kind) => ({ id: kind, label: t(`kind.${kind}`), hint: t(`kind.hint.${kind}`), icon: KIND_ICON[kind], tone: KIND_TONE[kind] })),
    [t],
  )

  let actions: FloorActions | null = null
  let start: string | null = null
  let body: ReactNode = null
  const back: FloorAction = { label: t('action.back'), icon: <ArrowLeft />, variant: 'quiet', onPress: () => send({ type: 'back' }) }

  switch (step.kind) {
    case 'report': {
      const { draft, stage } = step
      const injury = draft.kind === 'INJURY'
      if (step.open === 'photo') {
        body = <CaptureStep kind="PHOTO" title={t('photo.title')} t={t} onPhoto={(blob) => send({ type: 'taken', blob })} onVoice={() => undefined} onCancel={() => send({ type: 'captureCancel' })} />
        break
      }
      if (step.open === 'worker') {
        body = (
          <div className="fw-floor-stack">
            <h2 className="fw-floor-section-title">{t('people.pickTitle')}</h2>
            <FloorNamePicker
              label={t('people.pickLabel')}
              people={step.roster.filter((person) => person.id !== step.me.id && !draft.people.some((row) => row.workerId === person.id))}
              locale={locale}
              headingLevel={3}
              labels={ds.floorNamePicker}
              onPick={(id) => send({ type: 'pickWorker', workerId: id })}
            />
          </div>
        )
        actions = [{ label: t('action.cancel'), icon: <X />, variant: 'quiet', onPress: () => send({ type: 'closeOpen' }) }]
        break
      }
      if (step.open === 'outside') {
        const name = step.outsideName ?? ''
        body = (
          <div className="fw-floor-stack">
            <h2 className="fw-floor-section-title">{t('people.outsideTitle')}</h2>
            <Field label={t('people.outsideLabel')} hint={t('people.outsideHint')} required htmlFor="fw-in-outside">
              <Input id="fw-in-outside" value={name} maxLength={NAME_MAX} autoComplete="off" onChange={(event) => send({ type: 'outsideName', text: event.target.value })} />
            </Field>
          </div>
        )
        actions = [
          { label: t('action.cancel'), icon: <X />, variant: 'quiet', onPress: () => send({ type: 'closeOpen' }) },
          { label: t('action.addPerson'), icon: <Plus />, heldReason: name.trim() ? null : t('held.outsideName'), onPress: () => send({ type: 'addOutsideName' }) },
        ]
        break
      }

      const problem = step.problem ? (
        step.problem.kind === 'refused' ? (
          <RefusalLine text={refusalOf(t, step.problem.code, step.problem.message)} />
        ) : (
          <TaskLine tone="warning" icon={<CircleAlert />} alert>
            {t(`problem.${step.problem.kind === 'stepUp' ? 'forbidden' : step.problem.kind}`)}
          </TaskLine>
        )
      ) : null

      if (stage === 'what') {
        body = (
          <div className="fw-floor-stack">
            <EmergencyBanner model={emergency} t={t} locale={locale} onAction={send} headingId="fw-in-emergency" />
            <section className="fw-floor-section" aria-labelledby="fw-in-what">
              <h2 id="fw-in-what" className="fw-floor-section-title">
                {t('what.title')}
              </h2>
              <PickStep label={t('what.title')} tiles={kindTiles} value={draft.kind} locale={locale} onPick={(id, advance) => send({ type: 'kind', kind: id as IncidentKind, advance })} />
            </section>
            {!model.online ? <TaskLine tone="info" icon={<CloudOff />}>{t('what.offline')}</TaskLine> : null}
          </div>
        )
        start = draft.kind ? null : t('held.kind')
        actions = [
          { label: t('action.home'), icon: <House />, variant: 'quiet', onPress: () => send({ type: 'home' }) },
          { label: t('action.next'), icon: <ArrowRight />, variant: 'secondary', heldReason: draft.kind ? null : t('held.kind'), onPress: () => send({ type: 'next' }) },
        ]
        break
      }

      const kindLine = draft.kind ? (
        <p className="fw-in-chosen">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            {KIND_ICON[draft.kind]}
          </span>
          {t(`kind.${draft.kind}`)}
          {stage === 'details' && draft.where ? (
            <>
              <span aria-hidden="true"> · </span>
              {whereWords(draft.where, t, step.station, draft.place).label}
              {draft.where.kind === 'here' && step.station ? ` (${step.station.code})` : ''}
            </>
          ) : null}
        </p>
      ) : null

      if (stage === 'where') {
        const tiles: ReasonTile[] = step.where.map((where) => ({ id: whereId(where), ...whereWords(where, t, step.station, draft.place), icon: whereIcon(where), tone: where.kind === 'here' ? 'primary' : 'neutral' }))
        const elsewhere = draft.where?.kind === 'elsewhere'
        body = (
          <div className="fw-floor-stack">
            <EmergencyLine model={emergency} t={t} injury={injury} />
            {kindLine}
            {step.asOf ? <TaskLine tone="warning" icon={<History />}>{t('where.asOf', { time: formatTime(step.asOf, place) })}</TaskLine> : null}
            <section className="fw-floor-section" aria-labelledby="fw-in-where">
              <h2 id="fw-in-where" className="fw-floor-section-title">
                {t('where.title')}
              </h2>
              {!step.station ? <p className="fw-floor-muted">{t('where.noStation')}</p> : null}
              <PickStep label={t('where.title')} tiles={tiles} value={draft.where ? whereId(draft.where) : null} locale={locale} onPick={(id, advance) => send({ type: 'where', id, advance })} />
              <p className="fw-floor-muted">{t('where.planLater')}</p>
            </section>
            {elsewhere ? (
              <Field label={t('where.placeLabel')} hint={t('where.placeHint')} required htmlFor="fw-in-place">
                <Textarea id="fw-in-place" value={draft.place} rows={2} limit={PLACE_MAX} maxLength={PLACE_MAX} onChange={(event) => send({ type: 'place', text: event.target.value })} />
              </Field>
            ) : null}
          </div>
        )
        const why = draft.where ? (elsewhere && draft.place.trim() === '' ? 'held.place' : null) : 'held.where'
        start = held(why)
        actions = [back, { label: t('action.next'), icon: <ArrowRight />, variant: 'secondary', heldReason: held(why), onPress: () => send({ type: 'next' }) }]
        break
      }

      // details: photo and people (optional), then Send
      const anonymousOk = mayGoWithoutName(draft.kind, step.anonymousKinds)
      const without = anonymousOk && draft.withoutName
      const why = sendHeld(draft, step.busy)
      const facts = { meId: step.me.id, roster: step.roster.filter((person) => person.id !== step.me.id).length }
      body = (
        <div className="fw-floor-stack">
          <EmergencyLine model={emergency} t={t} injury={injury} />
          {kindLine}
          {problem}
          {peopleAsked(draft.kind) ? (
            <PeopleSection
              people={draft.people}
              t={t}
              onAction={send}
              held={{
                me: personHeld(draft, 'ME', facts),
                worker: personHeld(draft, 'WORKER', facts),
                outside: personHeld(draft, 'OUTSIDE', facts),
              }}
            />
          ) : null}
          <section className="fw-floor-section" aria-labelledby="fw-in-photo">
            <h3 id="fw-in-photo" className="fw-floor-subtitle">
              {t('photo.optional')}
            </h3>
            <TaskLine tone="info" icon={<EyeOff />}>
              {t('photo.noFaces')}
            </TaskLine>
            <div className="fw-in-add">
              <FloorButton size="lg" variant="secondary" icon={<Camera />} heldReason={held(photoHeld({ online: model.online, count: draft.photos.length }))} onClick={() => send({ type: 'capture' })}>
                {t('photo.add')}
              </FloorButton>
            </div>
            <TakenList media={draft.photos.map((photo) => ({ ...photo, kind: 'PHOTO' as const }))} t={t} onRemove={(id) => send({ type: 'removePhoto', id })} />
            {draft.photos.length > 0 ? <p className="fw-floor-muted">{t('photo.afterSend')}</p> : null}
          </section>
          <section className="fw-floor-section" aria-labelledby="fw-in-words">
            <h3 id="fw-in-words" className="fw-floor-subtitle">
              {t('words.optional')}
            </h3>
            {draft.wordsOpen ? (
              <Field label={t('words.label')} hint={t('words.hint')} htmlFor="fw-in-words-text">
                <Textarea id="fw-in-words-text" value={draft.words} rows={3} limit={WORDS_MAX} maxLength={WORDS_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
              </Field>
            ) : (
              <div className="fw-in-add">
                <FloorButton size="lg" variant="secondary" icon={<MessageSquareText />} onClick={() => send({ type: 'openWords' })}>
                  {t('words.add')}
                </FloorButton>
              </div>
            )}
          </section>
          {anonymousOk ? (
            <section className="fw-floor-section" aria-labelledby="fw-in-name">
              <h3 id="fw-in-name" className="fw-floor-subtitle">
                {t('name.title')}
              </h3>
              {/* The design's "Toggle (floor size, D1)": the DS Toggle has no floor size, so a floor button is the switch. */}
              <FloorButton size="lg" block variant={without ? 'primary' : 'secondary'} role="switch" aria-checked={without} icon={without ? <ToggleRight /> : <ToggleLeft />} onClick={() => send({ type: 'withoutName', on: !without })}>
                {t('name.switch')}
              </FloorButton>
              {without ? (
                <>
                  <TaskLine tone="success" icon={<ShieldCheck />}>
                    {t('name.notStored')}
                  </TaskLine>
                  <p className="fw-floor-muted">{model.online ? t('name.online') : t('name.offline')}</p>
                </>
              ) : (
                <p className="fw-floor-muted">{t('name.withName')}</p>
              )}
            </section>
          ) : draft.kind === 'INJURY' ? (
            <p className="fw-floor-muted">{t('name.injury')}</p>
          ) : null}
        </div>
      )
      start = why ? t(why) : without ? (model.online ? t('send.now') : t('send.waits')) : model.online ? t('send.saves') : t('send.savesOffline')
      actions = [back, { label: t('action.send'), icon: <Send />, variant: injury ? 'danger' : 'primary', heldReason: held(why), onPress: () => send({ type: 'send' }) }]
      break
    }

    case 'held': {
      const busy = Boolean(step.busy)
      body = (
        <div className="fw-floor-stack">
          <FloorState tone="warning" icon={<CloudOff />} title={t('waiting.title')} alert>
            <p className="fw-floor-state-text">{t(step.why === 'offline' ? 'waiting.offlineBody' : 'waiting.unavailableBody')}</p>
            <p className="fw-floor-state-text">{t('waiting.neverKept')}</p>
          </FloorState>
          {step.problem && step.problem.kind === 'refused' ? <RefusalLine text={refusalOf(t, step.problem.code, step.problem.message)} /> : null}
          <EmergencyLine model={emergency} t={t} injury={false} />
          <FloorButton size="lg" block variant="secondary" icon={<UserRound />} heldReason={busy ? t('held.busy') : null} onClick={() => send({ type: 'withName' })}>
            {t('waiting.withName')}
          </FloorButton>
          <p className="fw-floor-muted">{t('waiting.withNameHint')}</p>
        </div>
      )
      start = model.online ? null : t('waiting.network')
      actions = [
        { label: t('action.discard'), icon: <X />, variant: 'quiet', onPress: () => send({ type: 'discard' }) },
        { label: t('action.retry'), icon: <RotateCcw />, heldReason: !model.online ? t('held.offline') : busy ? t('held.busy') : null, onPress: () => send({ type: 'retry' }) },
      ]
      break
    }

    case 'sent': {
      const { report } = step
      if (step.capture) {
        body = <CaptureStep kind="PHOTO" title={t('photo.title')} t={t} onPhoto={(blob) => send({ type: 'taken', blob })} onVoice={() => undefined} onCancel={() => send({ type: 'captureCancel' })} />
        break
      }
      const refused = report.ticks === 'refused'
      const recorded = report.ticks === 'recorded'
      const injury = report.kind === 'INJURY'
      body = refused ? (
        <div className="fw-floor-stack">
          <FloorState tone="danger" icon={<CircleAlert />} title={report.refusal ? refusalOf(t, report.refusal.code, report.refusal.message) : t('sent.refusedTitle')} alert>
            <p className="fw-floor-state-text">{t('sent.refusedFix')}</p>
            {report.uploads.length > 0 ? <p className="fw-floor-state-text">{t('photo.dropped')}</p> : null}
          </FloorState>
          {injury ? <EmergencyBanner model={emergency} t={t} locale={locale} onAction={send} headingId="fw-in-emergency" /> : null}
        </div>
      ) : (
        <div className="fw-floor-stack">
          <FloorState tone={recorded ? 'success' : 'info'} icon={recorded ? <ShieldCheck /> : <History />} title={recorded ? (report.number ? t('sent.titleNumber', { number: report.number }) : t('sent.title')) : t('sent.savedTitle')}>
            <p className="fw-in-chosen fw-in-chosen-centre">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                {KIND_ICON[report.kind]}
              </span>
              {t(`kind.${report.kind}`)}
            </p>
            {report.anonymous ? null : (
              <p className="fw-in-ticks">
                <Ticks state={report.ticks} />
              </p>
            )}
            <p className="fw-floor-state-text">{recorded ? t('sent.recorded') : model.online ? t('sent.sending') : t('sent.waits')}</p>
            {report.anonymous ? <p className="fw-floor-state-text">{t('name.notStored')}</p> : null}
          </FloorState>
          <section className="fw-floor-section" aria-labelledby="fw-in-seen">
            <h3 id="fw-in-seen" className="fw-floor-subtitle">
              {t('seen.title')}
            </h3>
            {report.seenAt ? (
              <TaskLine tone="success" icon={<Eye />}>
                {t('seen.at', { time: formatTime(report.seenAt, place) })}
              </TaskLine>
            ) : (
              <p className="fw-floor-lead" role="status">
                {recorded ? t('seen.notYet') : t('seen.afterSend')}
              </p>
            )}
            {report.closed ? <p className="fw-floor-muted">{t('seen.closed')}</p> : null}
          </section>
          <section className="fw-floor-section" aria-labelledby="fw-in-sent-photos">
            <h3 id="fw-in-sent-photos" className="fw-floor-subtitle">
              {t('photo.optional')}
            </h3>
            <UploadList uploads={report.uploads.map((entry) => ({ ...entry, kind: 'PHOTO' as const }))} t={t} onRetry={(id) => send({ type: 'retryUpload', id })} />
            {report.uploads.map((entry) => (entry.refusal ? <p key={entry.id} className="fw-floor-muted">{refusalOf(t, entry.refusal, entry.refusal)}</p> : null))}
            {report.uploads.some((entry) => entry.state === 'waiting' || entry.state === 'sending') ? <p className="fw-floor-muted">{t('photo.waitReport')}</p> : null}
            <div className="fw-in-add">
              <FloorButton size="lg" variant="secondary" icon={<Camera />} heldReason={held(report.photoHeld)} onClick={() => send({ type: 'capture' })}>
                {t('photo.addMore')}
              </FloorButton>
            </div>
            <p className="fw-floor-muted">{t('photo.window', { minutes: PHOTO_MINUTES, count: PHOTOS_MAX })}</p>
          </section>
          {injury ? <EmergencyBanner model={emergency} t={t} locale={locale} onAction={send} headingId="fw-in-emergency" /> : null}
        </div>
      )
      actions = [
        { label: t('action.home'), icon: <House />, variant: 'secondary', onPress: () => send({ type: 'home' }) },
        { label: t('action.another'), icon: <Plus />, onPress: () => send({ type: 'another' }) },
      ]
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} start={start ?? undefined} /> : undefined}>
      <div className="fw-in">{body}</div>
    </FloorFrameView>
  )
}
