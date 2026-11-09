'use client'

import type { ReactNode } from 'react'
import { ExternalLink, FileText, ImagePlus, Printer } from 'lucide-react'
import { Banner, Card, KeyValue, SummaryTable } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { Button } from '@nexus/ui/primitives'
import { FileRow, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { CaseFile, CaseDocument, ComplaintRecord, ReturnRecord } from '../api'
import { complaintSteps, disciplineSteps, lineBySeq, returnSteps, viaKey, type RecordTab } from '../model'
import { useReturnWords } from '../words'
import { CancelDialog, PhotosDialog, PhotoViewer, type CancelModel, type PhotosActions, type PhotosModel, type PhotoViewerModel } from './Dialogs'
import { Loading, OfflineBanner, RecordGone } from './parts'
import '../returns.css'

/**
 * SCR-187 › one case (design portal.customer.returns rec "Return": Request, Status, Messages; a complaint opens the same
 * tabs). The frame's band holds the title, their reference first, the state, "Add photos" while we have not decided and
 * "Print the return label" once approved, the ⋯ (the return label and credit note PDFs in a new tab, Cancel this
 * request…, Ask a question) and the three tabs; this view draws the tab and the pop-ups. No money on this page: a credit
 * note is named by its number.
 */

export type CaseRecord = { type: 'RETURN'; record: ReturnRecord } | { type: 'COMPLAINT'; record: ComplaintRecord }

export type CaseDialog = { kind: 'cancel'; model: CancelModel } | { kind: 'photos'; model: PhotosModel } | { kind: 'photo'; model: PhotoViewerModel }

export interface CaseRecordViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  case: CaseRecord | null
  tab: RecordTab
  prefix: string
  offlineSince: string | null
  /** One line at the top after an act (a key + its words). */
  notice: { tone: 'success' | 'info' | 'warning' | 'danger'; key: string; params?: Readonly<Record<string, string | number>> } | null
  /** "Add photos" waits: why (words), or null. */
  photosHeld: string | null
  /** A file cannot open now (offline): why (words), or null. */
  fileHeld: string | null
  /** The return instructions PDF's address (tab:return-label), once approved. */
  labelHref: string | null
  /** A credit note's PDF cannot open for this person: why (words), or null. */
  creditHeld: string | null
  /** The person follows the investigation (portal.complaints.view). */
  readsComplaints: boolean
  dialog: CaseDialog | null
}

export interface CaseRecordActions {
  onRetry?: () => void
  /** Add photos: of a return's line, or of the case as a whole (null). */
  onPhotos?: (lineId: string | null) => void
  /** Opens a photo full size (with the others of its group). */
  onPhoto?: (photos: readonly CaseFile[], index: number) => void
  /** Opens a document (the answer letter, the 8D) in a new tab. */
  onDocument?: (file: CaseFile) => void
  onCreditNote?: (id: string) => void
  onDismissNotice?: () => void
  dialog?: {
    cancel?: { onConfirm?: () => void; onClose?: () => void }
    photos?: PhotosActions
    photo?: { onIndex?: (index: number) => void; onClose?: () => void; onRetry?: () => void }
  }
}

export function CaseRecordView({ model, actions, children }: { model: CaseRecordViewModel; actions?: CaseRecordActions; children?: ReactNode }) {
  const { t } = useReturnWords()
  const listHref = `${model.prefix}/returns`
  if (model.state === 'loading') return <Loading rows={4} height={80} />
  if (model.state === 'missing') return <RecordGone kind="missing" listHref={listHref} />
  if (model.state === 'error' || !model.case) return <RecordGone kind="error" listHref={listHref} onRetry={actions?.onRetry} />
  const current = model.case
  const dialog = model.dialog
  return (
    <div className="fw-pret">
      <OfflineBanner since={model.offlineSince} />
      {model.notice ? (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('notice.hide')}
            </Button>
          }
        />
      ) : null}
      {model.tab === 'request' ? current.type === 'RETURN' ? <ReturnRequest model={model} record={current.record} actions={actions} /> : <ComplaintRequest model={model} record={current.record} actions={actions} /> : null}
      {model.tab === 'status' ? current.type === 'RETURN' ? <ReturnStatus model={model} record={current.record} actions={actions} /> : <ComplaintStatus model={model} record={current.record} actions={actions} /> : null}
      {model.tab === 'messages' ? (
        <section id="messages" className="fw-pret-tab" aria-label={t('tabs.messages')}>
          <p className="fw-pret-hint">{t('messages.hint')}</p>
          {children}
        </section>
      ) : null}
      {dialog?.kind === 'cancel' ? <CancelDialog model={dialog.model} onConfirm={actions?.dialog?.cancel?.onConfirm} onClose={actions?.dialog?.cancel?.onClose} /> : null}
      {dialog?.kind === 'photos' ? <PhotosDialog model={dialog.model} actions={actions?.dialog?.photos} /> : null}
      {dialog?.kind === 'photo' ? <PhotoViewer model={dialog.model} onIndex={actions?.dialog?.photo?.onIndex} onClose={actions?.dialog?.photo?.onClose} onRetry={actions?.dialog?.photo?.onRetry} /> : null}
    </div>
  )
}

