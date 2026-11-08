'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Camera, CheckCheck, FileText, PackageCheck, Truck } from 'lucide-react'
import { Banner, Card, Disclosure, EmptyState, Field, KeyValue, ProgressBar } from '@nexus/ui/components'
import { SizeGridEditor } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Pill, RadioCard, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { DateField, Textarea, Timeline, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { gridCopyOf } from '../../../../lib/jobs/grid'
import type { Job, JobPage, KitLine } from '../api'
import {
  actHeld,
  isShort,
  kitHeld,
  kitToCount,
  operationGrid,
  PROBLEM_KINDS,
  problemHeld,
  progressHeld,
  progressTyped,
  returnHeld,
  scrapKey,
  sheetHref,
  STATE_TONE,
  type ActEnd,
  type ActName,
  type KitDraft,
  type PersonFacts,
  type ProblemDraft,
  type ProgressDraft,
  type RecordTab,
  type ReturnDraft,
  type Words,
  endWords,
} from '../model'
import { useJobWords } from '../words'
import { AcceptDialog, DeclineDialog, PhotoDialog, ReturnReviewDialog, type AcceptModel, type DeclineModel, type PhotoModel, type ReturnReviewModel } from './Dialogs'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import '../jobs.css'

/**
 * SCR-193 › one job (design portal.supplier.jobs rec "Job": tabs Kit received, Progress, Send back, Documents, Messages):
 * what the job is (operations, style, pieces, our kit, due back, our notes) and its answer; the kit as on our DDT with ONE
 * big "All received as listed" or a count per line (a shortfall with words and a photo of the damage); today's finished
 * pieces per size on the stacked size grid (a phone), the day it finishes by, the reports so far, a problem told in the
 * job's messages; what comes back (finished, scrap with a reason, unused material, your DDT, parcels, the day, who
 * carries), reviewed before it goes; the documents; the job's messages. Every button that waits says why. No price (C2).
 */

export interface JobRecordViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  page: JobPage | null
  tab: RecordTab
  prefix: string
  today: string
  facts: PersonFacts
  kitLines: boolean
  kit: KitDraft
  progress: ProgressDraft
  returns: ReturnDraft
  problem: ProblemDraft
  /** The act being sent (its button spins). */
  busy: ActName | null
  /** A refused act, in words (shown where it was asked). */
  refusal: { act: ActName; words: Words } | null
  /** What the last act came to. */
  end: ActEnd | null
  accept: AcceptModel | null
  decline: DeclineModel | null
  photo: PhotoModel | null
  review: ReturnReviewModel | null
  /** No connection: shown as read at this time. */
  offlineSince: string | null
}

export interface JobRecordActions {
  onRetry?: () => void
  onAccept?: () => void
  onDecline?: () => void
  onKitAll?: () => void
  onKitLines?: (on: boolean) => void
  onKitDraft?: (draft: KitDraft) => void
  onKitSend?: () => void
  onPhoto?: (line: KitLine) => void
  onProgressDraft?: (draft: ProgressDraft) => void
  onProgressSend?: () => void
  onProblemDraft?: (draft: ProblemDraft) => void
  onProblemSend?: () => void
  onReturnDraft?: (draft: ReturnDraft) => void
  onReturnReview?: () => void
  onDismissEnd?: () => void
  accept?: { onDraft?: (draft: AcceptModel['draft']) => void; onSend?: () => void; onDecline?: () => void; onClose?: () => void }
  decline?: { onDraft?: (draft: DeclineModel['draft']) => void; onSend?: () => void; onClose?: () => void }
  photo?: { onCapture?: (photo: CapturedPhoto) => void | Promise<void>; onClose?: () => void }
  review?: { onSend?: () => void; onClose?: () => void }
}

