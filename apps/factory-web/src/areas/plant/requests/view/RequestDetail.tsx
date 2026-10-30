'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, ChevronDown, ChevronUp, ExternalLink, GitMerge, ShieldCheck, Wrench, X } from 'lucide-react'
import { Banner, Card, KeyValue, Timeline, type TimelineStep } from '@nexus/ui/components'
import { DetailModal, Lightbox } from '@nexus/ui/patterns'
import { Button, Kbd, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import type { MaintenanceRequest, RequestRecord } from '../../_shared/api'
import { ageWords, labelOf, personWords } from '../../_shared/model'
import { JobPill, MachinePill, RequestPill, say, SymptomText, UnsafeTag, useWords, type Translate } from '../../_shared/parts'
import type { RequestsListActions, RequestsListModel } from '../view-model'

/**
 * The request's detail (design plant.requests/pop:request, a DetailModal opened by Enter or `?open=<request>`): the
 * symptom, the words and the photos (full size in the Lightbox; "Open full size" in a new tab), the machine's card (its
 * status, the open job, the last five jobs, the "third failure in 30 days" hint), who reported it and when, the other open
 * requests of the machine (merge into one), and the trail of what happened. Decisions by keys: A acknowledge, M make a job,
 * D merge into the first duplicate, C close without a job, S sign the machine safe (a technician, a fresh code); J / K the
 * previous and next request of the queue. Each held with its reason in words. A worker is named only here, and only where
 * the site records workers (the API decides; Owner answer W1).
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
  const index = ids.indexOf(detail.id)
  const prev = index > 0 ? ids[index - 1]! : null
  const next = index >= 0 && index < ids.length - 1 ? ids[index + 1]! : null

  const open = request ? request.status === 'NEW' || request.status === 'ACKNOWLEDGED' : false
  const triage = record?.canTriage ?? false
  const busyHeld = detail.busy ? t('held.busy') : null
  const ackHeld = !model.can.triage || (record && !triage && open) ? t('held.noTriage') : !open ? t('held.notOpen') : request?.status !== 'NEW' ? t('held.ackDone') : busyHeld
  const jobHeld = !model.can.triage || (record && !triage && open) ? t('held.noTriage') : !open ? t('held.notOpen') : busyHeld
  const closeHeld = !model.can.triage || (record && !triage && open) ? t('held.noTriage') : !open ? t('held.notOpen') : request?.locking ? t('held.closeLocked') : busyHeld
  const signHeld = !(record?.canSignSafe ?? false) ? t('held.noSignSafe') : busyHeld
  const firstDuplicate = record?.duplicates[0] ?? null

  const latest = useRef({ actions, prev, next, ackHeld, jobHeld, closeHeld, signHeld, request, firstDuplicate })
  latest.current = { actions, prev, next, ackHeld, jobHeld, closeHeld, signHeld, request, firstDuplicate }
  const quiet = model.dialog !== null || model.stepUp.open || detail.lightbox !== null
  useEffect(() => {
    if (quiet) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') || target.isContentEditable)) return
      const now = latest.current
      const key = event.key.toLowerCase()
      const act = (run: () => void) => {
        event.preventDefault()
        run()
      }
      if (key === 'j' && now.next) act(() => now.actions?.onOpen?.(now.next))
      else if (key === 'k' && now.prev) act(() => now.actions?.onOpen?.(now.prev))
      else if (key === 'a' && !now.ackHeld) act(() => now.actions?.onAcknowledge?.())
      else if (key === 'm' && !now.jobHeld) act(() => now.actions?.onMakeJob?.())
      else if (key === 'c' && !now.closeHeld) act(() => now.actions?.onClose?.())
      else if (key === 'd' && !now.jobHeld && now.firstDuplicate && !now.request?.locking) act(() => now.actions?.onMerge?.(now.firstDuplicate!))
      else if (key === 's' && now.request?.locking && !now.signHeld) act(() => now.actions?.onSignSafe?.())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quiet])

  const title = request ? t('detail.title', { machine: request.machine.assetNumber }) : t('detail.titleUnknown')
  const subtitle = request ? [labelOf(request.machine.class, locale), request.station ? `${request.station.code} · ${request.station.name}` : null].filter(Boolean).join(' · ') : undefined

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
        actions={
          <>
            <span className="fw-pl-row">
              <Button size="sm" variant="quiet" aria-label={t('detail.prev')} heldReason={prev ? null : t('detail.firstOne')} onClick={() => prev && actions?.onOpen?.(prev)} aria-keyshortcuts="k">
                <ChevronUp size={16} aria-hidden /> <Kbd>K</Kbd>
              </Button>
              <Button size="sm" variant="quiet" aria-label={t('detail.next')} heldReason={next ? null : t('detail.lastOne')} onClick={() => next && actions?.onOpen?.(next)} aria-keyshortcuts="j">
                <ChevronDown size={16} aria-hidden /> <Kbd>J</Kbd>
              </Button>
            </span>
            {request && (
              <>
                {request.locking && model.can.signSafe && (
                  <Button size="sm" heldReason={signHeld} onClick={() => actions?.onSignSafe?.()} aria-keyshortcuts="s">
                    <ShieldCheck size={14} aria-hidden /> {t('detail.signSafe')} <Kbd>S</Kbd>
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
        {record && request && <DetailBody record={record} request={request} model={model} actions={actions} t={t} place={place} />}
      </DetailModal>
      {record && detail.lightbox !== null && detail.photos.some((photo) => photo.src) && (
        <Lightbox
          open
          onClose={() => actions?.onPhoto?.(null)}
          items={detail.photos.filter((photo) => photo.src).map((photo, at) => ({ url: photo.src!, alt: t('detail.photoAlt', { n: at + 1, machine: record.request.machine.assetNumber }) }))}
          index={detail.lightbox}
          onIndex={(at) => actions?.onPhoto?.(at)}
          title={t('detail.photoTitle', { n: detail.lightbox + 1, count: detail.photos.filter((photo) => photo.src).length })}
          external={detail.photos.filter((photo) => photo.src)[detail.lightbox] ? { label: t('detail.photoFull'), href: detail.photos.filter((photo) => photo.src)[detail.lightbox]!.src! } : undefined}
        />
      )}
    </>
  )
}

function DetailBody({ record, request, model, actions, t, place }: { record: RequestRecord; request: MaintenanceRequest; model: RequestsListModel; actions?: RequestsListActions; t: Translate; place: { locale: ReturnType<typeof useLocale>; timeZone: string } }) {
  const locale = place.locale
  const detail = model.detail!
  const card = record.card
  const machineHref = `${model.prefix}/plant/machines/${encodeURIComponent(request.machine.id)}`
  const jobHref = (id: string) => `${model.prefix}/plant/jobs/${encodeURIComponent(id)}`
  const steps = trailOf(t, request, place)

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
              ]}
            />
          </section>

          <section className="fw-pl-section" aria-labelledby="pl-req-photos">
            <h3 className="fw-pl-h3" id="pl-req-photos">
              {t('detail.photos', { count: request.photos })}
            </h3>
            {detail.photos.length === 0 ? (
              <p className="fw-pl-hint">{t('detail.noPhotos')}</p>
            ) : (
              <div className="fw-pl-photos">
                {detail.photos.map((photo, at) =>
                  photo.src ? (
                    <button key={photo.id} type="button" className="fw-pl-photo" aria-label={t('detail.photoOpen', { n: at + 1 })} onClick={() => actions?.onPhoto?.(detail.photos.filter((entry) => entry.src).findIndex((entry) => entry.id === photo.id))}>
                      {/* A presigned address of the files API; the DS MediaPreview draws it full size in the Lightbox. */}
                      <img src={photo.src} alt={t('detail.photoAlt', { n: at + 1, machine: request.machine.assetNumber })} />
                    </button>
                  ) : (
                    <span key={photo.id} className="fw-pl-hint">
                      {t('detail.photoUnread', { name: photo.name })}
                    </span>
                  ),
                )}
              </div>
            )}
          </section>

          <section className="fw-pl-section" aria-labelledby="pl-req-dupes">
            <h3 className="fw-pl-h3" id="pl-req-dupes">
              {t('detail.duplicates', { count: record.duplicates.length })}
            </h3>
            {record.duplicates.length === 0 ? (
              <p className="fw-pl-hint">{t('detail.noDuplicates')}</p>
            ) : (
              <ul className="fw-pl-plain">
                {record.duplicates.map((other) => (
                  <li key={other.id} className="fw-pl-dupe">
                    <span className="fw-pl-cell">
                      <SymptomText symptom={other.symptom} description={other.description} />
                      <span className="fw-pl-sub">
                        {formatDateTime(other.reportedAt, place)} · {personWords(t, other.reportedBy)} · {t(`requestStatus.${other.status}`)}
                      </span>
                    </span>
                    <span className="fw-pl-row">
                      <Button size="sm" variant="quiet" onClick={() => actions?.onOpen?.(other.id)}>
                        {t('detail.openOther')}
                      </Button>
                      <Button
                        size="sm"
                        heldReason={!record.canTriage ? t('held.noTriage') : request.locking ? t('held.mergeLocked') : detail.busy ? t('held.busy') : null}
                        onClick={() => actions?.onMerge?.(other)}
                        aria-keyshortcuts={other.id === record.duplicates[0]?.id ? 'd' : undefined}
                      >
                        <GitMerge size={13} aria-hidden /> {t('detail.mergeInto')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="fw-pl-section" aria-labelledby="pl-req-trail">
            <h3 className="fw-pl-h3" id="pl-req-trail">
              {t('detail.trail')}
            </h3>
            <Timeline label={t('detail.trail')} steps={steps} />
            <p className="fw-pl-hint">{t('detail.routingLater')}</p>
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

/** What happened to the request, in order (reported, acknowledged, made into a job, merged or closed, signed safe). */
export function trailOf(t: Translate, request: MaintenanceRequest, place: { locale: ReturnType<typeof useLocale>; timeZone: string }): TimelineStep[] {
  const when = (at: string) => formatDateTime(at, place)
  const steps: TimelineStep[] = [{ key: 'reported', label: t('trail.reported', { who: personWords(t, request.reportedBy) }), tone: 'info', detail: when(request.reportedAt) }]
  if (request.acknowledgedAt) steps.push({ key: 'ack', label: t('trail.acknowledged', { who: personWords(t, request.acknowledgedBy) }), tone: 'info', detail: when(request.acknowledgedAt) })
  if (request.job) steps.push({ key: 'job', label: t('trail.job', { number: request.job.number }), tone: 'success', detail: t(`jobStatus.${request.job.status}`) })
  if (request.status === 'MERGED') steps.push({ key: 'merged', label: t('trail.merged'), tone: 'neutral', detail: request.closedAt ? when(request.closedAt) : undefined })
  if (request.status === 'CLOSED' && request.closedAt)
    steps.push({ key: 'closed', label: t('trail.closed', { reason: request.closeReason ? t(`closeReason.${request.closeReason}`) : '—', who: personWords(t, request.closedBy) }), tone: 'neutral', detail: [when(request.closedAt), request.closeNote].filter(Boolean).join(' · ') })
  if (request.signedSafe) steps.push({ key: 'safe', label: t('trail.signedSafe', { who: personWords(t, request.signedSafe.by) }), tone: 'success', detail: [when(request.signedSafe.at), request.signedSafe.note].filter(Boolean).join(' · ') })
  else if (request.locking) steps.push({ key: 'locked', label: t('trail.waitsSignSafe'), tone: 'info', detail: t('trail.waitsSignSafeDetail') })
  return steps
}
