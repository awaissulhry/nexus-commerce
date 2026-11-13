'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, CircleCheck, ExternalLink, Footprints, GitMerge, Lock, ShieldCheck, Wrench, X } from 'lucide-react'
import { Banner, Card, KeyValue, type TimelineStep } from '@nexus/ui/components'
import { Button, Kbd, Tag } from '@nexus/ui/primitives'
import { DetailModal, Timeline } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ageWords, labelOf, personWords } from '../../_shared/model'
import { JobPill, MachinePill, RequestPill, say, SymptomText, UnsafeTag, useWords, type Translate } from '../../_shared/parts'
import type { DeepRequest, DeepRequestRecord } from '../depth/api'
import { escalatedWords, goHeld, groupOfRecord, lightboxPhotos, lockHeld, progressRows, routedWords, trailSteps, worksHeld } from '../depth/model'
import type { RequestsListActions, RequestsListModel } from '../view-model'
import { MediaList } from './MediaList'
import { Lightbox } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * The request's detail (design plant.requests/pop:request, a DetailModal opened by Enter or `?open=<request>`): the
 * symptom, the words, the photos (full size in the Lightbox; "Open full size" in a new tab) and the voice notes, where it
 * was sent and how far it escalated, what the person who reported it sees (reported → seen → a technician on the way →
 * fixed → works again: design inline "Floor › Machine problem & jobs (the requester sees progress)") with On my way and
 * It works again, the machine's card (its status, the open job, the last five jobs, the "third failure in 30 days" hint),
 * the other open requests of the machine (Merge requests), and the routing and progress trail in time order. Decisions by
 * keys: A acknowledge, M make a job, D merge requests, L lock as unsafe, C close without a job, S sign the machine safe
 * (a technician, a fresh code); J / K the previous and next request (the DS DetailModal's). Each held with its reason. A
 * worker is named only here, and only where the site records workers (the API decides; Owner answer W1).
 */
export function RequestDetail({ model, actions }: { model: RequestsListModel; actions?: RequestsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const detail = model.detail!
  const loaded = detail.loaded
  const record = loaded.status === 'ready' ? loaded.value : null
  const request = record?.request ?? null
  const ids = (model.rows.items ?? []).map((row) => row.id)

  const open = request ? request.status === 'NEW' || request.status === 'ACKNOWLEDGED' : false
  const triage = record?.canTriage ?? false
  const busyHeld = detail.busy ? t('held.busy') : null
  const ackHeld = !model.can.triage || (record && !triage && open) ? t('held.noTriage') : !open ? t('held.notOpen') : request?.status !== 'NEW' ? t('held.ackDone') : busyHeld
  const jobHeld = !model.can.triage || (record && !triage && open) ? t('held.noTriage') : !open ? t('held.notOpen') : busyHeld
  const closeHeld = !model.can.triage || (record && !triage && open) ? t('held.noTriage') : !open ? t('held.notOpen') : request?.locking ? t('held.closeLocked') : busyHeld
  const signHeld = !(record?.canSignSafe ?? false) ? t('held.noSignSafe') : busyHeld
  const lockKey = record ? lockHeld(record, model.can, detail.busy) : 'held.busy'
  const group = record ? groupOfRecord(record) : null
  const mergeKeyHeld = !model.can.triage ? 'held.noTriage' : !group ? 'mergeMany.held.noGroup' : detail.busy ? 'held.busy' : null

  const latest = useRef({ actions, ackHeld, jobHeld, closeHeld, signHeld, lockKey, mergeKeyHeld, request, group })
  latest.current = { actions, ackHeld, jobHeld, closeHeld, signHeld, lockKey, mergeKeyHeld, request, group }
  const quiet = model.dialog !== null || model.stepUp.open || detail.lightbox !== null
  useEffect(() => {
    if (quiet) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, audio, [contenteditable="true"], [role="menu"]') || target.isContentEditable)) return
      const now = latest.current
      const key = event.key.toLowerCase()
      const act = (run: () => void) => {
        event.preventDefault()
        run()
      }
      if (key === 'a' && !now.ackHeld) act(() => now.actions?.onAcknowledge?.())
      else if (key === 'm' && !now.jobHeld) act(() => now.actions?.onMakeJob?.())
      else if (key === 'c' && !now.closeHeld) act(() => now.actions?.onClose?.())
      else if (key === 'd' && !now.mergeKeyHeld && now.group) act(() => now.actions?.onMergeGroup?.(now.group!))
      else if (key === 'l' && !now.lockKey) act(() => now.actions?.onLock?.())
      else if (key === 's' && now.request?.locking && !now.signHeld) act(() => now.actions?.onSignSafe?.())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quiet])

  const title = request ? t('detail.title', { machine: request.machine.assetNumber }) : t('detail.titleUnknown')
  const subtitle = request ? [labelOf(request.machine.class, locale), request.station ? `${request.station.code} · ${request.station.name}` : null].filter(Boolean).join(' · ') : undefined
  const photos = lightboxPhotos(detail.media)

  return (
    <>
      <DetailModal
        open
        onClose={() => actions?.onOpen?.(null)}
        title={title}
        subtitle={subtitle}
        meta={
          request ? (
            <>
              <RequestPill status={request.status} />
              {request.unsafe && <UnsafeTag signed={!request.locking} />}
              <MachinePill status={request.machine.status} locked={request.locking} />
            </>
          ) : undefined
        }
        loading={loaded.status === 'loading'}
        error={loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'notFound' ? t('detail.notFound') : loaded.status === 'forbidden' ? t('problem.forbidden') : undefined}
        onRetry={() => actions?.onRetryDetail?.()}
        // J / K and the held ends are the DS DetailModal's (B-W2b-18; the queue's order as shown).
        nav={ids.includes(detail.id) ? { ids, current: detail.id, onGo: (id) => actions?.onOpen?.(id), noun: t('detail.noun') } : undefined}
        actions={
          <>
            {request && (
              <>
                {request.locking && model.can.signSafe && (
                  <Button size="sm" heldReason={signHeld} onClick={() => actions?.onSignSafe?.()} aria-keyshortcuts="s">
                    <ShieldCheck size={14} aria-hidden /> {t('detail.signSafe')} <Kbd>S</Kbd>
                  </Button>
                )}
                {!request.locking && (
                  <Button size="sm" variant="danger-outline" heldReason={lockKey ? t(lockKey) : null} onClick={() => actions?.onLock?.()} aria-keyshortcuts="l">
                    <Lock size={14} aria-hidden /> {t('lockAsUnsafe.button')} <Kbd>L</Kbd>
                  </Button>
                )}
                <Button size="sm" heldReason={ackHeld} onClick={() => actions?.onAcknowledge?.()} aria-keyshortcuts="a">
                  <Check size={14} aria-hidden /> {t('detail.acknowledge')} <Kbd>A</Kbd>
                </Button>
                <Button size="sm" variant="danger-outline" heldReason={closeHeld} onClick={() => actions?.onClose?.()} aria-keyshortcuts="c">
                  <X size={14} aria-hidden /> {t('detail.close')} <Kbd>C</Kbd>
                </Button>
                <Button size="sm" variant="primary" heldReason={jobHeld} onClick={() => actions?.onMakeJob?.()} aria-keyshortcuts="m">
                  <Wrench size={14} aria-hidden /> {t('detail.makeJob')} <Kbd>M</Kbd>
                </Button>
              </>
            )}
          </>
        }
      >
        {record && request && <DetailBody record={record} request={request} model={model} actions={actions} t={t} place={place} mergeHeld={mergeKeyHeld} />}
      </DetailModal>
      {record && detail.lightbox !== null && photos.length > 0 && (
        <Lightbox
          open
          onClose={() => actions?.onPhoto?.(null)}
          items={photos.map((photo, at) => ({ url: photo.src!, alt: t('detail.photoAlt', { n: at + 1, machine: record.request.machine.assetNumber }) }))}
          index={Math.min(detail.lightbox, photos.length - 1)}
          onIndex={(at) => actions?.onPhoto?.(at)}
          title={t('detail.photoTitle', { n: Math.min(detail.lightbox, photos.length - 1) + 1, count: photos.length })}
          external={photos[detail.lightbox] ? { label: t('detail.photoFull'), href: photos[detail.lightbox]!.src! } : undefined}
        />
      )}
    </>
  )
}

interface BodyProps {
  record: DeepRequestRecord
  request: DeepRequest
  model: RequestsListModel
  actions?: RequestsListActions
  t: Translate
  place: { locale: ReturnType<typeof useLocale>; timeZone: string }
  mergeHeld: string | null
}

function DetailBody({ record, request, model, actions, t, place, mergeHeld }: BodyProps) {
  const locale = place.locale
  const detail = model.detail!
  const card = record.card
  const machineHref = `${model.prefix}/plant/machines/${encodeURIComponent(request.machine.id)}`
  const jobHref = (id: string) => `${model.prefix}/plant/jobs/${encodeURIComponent(id)}`
  const steps = trailSteps(t, request, record.trail).map(
    (step): TimelineStep => ({ key: step.key, label: say(t, step.words), tone: step.tone, detail: [step.at ? formatDateTime(step.at, place) : null, step.note].filter(Boolean).join(' · ') || undefined }),
  )
  const group = groupOfRecord(record)
  const routed = say(t, routedWords(request.routing)) ?? ''
  const escalated = escalatedWords(request.routing)
  const photos = detail.media.filter((entry) => entry.kind === 'PHOTO' && entry.src)

  return (
    <div className="fw-pl-stack">
      {detail.problem && <Banner tone="danger" title={say(t, detail.problem) ?? ''} />}
      {request.locking && (
        <Banner tone="danger" icon={<AlertTriangle size={18} aria-hidden />} title={t('detail.lockedTitle', { machine: request.machine.assetNumber })}>
          {t('detail.lockedBody')}
        </Banner>
      )}
      <div className="fw-pl-detail">
        <div className="fw-pl-stack">
          <section className="fw-pl-section" aria-labelledby="pl-req-problem">
            <h3 className="fw-pl-h3" id="pl-req-problem">
              {t('detail.problem')}
            </h3>
            <SymptomText symptom={request.symptom} description={null} />
            {request.description ? <p className="fw-pl-text">{request.description}</p> : <p className="fw-pl-hint">{t('detail.noWords')}</p>}
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('detail.reportedBy'), value: personWords(t, request.reportedBy) },
                { label: t('detail.reportedAt'), value: formatDateTime(request.reportedAt, place), hint: t('detail.waiting', { age: ageWords(t, request.ageMinutes) }) },
                { label: t('detail.station'), value: request.station ? `${request.station.code} · ${request.station.name}` : t('list.noStation') },
                { label: t('detail.unsafe'), value: request.unsafe ? (request.locking ? t('detail.unsafeLocked') : t('detail.unsafeSigned')) : t('unsafe.no') },
                { label: t('routing.column'), value: routed, hint: escalated ? [say(t, escalated), request.routing.escalatedAt ? formatDateTime(request.routing.escalatedAt, place) : null].filter(Boolean).join(' · ') : undefined },
              ]}
            />
          </section>

          <section className="fw-pl-section" aria-labelledby="pl-req-media">
            <h3 className="fw-pl-h3" id="pl-req-media">
              {t('media.requestTitle', { photos: request.photos, voices: request.voiceNotes })}
            </h3>
            <MediaList media={detail.media} canRead={model.can.readFiles} t={t} place={place} onPhoto={(id) => actions?.onPhoto?.(photos.findIndex((entry) => entry.id === id))} />
          </section>

          <ProgressSection record={record} request={request} model={model} actions={actions} t={t} place={place} />

          <section className="fw-pl-section" aria-labelledby="pl-req-dupes">
            <h3 className="fw-pl-h3" id="pl-req-dupes">
              {t('detail.duplicates', { count: record.duplicates.length })}
            </h3>
            {record.duplicates.length === 0 ? (
              <p className="fw-pl-hint">{t('detail.noDuplicates')}</p>
            ) : (
              <>
                <ul className="fw-pl-plain">
                  {record.duplicates.map((other) => (
                    <li key={other.id} className="fw-pl-dupe">
                      <span className="fw-pl-cell">
                        <SymptomText symptom={other.symptom} description={other.description} />
                        <span className="fw-pl-sub">
                          {formatDateTime(other.reportedAt, place)} · {personWords(t, other.reportedBy)} · {t(`requestStatus.${other.status}`)}
                          {other.locking ? ` · ${t('unsafe.tag')}` : ''}
                        </span>
                      </span>
                      <span className="fw-pl-row">
                        <Button size="sm" variant="quiet" onClick={() => actions?.onOpen?.(other.id)}>
                          {t('detail.openOther')}
                        </Button>
                        <Button size="sm" heldReason={mergeHeld ? t(mergeHeld) : null} onClick={() => group && actions?.onMergeGroup?.(group, `REQUEST:${other.id}`)}>
                          <GitMerge size={13} aria-hidden /> {t('detail.mergeInto')}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
                <span>
                  <Button size="sm" heldReason={mergeHeld ? t(mergeHeld) : null} onClick={() => group && actions?.onMergeGroup?.(group)} aria-keyshortcuts="d">
                    <GitMerge size={13} aria-hidden /> {t('mergeMany.open')} <Kbd>D</Kbd>
                  </Button>
                </span>
              </>
            )}
          </section>

          <section className="fw-pl-section" aria-labelledby="pl-req-trail">
            <h3 className="fw-pl-h3" id="pl-req-trail">
              {t('detail.trail')}
            </h3>
            <Timeline label={t('detail.trail')} steps={steps} />
          </section>
        </div>

        <Card padded>
          <div className="fw-pl-stack tight">
            <h3 className="fw-pl-h3">
              <Link className="fw-pl-link fw-pl-code" href={machineHref}>
                {request.machine.assetNumber}
              </Link>
              <MachinePill status={card.machine.status} locked={card.machine.locked} />
            </h3>
            <p className="fw-pl-hint">{[labelOf(card.machine.class, locale), card.machine.make, card.machine.modelName].filter(Boolean).join(' · ')}</p>
            {card.repeatFailure && (
              <Tag tone="warning">
                <AlertTriangle size={11} aria-hidden /> {t('detail.repeatFailure', { count: card.requestsIn30Days })}
              </Tag>
            )}
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('detail.statusSince'), value: formatDateTime(card.machine.statusSince, place), hint: card.machine.status !== 'RUNNING' ? t(`machineReason.${card.machine.locked ? 'LOCKED' : card.machine.status}`) : undefined },
                { label: t('detail.openJob'), value: card.openJob ? <Link className="fw-pl-link" href={jobHref(card.openJob.id)}>{card.openJob.number}</Link> : t('detail.noOpenJob') },
                { label: t('detail.requests30'), value: String(card.requestsIn30Days) },
                { label: t('detail.place'), value: [card.machine.line?.code, card.machine.station?.code, card.machine.workCentre?.code].filter(Boolean).join(' · ') || '—' },
              ]}
            />
            <p className="fw-pl-h3">{t('detail.lastJobs')}</p>
            {card.lastJobs.length === 0 ? (
              <p className="fw-pl-hint">{t('detail.noJobs')}</p>
            ) : (
              <ul className="fw-pl-plain">
                {card.lastJobs.map((entry) => (
                  <li key={entry.id} className="fw-pl-cell">
                    <span className="fw-pl-row">
                      <Link className="fw-pl-link fw-pl-code" href={jobHref(entry.id)}>
                        {entry.number}
                      </Link>
                      <JobPill status={entry.status} />
                    </span>
                    <span className="fw-pl-sub">
                      {formatDate(entry.createdAt, place)} · {t(`jobType.${entry.type}`)} · {entry.problem}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <span className="fw-pl-row">
              <Button size="sm" variant="quiet" asChild>
                <Link href={machineHref} target="_blank">
                  <ExternalLink size={13} aria-hidden /> {t('detail.machineRecord')}
                </Link>
              </Button>
              {request.job && (
                <Button size="sm" variant="quiet" asChild>
                  <Link href={jobHref(request.job.id)} target="_blank">
                    <ExternalLink size={13} aria-hidden /> {t('detail.jobRecord', { number: request.job.number })}
                  </Link>
                </Button>
              )}
            </span>
          </div>
        </Card>
      </div>
    </div>
  )
}

/**
 * What the person who reported it sees (QHS-180; design inline "the requester sees progress"): the five steps, a step
 * never said before a later one left out; On my way (a technician: plant.jobs.work) and It works again (the reporter's,
 * here for the office: plant.report), each held with its reason.
 */
function ProgressSection({ record, request, model, actions, t, place }: Omit<BodyProps, 'mergeHeld'>) {
  const busy = model.detail?.busy ?? false
  const go = goHeld(record, model.can, busy)
  const works = worksHeld(record, model.can, busy)
  const rows = progressRows(request)
  const steps: TimelineStep[] = rows.map((row) => ({
    key: row.key,
    label: t(`progress.step.${row.key}`),
    tone: row.done ? (row.key === 'WORKS' || row.key === 'FIXED' ? 'success' : 'info') : 'neutral',
    ...(row.done ? { detail: row.at ? formatDateTime(row.at, place) : undefined } : { at: null }),
  }))
  return (
    <section className="fw-pl-section" aria-labelledby="pl-req-progress">
      <h3 className="fw-pl-h3" id="pl-req-progress">
        {t('progress.title')}
      </h3>
      <p className="fw-pl-hint">{t('progress.body')}</p>
      <Timeline label={t('progress.title')} steps={steps} />
      {request.locking && <p className="fw-pl-hint">{t('progress.lockedNote')}</p>}
      {request.status === 'MERGED' && <p className="fw-pl-hint">{t('progress.mergedNote')}</p>}
      <span className="fw-pl-row">
        <Button size="sm" heldReason={go ? t(go) : null} onClick={() => actions?.onOnTheWay?.()}>
          <Footprints size={13} aria-hidden /> {t('progress.onTheWay')}
        </Button>
        <Button size="sm" variant="primary" heldReason={works ? t(works) : null} onClick={() => actions?.onWorks?.()}>
          <CircleCheck size={13} aria-hidden /> {t('progress.works')}
        </Button>
      </span>
    </section>
  )
}