export function JobRecordView({ model, actions, children }: { model: JobRecordViewModel; actions?: JobRecordActions; children?: ReactNode }) {
  const { t } = useJobWords()
  if (model.state === 'loading' || (model.state === 'ready' && !model.page)) return <Loading />
  if (model.state === 'missing') return <EmptyState title={t('record.missing')} description={t('record.missingBody')} action={<Button asChild><a href={`${model.prefix}/jobs`}>{t('list.title')}</a></Button>} />
  if (model.state === 'error' || !model.page) return <EmptyState title={t('record.failed')} description={t('list.failedBody')} action={<Button onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
  const { job } = model.page
  return (
    <div className="fw-pjob fw-pjob-record">
      {model.offlineSince ? <Banner tone="warning" title={t('offline.sinceRecord')}>{t('offline.held')}</Banner> : null}
      <Summary model={model} job={job} actions={actions} />
      {model.tab === 'kit' ? <KitTab model={model} job={job} actions={actions} /> : null}
      {model.tab === 'progress' ? <ProgressTab model={model} job={job} actions={actions} /> : null}
      {model.tab === 'sendback' ? <SendBackTab model={model} job={job} actions={actions} /> : null}
      {model.tab === 'documents' ? <DocumentsTab model={model} job={job} /> : null}
      {model.tab === 'messages' ? (
        <section id="messages" className="fw-pjob-section" aria-label={t('tabs.messages')}>
          {children}
        </section>
      ) : null}
      {model.accept ? <AcceptDialog model={model.accept} onDraft={actions?.accept?.onDraft} onSend={actions?.accept?.onSend} onDecline={actions?.accept?.onDecline} onClose={actions?.accept?.onClose} /> : null}
      {model.decline ? <DeclineDialog model={model.decline} onDraft={actions?.decline?.onDraft} onSend={actions?.decline?.onSend} onClose={actions?.decline?.onClose} /> : null}
      {model.photo ? <PhotoDialog model={model.photo} onCapture={actions?.photo?.onCapture} onClose={actions?.photo?.onClose} /> : null}
      {model.review ? <ReturnReviewDialog model={model.review} onSend={actions?.review?.onSend} onClose={actions?.review?.onClose} /> : null}
    </div>
  )
}

/** Skeleton cards in the shape of the job; after about a second, "Still loading…". */
function Loading() {
  const { t } = useJobWords()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-pjob fw-pjob-record" aria-busy="true">
      <Card padded className="fw-pjob-card">
        <Skeleton width="40%" height={24} />
        <Skeleton width="100%" height={72} />
      </Card>
      <Card padded className="fw-pjob-card">
        <Skeleton width="30%" height={22} />
        <Skeleton width="100%" height={160} />
      </Card>
      <p className="fw-pjob-hint" role="status">
        {slow ? t('state.slow') : t('state.loading')}
      </p>
    </div>
  )
}

function EndBanner({ model, act, actions }: { model: JobRecordViewModel; act: ActName | readonly ActName[]; actions?: JobRecordActions }) {
  const { t, say } = useJobWords()
  const acts: readonly ActName[] = typeof act === 'string' ? [act] : act
  const refusal = model.refusal && acts.includes(model.refusal.act) ? model.refusal : null
  const end = model.end && acts.includes(endAct(model.end)) ? model.end : null
  if (refusal) return <Banner tone="danger" title={say(refusal.words)} />
  if (!end) return null
  return (
    <Banner
      tone="success"
      title={say(endWords(end))}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onDismissEnd?.()}>
          {t('notice.hide')}
        </Button>
      }
    />
  )
}

const endAct = (end: ActEnd): ActName => (end.kind === 'accepted' ? 'accept' : end.kind === 'declined' ? 'decline' : end.kind === 'returns' ? 'sendBack' : end.kind)

