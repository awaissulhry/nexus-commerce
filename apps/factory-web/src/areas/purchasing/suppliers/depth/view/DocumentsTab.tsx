'use client'

import { Banner, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import Link from 'next/link'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { ChangeRequest, Qualification, Qualifications, Vault } from '../api'
import { ASK_TONE, askWordsOf, changeLines, DOC_TONE, expiryWords, gateWords, moveHeld, nextStepWords, STANDING_TONE, type DepthCan, type Read, type Words } from '../model'
import { DocumentsDialogs, type DocumentsDialog, type DocumentsDialogActions } from './DocumentsDialogs'
import { DepthCard, ReadOr, useSay } from './parts'
// B-W2b-382 (B-W2b-377's document types): what each document is, and its picker.
import type { DocTypeActions, DocTypeModel } from '../doc-type/use-doc-type'
import { DocTypeCell, DocTypeDialog } from '../doc-type/view/DocType'

export interface DocumentsTabModel {
  readonly vault: Read<Vault>
  /** The profile changes waiting for our check (null: the person may not decide them). */
  readonly changes: Read<readonly ChangeRequest[]> | null
  readonly qualifications: Read<Qualifications>
  readonly can: DepthCan
  readonly today: string
  /** The record's Questionnaire tab (null: not in the person's access). */
  readonly questionnaireHref: string | null
  readonly notice: { readonly tone: 'success' | 'warning' | 'danger' | 'info'; readonly words: Words } | null
  readonly dialog: DocumentsDialog | null
  /** The record's own companies (a qualification is per company). */
  readonly companies: ReadonlyArray<{ id: string; name: string }>
  /** B-W2b-382: the document types (absent: the types are not drawn). */
  readonly docType?: DocTypeModel
}

export interface DocumentsTabActions {
  onRetry?: () => void
  onOpenFile?: (fileId: string) => void
  onRequest?: () => void
  onAccept?: (uploadId: string) => void
  onRefuse?: (uploadId: string) => void
  onApproveChange?: (requestId: string) => void
  onRefuseChange?: (requestId: string) => void
  onAskQualification?: () => void
  onMove?: (qualificationId: string, move: 'decide' | 'suspend' | 'lift' | 'withdraw') => void
  onDismissNotice?: () => void
  dialogs?: DocumentsDialogActions
  docType?: DocTypeActions
}

/**
 * Documents & qualification (design rec:Supplier/documents): what we ask of this supplier by its kinds and what the
 * materials it sells us need — each with its state, its law and what it unlocks at PO send ("POs for A12 need a valid
 * chromium VI test report") —, the documents in force with their expiry, the office review of what the supplier sent
 * through its portal (accept with the kind and the last valid day, or refuse with why: it is asked again) and of the
 * company data it asks to change, and its qualifications (the workshop profile: what it is qualified for now, per kind of
 * work or material, on what evidence, until when). The record's files (upload, what a file is and until when) are below.
 */
export function DocumentsTab({ model, actions }: { model: DocumentsTabModel; actions?: DocumentsTabActions }) {
  const { t, say } = useSay()
  return (
    <div className="fw-spd-stack">
      {model.notice ? (
        <div role="status">
          <Banner
            tone={model.notice.tone}
            title={say(model.notice.words)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('notice.hide')}
              </Button>
            }
          />
        </div>
      ) : null}
      <VaultCard model={model} actions={actions} />
      <ReviewCard model={model} actions={actions} />
      <QualificationsCard model={model} actions={actions} />
      <DocumentsDialogs dialog={model.dialog} companies={model.companies} today={model.today} actions={actions?.dialogs} />
      {model.docType && <DocTypeDialog model={model.docType} actions={actions?.docType} />}
    </div>
  )
}