// ── shared bits ─────────────────────────────────────────────────────────────────────────────────────────────────────
function NextStepLine({ forYou, text }: { forYou: boolean; text: string }) {
  const { t } = useReturnWords()
  return (
    <div className={forYou ? 'fw-pret-nextbox is-yours' : 'fw-pret-nextbox'}>
      <span className="fw-pret-nextlabel">{forYou ? t('next.forYou') : t('next.ours')}</span>
      <p className="fw-pret-strong">{text}</p>
    </div>
  )
}

function Photos({ photos, label, held, onAdd, onOpen, fileHeld }: { photos: readonly CaseFile[]; label: string; held: string | null; onAdd?: () => void; onOpen?: (index: number) => void; fileHeld: string | null }) {
  const { t, date } = useReturnWords()
  return (
    <div className="fw-pret-photos">
      {photos.length === 0 ? <p className="fw-pret-quiet">{t('request.noPhotos')}</p> : null}
      {photos.length > 0 ? (
        <ul className="fw-pret-filelist" aria-label={label}>
          {photos.map((photo, index) => (
            <li key={photo.id}>
              <FileRow
                name={photo.name}
                size={photo.sizeBytes}
                status={t('request.photoAdded', { date: date(photo.addedAt) })}
                actions={
                  <Button size="sm" variant="quiet" heldReason={fileHeld} onClick={() => onOpen?.(index)}>
                    {t('request.view')}
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
      {onAdd ? (
        <div>
          <Button size="sm" heldReason={held} onClick={onAdd}>
            <ImagePlus size={14} aria-hidden /> {t('request.addPhotos')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

// ── Return › Request ────────────────────────────────────────────────────────────────────────────────────────────────
function ReturnRequest({ model, record, actions }: { model: CaseRecordViewModel; record: ReturnRecord; actions?: CaseRecordActions }) {
  const { t, locale, at } = useReturnWords()
  const takes = ['REQUESTED', 'AUTHORISED', 'RECEIVED'].includes(record.status)
  const request = record.request
  return (
    <div className="fw-pret-tab">
      <section className="fw-pret-section" aria-labelledby="fw-pret-what">
        <h2 id="fw-pret-what" className="fw-pret-h2">
          {t('request.what')}
        </h2>
        <Card padded>
          <KeyValue
            columns={2}
            items={[
              { label: t('request.opened'), value: at(request.opened) },
              { label: t('request.via'), value: t(viaKey(request.via)) },
              { label: t('request.outcome'), value: request.outcomeWanted ? t(`outcome.${request.outcomeWanted.code}`) : t('start.outcomeNone') },
              { label: t('request.yourRef'), value: record.yourRef ?? '—' },
            ]}
          />
          {request.note ? (
            <div className="fw-pret-block">
              <h3 className="fw-pret-h3">{t('request.note')}</h3>
              <p className="fw-pret-pre">{request.note}</p>
            </div>
          ) : null}
        </Card>
      </section>
      <section className="fw-pret-section" aria-labelledby="fw-pret-lines">
        <h2 id="fw-pret-lines" className="fw-pret-h2">
          {t('request.items')}
          <span className="fw-pret-h2-count">{request.lines.length}</span>
        </h2>
        {request.lines.map((line) => (
          <Card padded key={line.id} className="fw-pret-line">
            <h3 className="fw-pret-h3">{t('request.line', { seq: line.seq, description: line.description })}</h3>
            <KeyValue
              columns={2}
              items={[
                { label: t('request.pieces'), value: String(line.pieces) },
                { label: t('request.size'), value: line.size ?? '—' },
                { label: t('request.serial'), value: line.serial ?? '—' },
                { label: t('request.reason'), value: [line.reason.words[locale], line.reasonNote].filter(Boolean).join(': ') },
              ]}
            />
            <h4 className="fw-pret-h4">{t('request.linePhotos')}</h4>
            <Photos photos={line.photos} label={t('request.linePhotos')} held={model.photosHeld} onAdd={takes ? () => actions?.onPhotos?.(line.id) : undefined} onOpen={(index) => actions?.onPhoto?.(line.photos, index)} fileHeld={model.fileHeld} />
          </Card>
        ))}
      </section>
      <section className="fw-pret-section" aria-labelledby="fw-pret-photos">
        <h2 id="fw-pret-photos" className="fw-pret-h2">
          {t('request.photos')}
        </h2>
        <p className="fw-pret-hint">{takes ? t('request.photosHint') : t('request.photosClosed')}</p>
        <Photos photos={request.photos} label={t('request.photos')} held={model.photosHeld} onAdd={takes ? () => actions?.onPhotos?.(null) : undefined} onOpen={(index) => actions?.onPhoto?.(request.photos, index)} fileHeld={model.fileHeld} />
      </section>
    </div>
  )
}

// ── Return › Status ─────────────────────────────────────────────────────────────────────────────────────────────────
function ReturnStatus({ model, record, actions }: { model: CaseRecordViewModel; record: ReturnRecord; actions?: CaseRecordActions }) {
  const { t, locale, at, day } = useReturnWords()
  const ds = useDsWords()
  const progress = record.progress
  return (
    <div className="fw-pret-tab">
      <section className="fw-pret-section" aria-labelledby="fw-pret-where">
        <h2 id="fw-pret-where" className="fw-pret-h2">
          {t('status.where')}
        </h2>
        <Card padded className="fw-pret-where">
          <MilestoneTracker steps={returnSteps(progress.milestones, t, at)} label={t('status.steps', { number: record.number })} labels={ds.milestoneTracker} />
          <NextStepLine forYou={record.next.forYou} text={record.next.words[locale]} />
          {progress.decision ? (
            <p className="fw-pret-decision">
              <span className="fw-pret-sub">{t('status.decision')}</span> {progress.decision[locale]}
            </p>
          ) : null}
        </Card>
      </section>
      {progress.instructions || record.status === 'AUTHORISED' ? (
        <section className="fw-pret-section" aria-labelledby="fw-pret-label">
          <h2 id="fw-pret-label" className="fw-pret-h2">
            {t('status.label')}
          </h2>
          <Card padded className="fw-pret-labelcard">
            <p className="fw-pret-strong">{progress.goodsDueBy ? t('status.sendBy', { date: day(progress.goodsDueBy) }) : t('status.sendBack')}</p>
            {progress.sendTo ? <p className="fw-pret-hint">{t('status.sendTo', { site: progress.sendTo })}</p> : null}
            <p className="fw-pret-hint">{t('status.labelHint')}</p>
            {model.labelHref ? (
              <div className="fw-pret-buttons">
                <Button asChild variant="primary" size="sm">
                  <a href={model.labelHref} target="_blank" rel="noopener noreferrer">
                    <Printer size={14} aria-hidden /> {t('status.print')}
                  </a>
                </Button>
              </div>
            ) : null}
          </Card>
        </section>
      ) : null}
      <section className="fw-pret-section" aria-labelledby="fw-pret-parcels">
        <h2 id="fw-pret-parcels" className="fw-pret-h2">
          {t('status.parcels')}
        </h2>
        {progress.parcels.length === 0 ? (
          <p className="fw-pret-quiet">{record.status === 'AUTHORISED' ? t('status.parcelsWaiting') : t('status.parcelsNone')}</p>
        ) : (
          <SummaryTable
            label={t('status.parcels')}
            columns={[t('status.receivedAt'), t('status.parcelCount'), t('status.carrier'), t('status.tracking')]}
            rows={progress.parcels.map((parcel, index) => ({ id: String(index), cells: [at(parcel.receivedAt), String(parcel.parcels), parcel.carrier ?? '—', parcel.trackingNumber ?? '—'] }))}
            align={[undefined, 'right', undefined, undefined]}
            stackOnPhone
          />
        )}
      </section>
      <section className="fw-pret-section" aria-labelledby="fw-pret-inspection">
        <h2 id="fw-pret-inspection" className="fw-pret-h2">
          {t('status.inspection')}
        </h2>
        {progress.inspection.length === 0 ? (
          <p className="fw-pret-quiet">{t('status.inspectionNone')}</p>
        ) : (
          <SummaryTable
            label={t('status.inspection')}
            columns={[t('status.item'), t('status.received'), t('status.grade'), t('status.outcome')]}
            rows={progress.inspection.map((entry) => {
              const line = lineBySeq(record, entry.seq)
              return {
                id: String(entry.seq),
                cells: [line ? t('request.line', { seq: entry.seq, description: line.description }) : String(entry.seq), String(entry.received), entry.grade ? t(`grade.${entry.grade.code}`) : '—', entry.outcome ? t(`disposition.${entry.outcome.code}`) : t('status.outcomePending')],
              }
            })}
            align={[undefined, 'right', undefined, undefined]}
            stackOnPhone
          />
        )}
      </section>
      <section className="fw-pret-section" aria-labelledby="fw-pret-outcome">
        <h2 id="fw-pret-outcome" className="fw-pret-h2">
          {t('status.result')}
        </h2>
        {progress.creditNotes.length === 0 && !progress.replacementOrder ? <p className="fw-pret-quiet">{record.status === 'CLOSED' ? t('status.resultClosed') : t('status.resultNone')}</p> : null}
        {progress.creditNotes.length > 0 ? (
          <ul className="fw-pret-filelist" aria-label={t('status.creditNotes')}>
            {progress.creditNotes.map((note) => (
              <li key={note.id}>
                <FileRow
                  name={t('status.creditNote', { number: note.number ?? '—' })}
                  status={note.issueDate ? t('status.issued', { date: day(note.issueDate) }) : t('status.notIssued')}
                  actions={
                    <Button size="sm" variant="quiet" heldReason={!note.pdfFileId ? t('held.noPdf') : (model.creditHeld ?? model.fileHeld)} onClick={() => actions?.onCreditNote?.(note.id)}>
                      <ExternalLink size={13} aria-hidden /> {t('status.openPdf')}
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        ) : null}
        {progress.replacementOrder ? (
          <p className="fw-pret-replacement">
            <span>{t('status.replacement')}</span>{' '}
            <a href={`${model.prefix}/open/SalesOrder/${encodeURIComponent(progress.replacementOrder.id)}`}>{progress.replacementOrder.number}</a>
          </p>
        ) : null}
      </section>
    </div>
  )
}

// ── Complaint › Request ─────────────────────────────────────────────────────────────────────────────────────────────
function ComplaintRequest({ model, record, actions }: { model: CaseRecordViewModel; record: ComplaintRecord; actions?: CaseRecordActions }) {
  const { t, at } = useReturnWords()
  const ds = useDsWords()
  const request = record.request
  const takes = ['NEW', 'TRIAGED', 'INVESTIGATING'].includes(record.status)
  return (
    <div className="fw-pret-tab">
      <section className="fw-pret-section" aria-labelledby="fw-pret-what">
        <h2 id="fw-pret-what" className="fw-pret-h2">
          {t('request.reported')}
        </h2>
        <Card padded>
          <KeyValue
            columns={2}
            items={[
              { label: t('request.opened'), value: at(request.opened) },
              { label: t('request.via'), value: t(viaKey(request.via)) },
              { label: t('request.item'), value: request.item.style ? `${request.item.style.code} ${request.item.style.name}` : '—' },
              { label: t('request.size'), value: request.item.size ?? '—' },
              { label: t('request.serial'), value: request.item.serial ?? '—' },
              { label: t('request.batch'), value: request.item.batchNumber ?? '—' },
              {
                label: t('request.order'),
                value: request.order ? (
                  <a href={`${model.prefix}/open/SalesOrder/${encodeURIComponent(request.order.id)}`}>
                    <RefPair theirs={request.order.yourRef} ours={request.order.number} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} size="sm" copy={false} labels={ds.refPair} />
                  </a>
                ) : (
                  '—'
                ),
              },
              { label: t('request.shipment'), value: request.shipment?.number ?? '—' },
              { label: t('request.yourRef'), value: record.yourRef ?? '—' },
            ]}
          />
          <div className="fw-pret-block">
            <h3 className="fw-pret-h3">{t('request.happened')}</h3>
            <p className="fw-pret-pre">{request.description}</p>
          </div>
        </Card>
      </section>
      <section className="fw-pret-section" aria-labelledby="fw-pret-photos">
        <h2 id="fw-pret-photos" className="fw-pret-h2">
          {t('request.photos')}
        </h2>
        <p className="fw-pret-hint">{takes ? t('request.photosHint') : t('request.photosAnswered')}</p>
        <Photos photos={request.photos} label={t('request.photos')} held={model.photosHeld} onAdd={takes ? () => actions?.onPhotos?.(null) : undefined} onOpen={(index) => actions?.onPhoto?.(request.photos, index)} fileHeld={model.fileHeld} />
      </section>
    </div>
  )
}

// ── Complaint › Status ──────────────────────────────────────────────────────────────────────────────────────────────
function ComplaintStatus({ model, record, actions }: { model: CaseRecordViewModel; record: ComplaintRecord; actions?: CaseRecordActions }) {
  const { t, locale, at, day } = useReturnWords()
  const ds = useDsWords()
  const investigation = record.investigation
  const documents = (investigation?.documents ?? []).filter((doc) => doc.current || doc.role !== 'ANSWER_LETTER')
  return (
    <div className="fw-pret-tab">
      <section className="fw-pret-section" aria-labelledby="fw-pret-where">
        <h2 id="fw-pret-where" className="fw-pret-h2">
          {t('status.where')}
        </h2>
        <Card padded className="fw-pret-where">
          <MilestoneTracker steps={complaintSteps(record, t, at)} label={t('status.steps', { number: record.number })} labels={ds.milestoneTracker} />
          <NextStepLine forYou={record.next.forYou} text={record.next.words[locale]} />
          {record.progress.answerBy && !record.progress.answeredAt && record.next.code === 'ANSWER_US' ? <p className="fw-pret-hint">{t('status.answerBy', { date: day(record.progress.answerBy) })}</p> : null}
        </Card>
      </section>
      <section className="fw-pret-section" aria-labelledby="fw-pret-8d">
        <h2 id="fw-pret-8d" className="fw-pret-h2">
          {t('status.investigation')}
        </h2>
        {!investigation ? (
          <p className="fw-pret-quiet">{t('status.investigationQuality')}</p>
        ) : (
          <Card padded className="fw-pret-where">
            {investigation.capa ? (
              <p className="fw-pret-hint">{t(investigation.capa.type === 'EIGHT_D' ? 'status.eightD' : 'status.capa', { number: investigation.capa.number })}</p>
            ) : null}
            {investigation.steps && investigation.steps.length > 0 ? (
              <MilestoneTracker steps={disciplineSteps(investigation.steps, locale, day)} label={t('status.investigationSteps', { number: record.number })} labels={ds.milestoneTracker} />
            ) : (
              <p className="fw-pret-quiet">{t('status.investigationNone')}</p>
            )}
            {investigation.answeredAt ? <p className="fw-pret-hint">{t(investigation.answeredVia === 'EMAIL' ? 'status.answeredEmail' : 'status.answeredPortal', { date: at(investigation.answeredAt) })}</p> : null}
            {documents.length > 0 ? (
              <ul className="fw-pret-filelist" aria-label={t('status.documents')}>
                {documents.map((doc) => (
                  <li key={doc.id}>
                    <FileRow
                      name={documentName(doc, t)}
                      size={doc.sizeBytes}
                      status={t('status.documentAdded', { date: at(doc.addedAt) })}
                      actions={
                        <Button size="sm" variant="quiet" heldReason={model.fileHeld} onClick={() => actions?.onDocument?.(doc)}>
                          <FileText size={13} aria-hidden /> {t('status.openPdf')}
                        </Button>
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fw-pret-quiet">{t('status.documentsNone')}</p>
            )}
          </Card>
        )}
      </section>
    </div>
  )
}

function documentName(doc: CaseDocument, t: (key: string, params?: Readonly<Record<string, string | number>>) => string): string {
  if (doc.role === 'ANSWER_LETTER') return doc.version ? t('status.letterV', { version: doc.version }) : t('status.letter')
  if (doc.role === 'EIGHT_D') return t('status.eightDReport')
  return doc.name
}
