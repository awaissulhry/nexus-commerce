'use client'

import Link from 'next/link'
import { CheckCheck, FileText, Link2, MoreHorizontal, Plus, TriangleAlert } from 'lucide-react'
import { Banner, Card, Field, Menu, ProgressBar, type MenuItemDef } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { ANNEX_III_LAW, ITEMS_PER_POINT_MAX, type AnnexIIIPoint } from '@nexus/factory-domain/compliance/techfiles/rules'
import { Combobox, FileDropzone, Modal, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import { recordAddress as recordPage } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { Item, Point } from '../../api'
import { DRAWING_TYPES } from '../../api'
import { annexBar, EVIDENCE_TONE, fileWriteHeld, ITEM_TONE, itemActionHeld, letterOf, naNoteProblem, POINT_TONE, recordTypeKey, staleKey, valueOf, type ItemAction } from '../../model'
import { NoticeBanner, SectionHead, StatePill, useDay, useWords } from '../../view/parts'
import { optionKey, UPLOAD_CHOICE, type EvidenceDialog, type RecordActions, type RecordModel } from '../view-model'

/**
 * Technical file › Annex III checklist (design rec tab "annex", sec tf-annex; PRD-296; PPE Reg. (EU) 2016/425 Annex III): the 13
 * points (a)–(m), each with its law reference (LawRef), its state in words and its rows of evidence — a record or a file of the
 * style, linked (never copied), with whether it is still in force — who reviewed it and when. Each row saves at once: Link
 * evidence (the record and file finder, or a drawing uploaded onto the file), Mark reviewed (the reviewer is you), Not
 * applicable (with why), Undo, Clear, Remove; Add evidence adds a row to a point. A complete or archived file is read-only and
 * says why. The system never reviews: what it linked at creation waits for a person.
 */
export function AnnexTab({ model, actions }: { model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const { record } = model
  const file = record.file
  const writeHeld = fileWriteHeld(file.status, model.can, model.online)
  const bar = annexBar(file.annex)
  const words = t('cell.annex', { done: file.annex.done, outOf: file.annex.outOf })
  return (
    <div className="fw-tf-tab">
      <SectionHead id="fw-tf-annex" title={t('annex.title')} note={<LawRef law={ANNEX_III_LAW} plain={t('law.annex')} labels={ds.lawRef} />}>
        <span className="fw-tf-annexbar">
          <span>{words}</span>
          <ProgressBar ariaLabel={words} value={bar.percent} tone={bar.tone} height={6} />
        </span>
      </SectionHead>
      <p className="fw-tf-muted">{t('annex.lead')}</p>
      {writeHeld && writeHeld !== 'held.manage' && file.status !== 'OPEN' && <Banner tone="neutral" title={t(writeHeld)} />}
      <Card padded>
        <ol className="fw-tf-points" aria-label={t('annex.title')}>
          {record.points.map((point) => (
            <PointRow key={point.point} point={point} model={model} actions={actions} writeHeld={writeHeld} locale={locale} />
          ))}
        </ol>
      </Card>
    </div>
  )
}

function PointRow({ point, model, actions, writeHeld, locale }: { point: Point; model: RecordModel; actions?: RecordActions | undefined; writeHeld: string | null; locale: string }) {
  const t = useWords()
  const ds = useDsWords()
  const title = locale === 'it' ? point.title.it : point.title.en
  const addHeld = writeHeld ? t(writeHeld) : point.items.length >= ITEMS_PER_POINT_MAX ? t('held.rowsMax', { count: ITEMS_PER_POINT_MAX }) : null
  return (
    <li className="fw-tf-point" aria-labelledby={`fw-tf-point-${point.point}`}>
      <div className="fw-tf-point-head">
        <span className="fw-tf-point-title">
          <span id={`fw-tf-point-${point.point}`} className="fw-tf-strong">
            {t('annex.pointName', { letter: letterOf(point.point), title })}
          </span>
          <LawRef law={point.law} plain={title} labels={ds.lawRef} />
        </span>
        <StatePill group="pointState" state={point.state} tone={POINT_TONE[point.state]} />
        <Button size="sm" variant="quiet" heldReason={addHeld} onClick={() => actions?.onEvidence?.(point.point, null, 'link')} aria-label={t('annex.addTo', { letter: letterOf(point.point) })}>
          <Plus size={13} aria-hidden /> {t('annex.add')}
        </Button>
      </div>
      <ul className="fw-tf-items">
        {point.items.map((item) => (
          <ItemRow key={item.id} item={item} point={point.point} rows={point.items.length} model={model} actions={actions} writeHeld={writeHeld} />
        ))}
      </ul>
    </li>
  )
}

function ItemRow({ item, point, rows, model, actions, writeHeld }: { item: Item; point: AnnexIIIPoint; rows: number; model: RecordModel; actions?: RecordActions | undefined; writeHeld: string | null }) {
  const t = useWords()
  const day = useDay()
  const busy = model.busyItem === item.id
  const held = (action: ItemAction) => {
    const key = itemActionHeld(action, item, writeHeld, rows)
    return key ? t(key, { count: rows }) : null
  }
  const evidence = item.evidence
  const stale = evidence ? staleKey(evidence.state) : null
  const href = evidence?.kind === 'RECORD' && evidence.recordType && evidence.recordId ? `${model.prefix}${recordPage({ type: evidence.recordType, id: evidence.recordId }, OFFICE_PAGES)}` : null

  const menu: MenuItemDef[] = [
    { id: 'link', label: t(evidence ? 'item.relink' : 'item.link'), disabled: !!held('link'), description: held('link') ?? undefined, onSelect: () => actions?.onEvidence?.(point, item.id, 'link') },
    { id: 'na', label: t('item.na'), disabled: !!held('notApplicable'), description: held('notApplicable') ?? undefined, onSelect: () => actions?.onEvidence?.(point, item.id, 'na') },
    { id: 'unreview', label: t(item.state === 'NOT_APPLICABLE' ? 'item.undoNa' : 'item.unreview'), disabled: !!held('unreview'), description: held('unreview') ?? undefined, onSelect: () => actions?.onItem?.(item.id, 'unreview') },
    { id: 'clear', label: t('item.clear'), disabled: !!held('clear'), description: held('clear') ?? undefined, onSelect: () => actions?.onItem?.(item.id, 'clear') },
    { id: 'remove', label: t('item.remove'), disabled: !!held('remove'), description: held('remove') ?? undefined, onSelect: () => actions?.onItem?.(item.id, 'remove') },
  ]

  return (
    <li className="fw-tf-item" aria-busy={busy || undefined}>
      <StatePill group="itemState" state={item.state} tone={ITEM_TONE[item.state]} />
      <span className="fw-tf-item-body">
        {evidence ? (
          <span className="fw-tf-evidence">
            {evidence.kind === 'FILE' ? <FileText size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
            <span className="fw-tf-muted">{evidence.kind === 'FILE' ? t('evidence.file') : t(recordTypeKey(evidence.recordType))}</span>
            {href ? (
              <Link className="fw-tf-link" href={href}>
                {evidence.label}
              </Link>
            ) : evidence.kind === 'FILE' && evidence.fileId ? (
              <Button size="sm" variant="quiet" inline heldReason={model.can.filesRead ? null : t('held.filesRead')} onClick={() => actions?.onOpenFile?.(evidence.fileId!, evidence.label)}>
                {evidence.label}
              </Button>
            ) : (
              <span>{evidence.label}</span>
            )}
            {stale && (
              <Pill tone={EVIDENCE_TONE[evidence.state] === 'success' ? 'neutral' : EVIDENCE_TONE[evidence.state]} icon={<TriangleAlert size={12} aria-hidden />}>
                {t(stale)}
              </Pill>
            )}
          </span>
        ) : item.state === 'NOT_APPLICABLE' ? (
          <span>{t('item.naWhy', { note: item.note ?? '—' })}</span>
        ) : (
          <span className="fw-tf-danger-text">{t('item.noEvidence')}</span>
        )}
        <span className="fw-tf-muted">
          {item.reviewedAt ? t(item.state === 'NOT_APPLICABLE' ? 'item.decidedBy' : 'item.reviewedBy', { name: item.reviewedBy?.name ?? '—', date: day(item.reviewedAt) }) : t('item.notReviewed')}
          {item.note && item.state !== 'NOT_APPLICABLE' ? ` · ${item.note}` : ''}
        </span>
      </span>
      <span className="fw-tf-item-actions">
        {item.state === 'MISSING' && (
          <Button size="sm" heldReason={held('link')} disabled={busy} onClick={() => actions?.onEvidence?.(point, item.id, 'link')}>
            <Link2 size={13} aria-hidden /> {t('item.link')}
          </Button>
        )}
        {item.state === 'LINKED' && (
          <Button size="sm" variant="primary" heldReason={held('review')} disabled={busy} onClick={() => actions?.onItem?.(item.id, 'review')}>
            <CheckCheck size={13} aria-hidden /> {t('item.review')}
          </Button>
        )}
        <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('item.menu', { letter: letterOf(point) }) }} items={menu} />
      </span>
    </li>
  )
}

/** Link evidence (the finder of the style's records and files, or a file from this device) or Not applicable with why. */
export function EvidenceDialogView({ model, state, actions }: { model: RecordModel; state: EvidenceDialog; actions?: RecordActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const point = model.record.points.find((entry) => entry.point === state.point)
  const title = point ? (locale === 'it' ? point.title.it : point.title.en) : ''
  const options = valueOf(state.options) ?? []
  const ordered = [...options].sort((a, b) => Number(b.points.includes(state.point)) - Number(a.points.includes(state.point)))
  const uploading = state.choice === UPLOAD_CHOICE
  const naProblem = state.mode === 'na' ? naNoteProblem(state.note) : null
  const held = !model.online
    ? t('held.offline')
    : state.mode === 'na'
      ? naProblem
        ? t(naProblem)
        : null
      : uploading
        ? state.upload
          ? null
          : t('held.chooseFile')
        : state.choice
          ? null
          : t('held.chooseEvidence')
  const close = () => actions?.onEvidenceClose?.()
  return (
    <Modal
      open
      onClose={close}
      title={t(state.mode === 'na' ? 'evidence.naTitle' : 'evidence.title', { letter: letterOf(state.point) })}
      subtitle={title}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={state.writing.busy} heldReason={held} onClick={() => actions?.onEvidenceSave?.()}>
            {t(state.mode === 'na' ? 'evidence.naSave' : uploading ? 'evidence.uploadSave' : 'evidence.save')}
          </Button>
        </>
      }
    >
      <div className="fw-tf-form">
        <NoticeBanner notice={state.writing.problem} />
        {state.mode === 'na' ? (
          <>
            <p className="fw-tf-muted">{t('evidence.naLead')}</p>
            <Field label={t('evidence.naNote')} required>
              <Textarea rows={3} value={state.note} maxLength={2000} onChange={(event) => actions?.onEvidenceChange?.({ note: event.target.value })} />
            </Field>
          </>
        ) : (
          <>
            <SegmentedControl
              ariaLabel={t('evidence.how')}
              size="sm"
              value={uploading ? UPLOAD_CHOICE : 'FIND'}
              onChange={(value) => actions?.onEvidenceChange?.({ choice: value === UPLOAD_CHOICE ? UPLOAD_CHOICE : '' })}
              options={[
                { value: 'FIND', label: t('evidence.find') },
                { value: UPLOAD_CHOICE, label: t('evidence.upload') },
              ]}
            />
            {uploading ? (
              <>
                <FileDropzone accept={DRAWING_TYPES.join(',')} maxBytes={25 * 1024 * 1024} onFiles={(files) => actions?.onEvidenceFile?.(files[0] ?? null)} hint={t('evidence.uploadHint')} disabled={!model.can.filesUpload} />
                {!model.can.filesUpload && <p className="fw-tf-danger-text">{t('held.filesUpload')}</p>}
                {state.upload && <p className="fw-tf-muted">{t('evidence.chosenFile', { name: state.upload.name })}</p>}
              </>
            ) : (
              <Field label={t('evidence.pick')} hint={state.options.status === 'error' ? t(state.options.problem) : t('evidence.pickHint', { letter: letterOf(state.point) })}>
                <Combobox
                  options={ordered.map((option) => ({
                    value: optionKey(option),
                    label: `${option.kind === 'FILE' ? t('evidence.file') : t(recordTypeKey(option.recordType))} · ${option.label}${option.points.includes(state.point) ? ` · ${t('evidence.fits', { letter: letterOf(state.point) })}` : ''}${option.linked ? ` · ${t('evidence.linkedAlready')}` : ''}`,
                  }))}
                  value={state.choice}
                  placeholder={state.options.status === 'loading' ? t('common.reading') : t('evidence.pickPlaceholder')}
                  onChange={(value) => actions?.onEvidenceChange?.({ choice: value })}
                />
              </Field>
            )}
            <Field label={t('evidence.note')} hint={t('evidence.noteHint')}>
              <Textarea rows={2} value={state.note} maxLength={2000} onChange={(event) => actions?.onEvidenceChange?.({ note: event.target.value })} />
            </Field>
            <p className="fw-tf-muted">{t('evidence.reviewAfter')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}