function VaultCard({ model, actions }: { model: DocumentsTabModel; actions?: DocumentsTabActions | undefined }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const title = t('vault.title')
  const vault = model.vault.status === 'ready' ? model.vault.value : null
  const day = (value: string | null) => (value ? formatDate(value, { locale }) : '—')
  const requestHeld = !model.can.ask ? t('held.ask') : null
  return (
    <DepthCard
      title={title}
      hint={t('vault.hint')}
      action={
        <>
          <Button size="sm" onClick={() => actions?.onRequest?.()} heldReason={requestHeld}>
            {t('vault.request')}
          </Button>
          {model.questionnaireHref ? (
            <Button size="sm" variant="quiet" asChild>
              <Link href={model.questionnaireHref}>{t('vault.questionnaire')}</Link>
            </Button>
          ) : null}
        </>
      }
    >
      <ReadOr status={model.vault.status} problem={model.vault.status === 'error' ? model.vault.problem : undefined} title={title} onRetry={actions?.onRetry} rows={5}>
        {vault ? (
          <div className="fw-spd-stack">
            <p className="fw-spd-next">{say(nextStepWords(vault))}</p>
            {gateWords(vault).map((words) => (
              <Banner key={words.key} tone="danger" title={say(words)} />
            ))}
            {vault.supplier.kinds.length === 0 ? <Banner tone="info" title={t('vault.noKinds')} /> : null}
            {vault.asked.length > 0 ? (
              <>
                <h3 className="fw-spd-subtitle">{t('vault.asked')}</h3>
                <SummaryTable
                  label={t('vault.asked')}
                  columns={[t('vault.col.document'), t('vault.col.required'), t('vault.col.law'), t('vault.col.state'), t('vault.col.expires')]}
                  stackOnPhone
                  rows={vault.asked.map((ask) => ({
                    id: ask.category,
                    cells: [
                      <span key="d" className="fw-spd-who">
                        <span>{askWordsOf(ask.codes).map(say).join(t('vault.or'))}</span>
                        <span className="fw-spd-hint">{t(`category.${ask.category}`)}</span>
                      </span>,
                      ask.required ? t('vault.required') : t('vault.askedOnly'),
                      ask.laws.length > 0 ? ask.laws.join(' · ') : '—',
                      <span key="s" className="fw-spd-tags">
                        <Pill tone={ASK_TONE[ask.state]}>{t(`ask.${ask.state}`)}</Pill>
                        {ask.waiting ? <Tag tone="info">{t('vault.waiting')}</Tag> : null}
                      </span>,
                      ask.expiresOn ? `${say(expiryWords(model.today, ask.expiresOn))} · ${day(ask.expiresOn)}` : '—',
                    ],
                  }))}
                />
              </>
            ) : null}
            {vault.materials.length > 0 ? (
              <>
                <h3 className="fw-spd-subtitle">{t('vault.materials')}</h3>
                <SummaryTable
                  label={t('vault.materials')}
                  columns={[t('vault.col.material'), t('vault.col.needs'), t('vault.col.law'), t('vault.col.state'), t('vault.col.atSend')]}
                  stackOnPhone
                  rows={vault.materials.map((material) => ({
                    id: `${material.itemId}:${material.needs}`,
                    cells: [
                      <span key="m" className="fw-spd-who">
                        <span className="fw-spd-code">{material.code}</span>
                        <span className="fw-spd-hint">{material.name}</span>
                      </span>,
                      material.certificate ? t('vault.needsCertificate', { number: material.certificate.number, standard: material.certificate.standard }) : t(`need.${material.needs}`),
                      material.law,
                      <Pill key="s" tone={ASK_TONE[material.state]}>
                        {t(`ask.${material.state}`)}
                      </Pill>,
                      material.heldAtSend ? <Pill tone="danger">{t('vault.held')}</Pill> : material.checkedAtSend ? t('vault.checked') : t('vault.notChecked'),
                    ],
                  }))}
                />
              </>
            ) : null}
            <h3 className="fw-spd-subtitle">{t('vault.inForce')}</h3>
            {vault.documents.length === 0 ? (
              <EmptyState title={t('vault.empty')} description={t('vault.emptyBody')} />
            ) : (
              <SummaryTable
                label={t('vault.inForce')}
                columns={[t('vault.col.file'), t('vault.col.kind'), t('vault.col.issuer'), t('vault.col.issued'), t('vault.col.expires'), t('vault.col.state'), t('vault.col.source')]}
                stackOnPhone
                rows={vault.documents.map((doc) => ({
                  id: doc.fileId,
                  cells: [
                    <span key="f" className="fw-spd-who">
                      <Button size="sm" variant="link" inline wrap onClick={() => actions?.onOpenFile?.(doc.fileId)} heldReason={model.can.files ? null : t('held.files')}>
                        {doc.name || t('vault.unnamed')}
                      </Button>
                      {doc.articleCodes.length > 0 ? <span className="fw-spd-hint">{t('vault.covers', { codes: doc.articleCodes.join(', ') })}</span> : null}
                    </span>,
                    model.docType ? (
                      <span key="k" className="fw-spd-who">
                        <span>{t(`category.${doc.category}`)}</span>
                        <DocTypeCell doc={doc} model={model.docType} actions={actions?.docType} />
                      </span>
                    ) : (
                      t(`category.${doc.category}`)
                    ),
                    <span key="i" className="fw-spd-who">
                      <span>{doc.issuer ?? '—'}</span>
                      {doc.number ? <span className="fw-spd-hint">{t('vault.number', { number: doc.number })}</span> : null}
                    </span>,
                    day(doc.issuedOn),
                    doc.expiresOn ? (
                      <span key="e" className="fw-spd-who">
                        <span>{say(expiryWords(model.today, doc.expiresOn))}</span>
                        <span className="fw-spd-hint">{day(doc.expiresOn)}</span>
                      </span>
                    ) : (
                      t('expiry.none')
                    ),
                    <Pill key="s" tone={DOC_TONE[doc.state]}>
                      {t(`doc.state.${doc.state}`)}
                    </Pill>,
                    t(`source.${doc.source}`),
                  ],
                }))}
              />
            )}
          </div>
        ) : null}
      </ReadOr>
    </DepthCard>
  )
}