// ── the job, above every tab ─────────────────────────────────────────────────────────────────────────────────────────
function Summary({ model, job, actions }: { model: JobRecordViewModel; job: Job; actions?: JobRecordActions }) {
  const { t, day, say, at } = useJobWords()
  const pieces = job.operations.reduce((sum, operation) => sum + operation.pieces, 0)
  const finished = job.operations.reduce((sum, operation) => sum + operation.finished, 0)
  const waiting = job.nextStep === 'ACCEPT'
  const acceptHeld = say(actHeld(job, model.facts, 'accept'))
  const declineHeld = say(actHeld(job, model.facts, 'decline'))
  const answer = job.answer
  return (
    <Card padded className="fw-pjob-card fw-pjob-summary">
      <div className="fw-pjob-summary-head">
        <h2 className="fw-pjob-h2">{job.operations.map((operation) => operation.name || operation.code).join(', ')}</h2>
        <Pill tone={STATE_TONE[job.state]}>{t(`state.${job.state}`)}</Pill>
      </div>
      <div className="fw-pjob-progress fw-pjob-progress-big">
        <span>{t('card.finishedOf', { done: finished, total: pieces })}</span>
        <ProgressBar value={pieces > 0 ? Math.round((finished / pieces) * 100) : 0} tone={finished >= pieces && pieces > 0 ? 'complete' : 'partial'} ariaLabel={t('card.finishedOf', { done: finished, total: pieces })} />
      </div>
      <KeyValue
        labelCase="sentence"
        dense
        columns={3}
        phoneColumns={2}
        items={[
          { label: t('facts.pieces'), value: String(pieces) },
          { label: t('facts.dueBack'), value: job.expectedBackDate ? day(job.expectedBackDate) : t('facts.noDay') },
          { label: t('facts.kit'), value: job.kit.sentOn.length > 0 ? job.kit.sentOn.map((date) => day(date)).join(', ') : t('facts.kitNotYet') },
          ...(job.finishBy ? [{ label: t('facts.finishBy'), value: day(job.finishBy) }] : []),
        ]}
      />
      {job.note ? <p className="fw-pjob-lead">{t('facts.notesOf', { note: job.note })}</p> : null}
      <Disclosure summary={t('facts.more')}>
        <KeyValue
          labelCase="sentence"
          dense
          columns={3}
          phoneColumns={2}
          items={[
            { label: t('facts.from'), value: job.from.companyName },
            { label: t('facts.style'), value: `${job.workOrder.style.code} · ${job.workOrder.style.name}` },
            { label: t('facts.workOrder'), value: job.workOrder.number },
          ]}
        />
      </Disclosure>
      {waiting ? (
        <div className="fw-pjob-answer" role="group" aria-label={t('answer.label')}>
          <p className="fw-pjob-lead">{t('answer.waiting')}</p>
          <div className="fw-pjob-row">
            <Button variant="danger-outline" heldReason={declineHeld} onClick={() => actions?.onDecline?.()}>
              {t('answer.decline')}
            </Button>
            <Button variant="primary" heldReason={acceptHeld} onClick={() => actions?.onAccept?.()}>
              {t('answer.accept')}
            </Button>
          </div>
        </div>
      ) : null}
      {answer.acceptedAt ? <p className="fw-pjob-hint">{t('answer.acceptedBy', { name: answer.acceptedByName ?? '—', time: at(answer.acceptedAt) })}</p> : null}
      {answer.declinedAt ? <p className="fw-pjob-hint">{t('answer.declinedBy', { name: answer.declinedByName ?? '—', time: at(answer.declinedAt) })}</p> : null}
      {answer.proposedDate ? (
        answer.dateDecision ? (
          <Banner tone={answer.dateDecision.decision === 'ACCEPTED' ? 'success' : 'warning'} title={t(answer.dateDecision.decision === 'ACCEPTED' ? 'answer.dateAccepted' : 'answer.dateRefused', { date: day(answer.proposedDate) })} />
        ) : (
          <Banner tone="info" title={t('answer.proposed', { date: day(answer.proposedDate) })}>
            {answer.proposedDateReason ? t('answer.because', { reason: answer.proposedDateReason }) : null}
          </Banner>
        )
      ) : null}
      <EndBanner model={model} act={['accept', 'decline']} actions={actions} />
    </Card>
  )
}

