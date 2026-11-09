'use client'

import type { KeyboardEvent } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, RadioCard, Skeleton, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { gridCopyOf } from '../../../../lib/jobs/grid'
import { DECLINE_REASONS, type Job, type JobRow } from '../api'
import { operationGrid, operationsOf, returnPieces, scrapKey, type AcceptDraft, type DeclineDraft, type ReturnDraft, type Words } from '../model'
import { useJobWords } from '../words'

/**
 * The pop-ups of the Jobs pages (design portal.supplier.jobs pop:accept-job, pop:decline-job; the kit's damage photo; the
 * send-back's review): each a DS Modal, a bottom sheet on a phone; Esc closes and the focus goes back to the opener; the
 * primary button is held with its reason (never disabled without words). No price anywhere (C2).
 */

const MAX_TEXT = 2000

// ── "Accept job SC-2026-0012" ────────────────────────────────────────────────────────────────────────────────────────
export interface AcceptModel {
  number: string
  /** The job, once read (the pop-up opened from a card reads it). */
  job: Job | null
  loading: boolean
  draft: AcceptDraft
  today: string
  person: string
  busy: boolean
  heldReason: Words | null
  problem: Words | null
}

export function AcceptDialog({ model, onDraft, onSend, onDecline, onClose }: { model: AcceptModel; onDraft?: (draft: AcceptDraft) => void; onSend?: () => void; onDecline?: () => void; onClose?: () => void }) {
  const { t, say, day, locale } = useJobWords()
  const { draft, job } = model
  const held = say(model.heldReason)
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement) && !held && !model.busy) {
      event.preventDefault()
      onSend?.()
    }
  }
  return (
    <Modal
      open
      sheet
      size="lg"
      onClose={() => onClose?.()}
      title={t('accept.title', { number: model.number })}
      footer={
        <>
          {onDecline ? (
            <Button variant="quiet" onClick={() => onDecline()}>
              {t('accept.toDecline')}
            </Button>
          ) : null}
          <span className="grow" />
          <Button onClick={() => onClose?.()}>{t('dialog.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => onSend?.()}>
            {model.busy ? <Spinner size={14} /> : null} {t(draft.mode === 'move' ? 'accept.goMove' : 'accept.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pjob-dialog" onKeyDown={onKey}>
        {model.loading || !job ? (
          <div role="status" aria-label={t('state.loading')} className="fw-pjob-stack">
            <Skeleton height={24} />
            <Skeleton height={96} />
          </div>
        ) : (
          <>
            <KeyValue
              labelCase="sentence"
              items={[
                { label: t('facts.operations'), value: job.operations.map((operation) => operation.name || operation.code).join(', ') },
                { label: t('facts.style'), value: `${job.workOrder.style.code} · ${job.workOrder.style.name}` },
                { label: t('facts.pieces'), value: String(job.operations.reduce((sum, operation) => sum + operation.pieces, 0)) },
                { label: t('facts.kit'), value: job.kit.sentOn.length > 0 ? day(job.kit.sentOn.at(-1)!) : t('facts.kitNotYet') },
                { label: t('facts.dueBack'), value: job.expectedBackDate ? day(job.expectedBackDate) : t('facts.noDay') },
                ...(job.note ? [{ label: t('facts.instructions'), value: job.note }] : []),
              ]}
            />
            {job.operations
              .filter((operation) => operation.sizes.length > 0)
              .map((operation) => {
                const grid = operationGrid(operation)
                return <SizeGridView key={operation.id} colours={grid.colours} sizes={grid.sizes} value={grid.pieces} locale={INTL_LOCALE[locale]} copy={gridCopyOf(t)} caption={t('grid.captionOf', { operation: operation.name || operation.code })} showCaption />
              })}
          </>
        )}
        <fieldset className="fw-pjob-choice">
          <legend className="fw-pjob-legend">{t('accept.how')}</legend>
          <RadioCard name="fw-pjob-accept" title={t('accept.asked')} description={job?.expectedBackDate ? t('accept.askedHint', { date: day(job.expectedBackDate) }) : undefined} selected={draft.mode === 'asked'} checked={draft.mode === 'asked'} onChange={() => onDraft?.({ ...draft, mode: 'asked' })} />
          <RadioCard name="fw-pjob-accept" title={t('accept.move')} description={t('accept.moveHint')} selected={draft.mode === 'move'} checked={draft.mode === 'move'} onChange={() => onDraft?.({ ...draft, mode: 'move' })} />
        </fieldset>
        {draft.mode === 'move' ? (
          <>
            <Field label={t('accept.date')} required>
              <DateField value={draft.proposedDate} min={model.today} onChange={(value) => onDraft?.({ ...draft, proposedDate: value })} />
            </Field>
            <Field label={t('accept.reason')} required>
              <Textarea value={draft.reason} onChange={(event) => onDraft?.({ ...draft, reason: event.target.value })} rows={3} honourRows maxLength={MAX_TEXT} />
            </Field>
          </>
        ) : null}
        <p className="fw-pjob-hint">{t('accept.who', { name: model.person })}</p>
        <p className="fw-pjob-hint">{t('noPrices')}</p>
        {model.problem ? <Banner tone="danger" title={say(model.problem)} /> : null}
      </div>
    </Modal>
  )
}

// ── "Decline this job" ───────────────────────────────────────────────────────────────────────────────────────────────
export interface DeclineModel {
  number: string
  draft: DeclineDraft
  /** The person tried to send: the note's own reason shows under it. */
  tried: boolean
  busy: boolean
  heldReason: Words | null
  problem: Words | null
}

export function DeclineDialog({ model, onDraft, onSend, onClose }: { model: DeclineModel; onDraft?: (draft: DeclineDraft) => void; onSend?: () => void; onClose?: () => void }) {
  const { t, say } = useJobWords()
  const { draft } = model
  const held = say(model.heldReason)
  const noteHeld = model.tried && model.heldReason?.key === 'decline.held.note' ? held : undefined
  return (
    <Modal
      open
      sheet
      size="sm"
      onClose={() => onClose?.()}
      title={t('decline.title', { number: model.number })}
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('dialog.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={() => onSend?.()}>
            {model.busy ? <Spinner size={14} /> : null} {t('decline.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pjob-dialog">
        <p className="fw-pjob-hint">{t('decline.body')}</p>
        <fieldset className="fw-pjob-choice">
          <legend className="fw-pjob-legend">{t('decline.reason')}</legend>
          {DECLINE_REASONS.map((reason) => (
            <RadioCard key={reason} variant="row" name="fw-pjob-decline" title={t(`decline.reasons.${reason}`)} selected={draft.reason === reason} checked={draft.reason === reason} onChange={() => onDraft?.({ ...draft, reason })} />
          ))}
        </fieldset>
        <Field label={t(draft.reason === 'OTHER' ? 'decline.noteRequired' : 'decline.note')} required={draft.reason === 'OTHER'} error={noteHeld ?? undefined}>
          <Textarea value={draft.note} onChange={(event) => onDraft?.({ ...draft, note: event.target.value })} rows={3} honourRows maxLength={MAX_TEXT - 60} />
        </Field>
        {model.problem ? <Banner tone="danger" title={say(model.problem)} /> : null}
      </div>
    </Modal>
  )
}

// ── "Accept 3 jobs as asked?" (the selected New jobs) ────────────────────────────────────────────────────────────────
export interface BulkAcceptModel {
  jobs: readonly Pick<JobRow, 'id' | 'number' | 'operations' | 'pieces' | 'dueBack'>[]
  person: string
  busy: boolean
  heldReason: Words | null
  result: { accepted: number; refused: number } | null
}

export function BulkAcceptDialog({ model, onSend, onClose }: { model: BulkAcceptModel; onSend?: () => void; onClose?: () => void }) {
  const { t, say, day } = useJobWords()
  return (
    <Modal
      open
      sheet
      size="md"
      onClose={() => onClose?.()}
      title={t('bulkAccept.title', { count: model.jobs.length })}
      footer={
        model.result ? (
          <Button variant="primary" onClick={() => onClose?.()}>
            {t('dialog.close')}
          </Button>
        ) : (
          <>
            <Button onClick={() => onClose?.()}>{t('dialog.cancel')}</Button>
            <Button variant="primary" heldReason={say(model.heldReason)} onClick={() => onSend?.()}>
              {model.busy ? <Spinner size={14} /> : null} {t('bulkAccept.go', { count: model.jobs.length })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pjob-dialog">
        {model.result ? (
          <Banner tone={model.result.refused > 0 ? 'warning' : 'success'} title={t('bulkAccept.result', { accepted: model.result.accepted, refused: model.result.refused })} />
        ) : (
          <>
            <p className="fw-pjob-hint">{t('bulkAccept.body')}</p>
            <ul className="fw-pjob-plain-list" aria-label={t('bulkAccept.jobs')}>
              {model.jobs.map((job) => (
                <li key={job.id}>
                  <strong>{job.number}</strong> · {operationsOf(job)} · {t('card.pieces', { count: job.pieces })}
                  {job.dueBack ? ` · ${t('card.dueBackOn', { date: day(job.dueBack) })}` : ''}
                </li>
              ))}
            </ul>
            <p className="fw-pjob-hint">{t('accept.who', { name: model.person })}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

// ── a photo of a missing or damaged kit item ─────────────────────────────────────────────────────────────────────────
export interface PhotoModel {
  line: { seq: number; name: string }
  busy: boolean
  heldReason: Words | null
  problem: Words | null
}

export function PhotoDialog({ model, onCapture, onClose }: { model: PhotoModel; onCapture?: (photo: CapturedPhoto) => void | Promise<void>; onClose?: () => void }) {
  const { t, say } = useJobWords()
  const photoWords = usePhotoWords()
  return (
    <Modal open sheet size="lg" onClose={() => onClose?.()} closeHeld={model.busy ? t('held.busy') : null} title={t('kit.photoTitle', { line: model.line.seq, name: model.line.name })}>
      <div className="fw-pjob-dialog">
        <p className="fw-pjob-hint">{t('kit.photoHint')}</p>
        <PhotoCapture label={t('kit.photoLabel')} markup={false} guide="frame" words={photoWords} heldReason={say(model.heldReason)} onCapture={(photo) => onCapture?.(photo)} onCancel={() => onClose?.()} />
        {model.problem ? <Banner tone="danger" title={say(model.problem)} /> : null}
      </div>
    </Modal>
  )
}

// ── the send-back, reviewed before it goes ───────────────────────────────────────────────────────────────────────────
export interface ReturnReviewModel {
  job: Job
  draft: ReturnDraft
  busy: boolean
  heldReason: Words | null
  problem: Words | null
}

export function ReturnReviewDialog({ model, onSend, onClose }: { model: ReturnReviewModel; onSend?: () => void; onClose?: () => void }) {
  const { t, say, day, quantity } = useJobWords()
  const { job, draft } = model
  const pieces = returnPieces(draft)
  const rows = Object.entries(draft.rows).flatMap(([operationId, row]) => {
    const operation = job.operations.find((entry) => entry.id === operationId)
    const finished = Number(row.finished || '0')
    const scrapped = Number(row.scrapped || '0')
    if (!operation || finished + scrapped === 0) return []
    return [{ operation, finished, scrapped, reasonCode: row.reasonCode }]
  })
  const material = Object.entries(draft.material).flatMap(([kitLineId, text]) => {
    const line = job.kit.lines.find((entry) => entry.id === kitLineId)
    return line && text.trim() !== '' ? [{ line, text: text.trim().replace(',', '.') }] : []
  })
  return (
    <Modal
      open
      sheet
      size="md"
      onClose={() => onClose?.()}
      title={t('returns.reviewTitle')}
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('returns.change')}</Button>
          <Button variant="primary" heldReason={say(model.heldReason)} onClick={() => onSend?.()}>
            {model.busy ? <Spinner size={14} /> : null} {t('returns.send')}
          </Button>
        </>
      }
    >
      <div className="fw-pjob-dialog">
        <p className="fw-pjob-lead">{t('returns.reviewLead', { count: pieces.finished + pieces.scrapped, date: day(draft.expectedDate) })}</p>
        <ul className="fw-pjob-plain-list" aria-label={t('returns.reviewPieces')}>
          {rows.map((row) => (
            <li key={row.operation.id}>
              <strong>{row.operation.name || row.operation.code}</strong> · {t('returns.reviewFinished', { count: row.finished })}
              {row.scrapped > 0 ? ` · ${t('returns.reviewScrapped', { count: row.scrapped, reason: t(scrapKey(row.reasonCode)) })}` : ''}
            </li>
          ))}
          {material.map((entry) => (
            <li key={entry.line.id}>
              {t('returns.reviewMaterial', { item: entry.line.item.name || entry.line.item.code, quantity: quantity(entry.text, entry.line.uom) })}
            </li>
          ))}
        </ul>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('returns.parcels'), value: draft.parcels },
            { label: t('returns.who'), value: t(draft.weCollect ? 'returns.weCollect' : 'returns.youDeliver') },
            { label: t('returns.ddt'), value: draft.ddtNumber.trim() ? (draft.ddtDate ? t('returns.ddtOf', { number: draft.ddtNumber.trim(), date: day(draft.ddtDate) }) : draft.ddtNumber.trim()) : t('returns.ddtNone') },
            ...(draft.note.trim() ? [{ label: t('returns.note'), value: draft.note.trim() }] : []),
          ]}
        />
        {model.problem ? <Banner tone="danger" title={say(model.problem)} /> : null}
      </div>
    </Modal>
  )
}