function ReviewCard({ model, actions }: { model: DocumentsTabModel; actions?: DocumentsTabActions | undefined }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const title = t('review.title')
  const vault = model.vault.status === 'ready' ? model.vault.value : null
  const reviewHeld = model.can.review ? null : t('held.review')
  const decideHeld = model.can.decideChanges ? null : t('held.decideChanges')
  const changes = model.changes?.status === 'ready' ? model.changes.value : []
  if (!vault) return null
  const uploads = vault.review.uploads
  const empty = uploads.length === 0 && changes.length === 0 && (model.changes === null || model.changes.status === 'ready')
  return (
    <DepthCard title={title} hint={t('review.hint')}>
      {empty ? <p className="fw-spd-hint">{t('review.empty')}</p> : null}
      {uploads.length > 0 ? (
        <SummaryTable
          label={t('review.uploads')}
          columns={[t('review.col.document'), t('review.col.said'), t('review.col.for'), t('review.col.sent'), t('review.col.decide')]}
          stackOnPhone
          rows={uploads.map((upload) => ({
            id: upload.uploadId,
            cells: [
              <span key="d" className="fw-spd-who">
                <Button size="sm" variant="link" inline wrap onClick={() => actions?.onOpenFile?.(upload.fileId)} heldReason={model.can.files ? null : t('held.files')}>
                  {t(`category.${upload.category}`, {})}
                </Button>
                {upload.replacesFileId ? <span className="fw-spd-hint">{t('review.replaces')}</span> : null}
              </span>,
              <span key="s" className="fw-spd-who">
                <span>{[upload.issuer, upload.number ? t('vault.number', { number: upload.number }) : null].filter(Boolean).join(' · ') || '—'}</span>
                <span className="fw-spd-hint">
                  {upload.expiresOn ? t('review.until', { date: formatDate(upload.expiresOn, { locale }) }) : t('expiry.none')}
                  {upload.articleCodes.length > 0 ? ` · ${t('vault.covers', { codes: upload.articleCodes.join(', ') })}` : ''}
                </span>
                {upload.note ? <span className="fw-spd-hint">{t('review.note', { note: upload.note })}</span> : null}
              </span>,
              upload.record.label,
              <span key="w" className="fw-spd-who">
                <span>{upload.uploadedByName}</span>
                <span className="fw-spd-hint">{upload.receivedAt ? formatDateTime(upload.receivedAt, { locale }) : '—'}</span>
              </span>,
              <span key="a" className="fw-spd-actions">
                <Button size="sm" variant="primary" onClick={() => actions?.onAccept?.(upload.uploadId)} heldReason={reviewHeld}>
                  {t('review.accept')}
                </Button>
                <Button size="sm" variant="danger-outline" onClick={() => actions?.onRefuse?.(upload.uploadId)} heldReason={reviewHeld}>
                  {t('review.refuse')}
                </Button>
              </span>,
            ],
          }))}
        />
      ) : null}
      {model.changes === null && vault.review.changes.length > 0 ? <p className="fw-spd-hint">{t('review.changesHeld', { count: vault.review.changes.length })}</p> : null}
      {model.changes !== null ? (
        <ReadOr status={model.changes.status} problem={model.changes.status === 'error' ? model.changes.problem : undefined} title={t('review.changes')} onRetry={actions?.onRetry} rows={2}>
          {changes.map((request) => (
            <div key={request.requestId} className="fw-spd-change">
              <div className="fw-spd-change-text">
                <strong>{t('review.changeFrom', { name: request.sentBy ?? '—', date: formatDateTime(request.sentAt, { locale }) })}</strong>
                <ul className="fw-spd-list">
                  {changeLines(request.changes).map((line, index) => (
                    <li key={index}>
                      {say(line.words)}
                      {line.fields.length > 0 ? (
                        <span className="fw-spd-hint">
                          {' '}
                          {line.fields.map((field) => t('change.field', { field: t(`field.${field.field}`, {}), before: field.before, after: field.after })).join(' · ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {request.note ? <p className="fw-spd-hint">{t('review.note', { note: request.note })}</p> : null}
              </div>
              <span className="fw-spd-actions">
                <Button size="sm" variant="primary" onClick={() => actions?.onApproveChange?.(request.requestId)} heldReason={decideHeld}>
                  {t('review.approve')}
                </Button>
                <Button size="sm" variant="danger-outline" onClick={() => actions?.onRefuseChange?.(request.requestId)} heldReason={decideHeld}>
                  {t('review.refuse')}
                </Button>
              </span>
            </div>
          ))}
        </ReadOr>
      ) : null}
    </DepthCard>
  )
}

function QualificationsCard({ model, actions }: { model: DocumentsTabModel; actions?: DocumentsTabActions | undefined }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const title = t('qual.title')
  const read = model.qualifications
  const value = read.status === 'ready' ? read.value : null
  const askHeld = !model.can.qualify ? t('held.qualify') : value && !value.may.create ? t('qual.heldAsk') : null
  const company = (id: string) => model.companies.find((entry) => entry.id === id)?.name ?? '—'
  return (
    <DepthCard
      title={title}
      hint={t('qual.hint')}
      action={
        <Button size="sm" onClick={() => actions?.onAskQualification?.()} heldReason={askHeld}>
          {t('qual.ask')}
        </Button>
      }
    >
      <ReadOr status={read.status} problem={read.status === 'error' ? read.problem : undefined} title={title} onRetry={actions?.onRetry} rows={3}>
        {value ? (
          <div className="fw-spd-stack">
            {value.work.length > 0 ? (
              <SummaryTable
                label={t('qual.work')}
                columns={[t('qual.col.work'), t('qual.col.company'), t('qual.col.standing')]}
                stackOnPhone
                rows={value.work.map((row) => ({
                  id: `${row.companyId}:${row.workCentreKind}`,
                  cells: [t(`work.${row.workCentreKind}`, {}), company(row.companyId), <Pill key="s" tone={STANDING_TONE[row.standing]}>{t(`standing.${row.standing}`)}</Pill>],
                }))}
              />
            ) : null}
            {value.qualifications.length === 0 ? (
              <EmptyState title={t('qual.empty')} description={t('qual.emptyBody')} />
            ) : (
              value.qualifications.map((row) => <QualificationRow key={row.id} row={row} can={model.can} company={company(row.companyId)} locale={locale} onMove={actions?.onMove} say={say} t={t} />)
            )}
          </div>
        ) : null}
      </ReadOr>
    </DepthCard>
  )
}

function QualificationRow({
  row,
  can,
  company,
  locale,
  onMove,
  say,
  t,
}: {
  row: Qualification
  can: DepthCan
  company: string
  locale: string
  onMove?: ((id: string, move: 'decide' | 'suspend' | 'lift' | 'withdraw') => void) | undefined
  say: (words: Words | null | undefined) => string
  t: (key: string, params?: Record<string, string | number>) => string
}) {
  const day = (value: string | null) => (value ? formatDate(value, { locale: locale as 'it' | 'en' }) : '—')
  const scope = [...row.scope.workCentreKinds.map((kind) => t(`work.${kind}`, {})), ...row.scope.materialKinds.map((kind) => t(`material.${kind}`, {})), ...row.scope.operations.map((op) => op.code ?? op.name ?? '—')]
  const buttons = (['decide', 'suspend', 'lift', 'withdraw'] as const).filter((move) => (move === 'decide' ? row.status === 'PENDING' : move === 'lift' ? row.status === 'SUSPENDED' : row.status === 'APPROVED' || row.status === 'CONDITIONAL' || (move === 'withdraw' && row.status === 'SUSPENDED')))
  return (
    <div className="fw-spd-qual">
      <div className="fw-spd-qual-head">
        <span className="fw-spd-tags">
          <Pill tone={STANDING_TONE[row.standing.standing]} dot>
            {t(`standing.${row.standing.standing}`)}
          </Pill>
          {t(`qual.status.${row.status}`) !== t(`standing.${row.standing.standing}`) ? <Tag>{t(`qual.status.${row.status}`)}</Tag> : null}
          <span className="fw-spd-hint">{company}</span>
        </span>
        <span className="fw-spd-actions">
          {buttons.map((move) => (
            <Button key={move} size="sm" variant={move === 'decide' ? 'primary' : move === 'lift' ? undefined : 'danger-outline'} onClick={() => onMove?.(row.id, move)} heldReason={moveHeld(can, row, move) ? say(moveHeld(can, row, move)) : null}>
              {t(`qual.move.${move}`)}
            </Button>
          ))}
        </span>
      </div>
      <KeyValue
        columns={2}
        dense
        labelCase="sentence"
        items={[
          { label: t('qual.scope'), value: scope.length === 0 ? '—' : scope.join(', ') },
          { label: t('qual.days'), value: row.validFrom || row.validUntil ? t('qual.fromTo', { from: day(row.validFrom), to: row.validUntil ? day(row.validUntil) : t('qual.noEnd') }) : '—' },
          { label: t('qual.evidence'), value: row.evidence.length === 0 ? t('qual.noEvidence') : row.evidence.map((item) => `${t(`evidence.${item.recordType}`, {})}: ${item.label}${item.documents.some((doc) => doc.expired) ? ` (${t('qual.evidenceExpired')})` : ''}`).join(' · ') },
          ...(row.decided ? [{ label: t('qual.decided'), value: t('qual.decidedBy', { date: day(row.decided.at), name: row.decided.by?.name ?? '—' }) }] : []),
          ...(row.conditions ? [{ label: t('qual.conditions'), value: row.conditions }] : []),
          ...(row.refuseReason ? [{ label: t('qual.refuseReason'), value: row.refuseReason }] : []),
          ...(row.suspended ? [{ label: t('qual.suspended'), value: t('qual.whyOn', { date: day(row.suspended.at), reason: row.suspended.reason ?? '—' }) }] : []),
          ...(row.withdrawn ? [{ label: t('qual.withdrawn'), value: t('qual.whyOn', { date: day(row.withdrawn.at), reason: row.withdrawn.reason ?? '—' }) }] : []),
        ]}
      />
    </div>
  )
}