// ── Kit received ─────────────────────────────────────────────────────────────────────────────────────────────────────
function KitTab({ model, job, actions }: { model: JobRecordViewModel; job: Job; actions?: JobRecordActions }) {
  const { t, day, say, quantity, at } = useJobWords()
  const open = kitToCount(job)
  const kitHeldWords = actHeld(job, model.facts, 'kit')
  const photoHeld = say(actHeld(job, model.facts, 'photo'))
  const linesHeld = kitHeldWords ?? kitHeld(model.kit, job)
  const busy = model.busy === 'kit'
  return (
    <section className="fw-pjob-section" aria-label={t('kit.title')}>
      <Card padded className="fw-pjob-card">
        <div className="fw-pjob-card-head">
          <h2 className="fw-pjob-h2">{t('kit.title')}</h2>
          <span className="fw-pjob-sub">{open.length > 0 ? t('kit.toCount', { count: open.length }) : null}</span>
        </div>
        <p className="fw-pjob-hint">{t('kit.lead')}</p>
        <EndBanner model={model} act={['kit', 'photo']} actions={actions} />
        {job.kit.lines.length === 0 ? (
          <p className="fw-pjob-hint">{t('kit.none')}</p>
        ) : (
          <ul className="fw-pjob-lines" aria-label={t('kit.lines')}>
            {job.kit.lines.map((line) => {
              const entry = model.kit.lines[line.id]
              const counting = model.kitLines && line.status === 'SENT' && line.check === null
              const short = isShort(entry, line)
              return (
                <li key={line.id} className="fw-pjob-line">
                  <div className="fw-pjob-line-head">
                    <span className="fw-pjob-number">{t('kit.line', { seq: line.seq })}</span>
                    <span className="fw-pjob-line-what">{line.item.name || line.item.code}</span>
                    <span className="fw-pjob-line-qty">{quantity(line.quantity, line.uom)}</span>
                  </div>
                  <p className="fw-pjob-sub">
                    {[line.item.code, line.colour, line.lot ? t('kit.lot', { lot: line.lot }) : null, line.hide ? t('kit.hide', { hide: line.hide }) : null].filter(Boolean).join(' · ')}
                  </p>
                  <p className="fw-pjob-sub">
                    {line.status === 'SENT'
                      ? [line.sentAt ? t('kit.sentOn', { date: day(line.sentAt.slice(0, 10)) }) : null, line.ddt ? t(line.ddt.date ? 'kit.ddtOf' : 'kit.ddt', { number: line.ddt.number, date: line.ddt.date ? day(line.ddt.date) : '' }) : null].filter(Boolean).join(' · ')
                      : t('kit.notSent')}
                  </p>
                  {line.check ? (
                    <p className={line.check.short ? 'fw-pjob-late' : 'fw-pjob-ok'}>
                      {t(line.check.short ? 'kit.checkedShort' : 'kit.checked', { quantity: quantity(line.check.quantity, line.uom), time: at(line.check.at) })}
                      {line.check.note ? ` — ${line.check.note}` : ''}
                    </p>
                  ) : null}
                  {counting ? (
                    <div className="fw-pjob-count">
                      <Field label={t('kit.counted', { sent: quantity(line.quantity, line.uom) })}>
                        <Input inputMode="decimal" value={entry?.quantity ?? ''} onChange={(event) => actions?.onKitDraft?.({ lines: { ...model.kit.lines, [line.id]: { quantity: event.target.value, note: entry?.note ?? '' } } })} />
                      </Field>
                      {short ? (
                        <Field label={t('kit.shortNote')} required>
                          <Textarea value={entry?.note ?? ''} rows={2} honourRows maxLength={2000} onChange={(event) => actions?.onKitDraft?.({ lines: { ...model.kit.lines, [line.id]: { quantity: entry?.quantity ?? '', note: event.target.value } } })} />
                        </Field>
                      ) : null}
                    </div>
                  ) : null}
                  {line.photos.length > 0 ? (
                    <ul className="fw-pjob-photos" aria-label={t('kit.photos')}>
                      {line.photos.map((photo) => (
                        <li key={photo.id}>
                          <Camera size={14} aria-hidden /> {photo.originalName}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {line.status === 'SENT' ? (
                    <Button size="sm" variant="quiet" heldReason={photoHeld} onClick={() => actions?.onPhoto?.(line)}>
                      <Camera size={14} aria-hidden /> {t('kit.addPhoto')}
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        {open.length > 0 ? (
          <div className="fw-pjob-actions">
            {model.kitLines ? (
              <>
                <Button onClick={() => actions?.onKitLines?.(false)}>{t('kit.backToAll')}</Button>
                <Button variant="primary" size="lg" heldReason={say(linesHeld)} onClick={() => actions?.onKitSend?.()}>
                  {busy ? <Spinner size={14} /> : <PackageCheck size={16} aria-hidden />} {t('kit.sendCount')}
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => actions?.onKitLines?.(true)}>{t('kit.lineByLine')}</Button>
                <Button variant="primary" size="lg" heldReason={say(kitHeldWords)} onClick={() => actions?.onKitAll?.()}>
                  {busy ? <Spinner size={14} /> : <CheckCheck size={16} aria-hidden />} {t('kit.all')}
                </Button>
              </>
            )}
          </div>
        ) : null}
      </Card>
      {job.bundles.length > 0 ? (
        <Card padded className="fw-pjob-card">
          <h2 className="fw-pjob-h2">{t('kit.bundles')}</h2>
          <ul className="fw-pjob-plain-list" aria-label={t('kit.bundles')}>
            {job.bundles.map((bundle) => (
              <li key={bundle.id}>
                <strong>{bundle.code}</strong> · {bundle.colourway} {bundle.size} · {t('card.pieces', { count: bundle.quantity })}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  )
}

// ── Progress ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function ProgressTab({ model, job, actions }: { model: JobRecordViewModel; job: Job; actions?: JobRecordActions }) {
  const words = useJobWords()
  const { t, day, say, locale } = words
  const ds = useDsWords()
  const draft = model.progress
  const personAndJob = actHeld(job, model.facts, 'progress')
  const typed = progressTyped(draft, job)
  const held = personAndJob ?? progressHeld(draft, job)
  const offlineTyped = model.facts.offline && typed > 0
  const copy = { ...gridCopyOf(t), ...ds.sizeGridStacked }
  const reports = [...job.reports].sort((a, b) => (a.at < b.at ? 1 : -1))
  const operationOf = (id: string) => job.operations.find((operation) => operation.id === id)
  return (
    <section className="fw-pjob-section" aria-label={t('progress.title')}>
      <Card padded className="fw-pjob-card">
        <h2 className="fw-pjob-h2">{t('progress.title')}</h2>
        <p className="fw-pjob-hint">{t('progress.lead')}</p>
        {offlineTyped ? <Banner tone="warning" title={t('progress.offline')} /> : null}
        <EndBanner model={model} act="progress" actions={actions} />
        {job.operations.map((operation) => {
          const grid = operationGrid(operation)
          const left = operation.pieces - operation.finished
          return (
            <div key={operation.id} className="fw-pjob-operation">
              <div className="fw-pjob-card-head">
                <h3 className="fw-pjob-h3">{operation.name || operation.code}</h3>
                <span className="fw-pjob-sub">{t('progress.soFar', { done: operation.finished, total: operation.pieces })}</span>
              </div>
              <ProgressBar value={operation.pieces > 0 ? Math.round((operation.finished / operation.pieces) * 100) : 0} tone={left <= 0 ? 'complete' : 'partial'} ariaLabel={t('progress.soFar', { done: operation.finished, total: operation.pieces })} />
              {left <= 0 ? (
                <p className="fw-pjob-ok">{t('progress.allFinished')}</p>
              ) : operation.sizes.length === 0 ? (
                <Field label={t('progress.today')} hint={t('progress.left', { count: left })}>
                  <Input inputMode="numeric" value={draft.whole[operation.id] ?? ''} disabled={personAndJob !== null && model.facts.preview} onChange={(event) => actions?.onProgressDraft?.({ ...draft, whole: { ...draft.whole, [operation.id]: event.target.value } })} />
                </Field>
              ) : (
                <div className="fw-pjob-bleed">
                <SizeGridEditor
                  colours={grid.colours}
                  sizes={grid.sizes}
                  value={draft.grids[operation.id] ?? {}}
                  left={grid.left}
                  layout="auto"
                  onChange={(next) => actions?.onProgressDraft?.({ ...draft, grids: { ...draft.grids, [operation.id]: next } })}
                  locale={INTL_LOCALE[locale]}
                  copy={copy}
                  caption={t('progress.gridOf', { operation: operation.name || operation.code })}
                />
                </div>
              )}
            </div>
          )
        })}
        <div className="fw-pjob-form-row">
          <Field label={t('progress.finishBy')} hint={t('progress.finishByHint')}>
            <DateField value={draft.finishBy} min={job.orderDate} clearable onChange={(value) => actions?.onProgressDraft?.({ ...draft, finishBy: value })} />
          </Field>
          <Field label={t('progress.note')}>
            <Textarea value={draft.note} rows={2} honourRows maxLength={2000} onChange={(event) => actions?.onProgressDraft?.({ ...draft, note: event.target.value })} />
          </Field>
        </div>
        <div className="fw-pjob-actions">
          <Button variant="primary" size="lg" heldReason={say(held)} onClick={() => actions?.onProgressSend?.()}>
            {model.busy === 'progress' ? <Spinner size={14} /> : null} {typed > 0 ? t('progress.sendCount', { count: typed }) : t('progress.send')}
          </Button>
        </div>
      </Card>
      <Card padded className="fw-pjob-card">
        <h2 className="fw-pjob-h2">{t('progress.history')}</h2>
        {reports.length === 0 ? (
          <p className="fw-pjob-hint">{t('progress.noReports')}</p>
        ) : (
          <Timeline
            label={t('progress.history')}
            steps={reports.map((report) => ({
              key: report.id,
              tone: 'success' as const,
              at: report.at,
              label: t('progress.reportLine', { count: report.finished, operation: operationOf(report.operationId)?.name ?? String(report.operationSeq), size: report.workOrderSizeId ? `${report.colourway} ${report.size}` : t('progress.wholeOperation') }),
              detail: [report.byOffice ? t('progress.byOffice', { name: report.byName }) : t('progress.by', { name: report.byName }), report.finishBy ? t('progress.finishByOn', { date: day(report.finishBy) }) : null, report.note].filter(Boolean).join(' · '),
            }))}
          />
        )}
      </Card>
      <ProblemCard model={model} job={job} actions={actions} />
    </section>
  )
}

function ProblemCard({ model, job, actions }: { model: JobRecordViewModel; job: Job; actions?: JobRecordActions }) {
  const { t, say } = useJobWords()
  const draft = model.problem
  const held = actHeld(job, model.facts, 'problem') ?? problemHeld(draft)
  return (
    <Card padded className="fw-pjob-card">
      <h2 className="fw-pjob-h2">{t('problem.title')}</h2>
      <p className="fw-pjob-hint">{t('problem.lead')}</p>
      <EndBanner model={model} act="problem" actions={actions} />
      <fieldset className="fw-pjob-choice">
        <legend className="fw-pjob-legend">{t('problem.what')}</legend>
        {PROBLEM_KINDS.map((kind) => (
          <RadioCard key={kind} variant="row" name="fw-pjob-problem" title={t(`problem.kind.${kind}`)} selected={draft.kind === kind} checked={draft.kind === kind} onChange={() => actions?.onProblemDraft?.({ ...draft, kind })} />
        ))}
      </fieldset>
      <Field label={t('problem.note')} required>
        <Textarea value={draft.note} rows={3} honourRows maxLength={1800} onChange={(event) => actions?.onProblemDraft?.({ ...draft, note: event.target.value })} />
      </Field>
      <div className="fw-pjob-actions">
        <Button variant="primary" heldReason={say(held)} onClick={() => actions?.onProblemSend?.()}>
          {model.busy === 'problem' ? <Spinner size={14} /> : null} {t('problem.send')}
        </Button>
      </div>
    </Card>
  )
}

// ── Send back ────────────────────────────────────────────────────────────────────────────────────────────────────────
function SendBackTab({ model, job, actions }: { model: JobRecordViewModel; job: Job; actions?: JobRecordActions }) {
  const { t, day, say, quantity } = useJobWords()
  const draft = model.returns
  const personAndJob = actHeld(job, model.facts, 'sendBack')
  const held = personAndJob ?? returnHeld(draft, job, model.today)
  const operations = job.operations.filter((operation) => operation.announceable > 0)
  const sentLines = job.kit.lines.filter((line) => line.status === 'SENT')
  const set = (patch: Partial<ReturnDraft>) => actions?.onReturnDraft?.({ ...draft, ...patch })
  return (
    <section className="fw-pjob-section" aria-label={t('returns.title')}>
      <Card padded className="fw-pjob-card">
        <h2 className="fw-pjob-h2">{t('returns.title')}</h2>
        <p className="fw-pjob-hint">{t('returns.lead')}</p>
        <EndBanner model={model} act="sendBack" actions={actions} />
        {personAndJob && operations.length === 0 ? (
          <p className="fw-pjob-hint">{say(personAndJob)}</p>
        ) : (
          <>
            {operations.map((operation) => {
              const row = draft.rows[operation.id] ?? { finished: '', scrapped: '', reasonCode: '' }
              const setRow = (patch: Partial<typeof row>) => set({ rows: { ...draft.rows, [operation.id]: { ...row, ...patch } } })
              return (
                <div key={operation.id} className="fw-pjob-operation">
                  <div className="fw-pjob-card-head">
                    <h3 className="fw-pjob-h3">{operation.name || operation.code}</h3>
                    <span className="fw-pjob-sub">{t('returns.withYou', { count: operation.announceable, ready: operation.ready })}</span>
                  </div>
                  <div className="fw-pjob-form-row">
                    <Field label={t('returns.finished')}>
                      <Input inputMode="numeric" value={row.finished} onChange={(event) => setRow({ finished: event.target.value })} />
                    </Field>
                    <Field label={t('returns.scrapped')}>
                      <Input inputMode="numeric" value={row.scrapped} onChange={(event) => setRow({ scrapped: event.target.value })} />
                    </Field>
                    {Number(row.scrapped || '0') > 0 ? (
                      <Field label={t('returns.scrapReason')} required>
                        <Select value={row.reasonCode} onChange={(event) => setRow({ reasonCode: event.target.value })}>
                          <option value="">{t('returns.pickReason')}</option>
                          {job.choices.scrapReasons.map((reason) => (
                            <option key={reason.code} value={reason.code}>
                              {t(scrapKey(reason.code))}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ) : null}
                  </div>
                </div>
              )
            })}
            {sentLines.length > 0 ? (
              <div className="fw-pjob-operation">
                <h3 className="fw-pjob-h3">{t('returns.material')}</h3>
                <p className="fw-pjob-hint">{t('returns.materialHint')}</p>
                {sentLines.map((line) => (
                  <Field key={line.id} label={t('returns.materialOf', { item: line.item.name || line.item.code, sent: quantity(line.quantity, line.uom) })}>
                    <Input inputMode="decimal" value={draft.material[line.id] ?? ''} onChange={(event) => set({ material: { ...draft.material, [line.id]: event.target.value } })} />
                  </Field>
                ))}
              </div>
            ) : null}
            <div className="fw-pjob-form-row">
              <Field label={t('returns.ddtNumber')} hint={t('returns.ddtHint')}>
                <Input value={draft.ddtNumber} maxLength={40} autoComplete="off" onChange={(event) => set({ ddtNumber: event.target.value })} />
              </Field>
              <Field label={t('returns.ddtDate')}>
                <DateField value={draft.ddtDate} clearable onChange={(value) => set({ ddtDate: value })} />
              </Field>
              <Field label={t('returns.parcels')}>
                <Input inputMode="numeric" value={draft.parcels} onChange={(event) => set({ parcels: event.target.value })} />
              </Field>
              <Field label={t('returns.day')} required>
                <DateField value={draft.expectedDate} min={model.today} onChange={(value) => set({ expectedDate: value })} />
              </Field>
            </div>
            <fieldset className="fw-pjob-choice">
              <legend className="fw-pjob-legend">{t('returns.who')}</legend>
              <RadioCard variant="row" name="fw-pjob-carrier" title={t('returns.youDeliver')} selected={!draft.weCollect} checked={!draft.weCollect} onChange={() => set({ weCollect: false })} />
              <RadioCard variant="row" name="fw-pjob-carrier" title={t('returns.weCollect')} selected={draft.weCollect} checked={draft.weCollect} onChange={() => set({ weCollect: true })} />
            </fieldset>
            <Field label={t('returns.note')}>
              <Textarea value={draft.note} rows={2} honourRows maxLength={2000} onChange={(event) => set({ note: event.target.value })} />
            </Field>
            <p className="fw-pjob-hint">{t('returns.ddtPhotoLater')}</p>
            <div className="fw-pjob-actions">
              <Button variant="primary" size="lg" heldReason={say(held)} onClick={() => actions?.onReturnReview?.()}>
                <Truck size={16} aria-hidden /> {t('returns.review')}
              </Button>
            </div>
          </>
        )}
      </Card>
      <Card padded className="fw-pjob-card">
        <h2 className="fw-pjob-h2">{t('returns.sofar')}</h2>
        {job.returns.length === 0 ? (
          <p className="fw-pjob-hint">{t('returns.none')}</p>
        ) : (
          <ul className="fw-pjob-lines" aria-label={t('returns.sofar')}>
            {job.returns.map((notice) => (
              <li key={notice.id} className="fw-pjob-line">
                <div className="fw-pjob-line-head">
                  <span className="fw-pjob-number">{t('returns.notice', { seq: notice.seq })}</span>
                  <span className="fw-pjob-line-what">{t('returns.noticeLine', { count: notice.pieces, date: day(notice.expectedDate) })}</span>
                  <Pill tone={notice.status === 'RECEIVED' ? 'success' : notice.status === 'CANCELLED' ? 'neutral' : 'info'}>{t(`returns.status.${notice.status}`)}</Pill>
                </div>
                <p className="fw-pjob-sub">
                  {[notice.ddt ? t('returns.yourDdt', { number: notice.ddt.number }) : null, t('card.parcels', { count: notice.parcels }), t(notice.weCollect ? 'returns.weCollect' : 'returns.youDeliver'), notice.byOffice ? t('progress.byOffice', { name: notice.byName }) : t('progress.by', { name: notice.byName })].filter(Boolean).join(' · ')}
                </p>
                {notice.cancelReason ? <p className="fw-pjob-sub">{t('returns.cancelled', { reason: notice.cancelReason })}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  )
}

// ── Documents ────────────────────────────────────────────────────────────────────────────────────────────────────────
function DocumentsTab({ model, job }: { model: JobRecordViewModel; job: Job }) {
  const { t, day } = useJobWords()
  const kitDdts = [...new Map(job.kit.lines.filter((line) => line.ddt).map((line) => [line.ddt!.number, line.ddt!])).values()]
  const yourDdts = job.returns.filter((notice) => notice.ddt).map((notice) => ({ id: notice.id, ddt: notice.ddt! }))
  const photos = job.kit.lines.flatMap((line) => line.photos.map((photo) => ({ ...photo, seq: line.seq })))
  return (
    <section className="fw-pjob-section" aria-label={t('docs.title')}>
      <Card padded className="fw-pjob-card">
        <h2 className="fw-pjob-h2">{t('docs.title')}</h2>
        <ul className="fw-pjob-docs" aria-label={t('docs.title')}>
          <li>
            <FileText size={18} aria-hidden />
            <span className="fw-pjob-two">
              <a href={sheetHref(model.prefix, job.id)} target="_blank" rel="noopener">
                {t('docs.sheet', { number: job.number })}
              </a>
              <span className="fw-pjob-sub">{t('docs.sheetHint')}</span>
            </span>
          </li>
          {kitDdts.map((ddt) => (
            <li key={`kit-${ddt.number}`}>
              <FileText size={18} aria-hidden />
              <span className="fw-pjob-two">
                <span>{t(ddt.date ? 'docs.ourDdtOf' : 'docs.ourDdt', { number: ddt.number, date: ddt.date ? day(ddt.date) : '' })}</span>
                <span className="fw-pjob-sub">{t('docs.ourDdtHint')}</span>
              </span>
            </li>
          ))}
          {yourDdts.map((entry) => (
            <li key={`yours-${entry.id}`}>
              <FileText size={18} aria-hidden />
              <span className="fw-pjob-two">
                <span>{t(entry.ddt.date ? 'docs.yourDdtOf' : 'docs.yourDdt', { number: entry.ddt.number, date: entry.ddt.date ? day(entry.ddt.date) : '' })}</span>
              </span>
            </li>
          ))}
          {photos.map((photo) => (
            <li key={photo.id}>
              <Camera size={18} aria-hidden />
              <span className="fw-pjob-two">
                <span>{photo.originalName}</span>
                <span className="fw-pjob-sub">{t('docs.photoOf', { line: photo.seq })}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="fw-pjob-hint">{t('docs.more')}</p>
      </Card>
    </section>
  )
}

