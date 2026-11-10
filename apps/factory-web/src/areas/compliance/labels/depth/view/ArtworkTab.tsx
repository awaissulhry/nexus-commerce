'use client'

import Link from 'next/link'
import { ExternalLink, FileUp, Send } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { SignOffPanel, type SignOffStep } from '@nexus/ui/components/SignOffPanel/index'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { FileDropzone, Modal, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import type { LabelDetail } from '../../api'
import type { LabelRecordActions, RecordDepth, RecordDialog } from '../../view-model'
import type { Artwork, ArtworkVersion } from '../api'
import { addProofHeld, approveHeld, currentVersion, isPdf, PROOF_MAX_BYTES, proofFileProblem, removeHeld, retireHeld } from '../model'
import { PanelRead } from './parts'

const STATUS_TONE: Record<ArtworkVersion['status'], 'info' | 'success' | 'neutral'> = { DRAFT: 'info', APPROVED: 'success', RETIRED: 'neutral' }

/**
 * Label › Artwork & approval (design rec:Label tab `artwork`, lb-art; PRD-347; B-W2b-259): the proofs of this label
 * revision, newest first — the one approved now prints; a draft waits for a person other than its author (SignOffPanel:
 * made by, approved by a second person, the brand's approval through the portal said as not built yet) — each opened in a
 * new tab (the label proof, design tab lb-proof), approved in the dialog with the proof beside its sign-off (pop:lb-approve),
 * retired, or removed while a draft; and the work orders released with this revision with the proof their labels follow
 * (the one in force at their first print: reprints use the same). Add a proof uploads a PDF or a picture as a file of the
 * label. Every write is explicit; held buttons say why.
 */
export function ArtworkTab({ detail, depth, prefix, workOrders, actions }: { detail: LabelDetail; depth: RecordDepth; prefix: string; workOrders: boolean; actions?: LabelRecordActions }) {
  const d = useT('compliance-labels-depth')
  return (
    <PanelRead read={depth.artwork} failedTitle={d('artwork.failed')} onRetry={actions?.onRetryArtwork} rows={4}>
      {(artwork) => <Proofs detail={detail} artwork={artwork} depth={depth} prefix={prefix} workOrders={workOrders} actions={actions} />}
    </PanelRead>
  )
}

function Proofs({ detail, artwork, depth, prefix, workOrders, actions }: { detail: LabelDetail; artwork: Artwork; depth: RecordDepth; prefix: string; workOrders: boolean; actions?: LabelRecordActions }) {
  const d = useT('compliance-labels-depth')
  const locale = useLocale()
  const add = addProofHeld(artwork, depth.can, false)
  const current = currentVersion(artwork)
  return (
    <div className="fw-q-two">
      <Card padded>
        <section className="fw-q-section" aria-labelledby="lb-h-art">
          <div className="fw-q-section-head">
            <div className="fw-q-section-title">
              <h2 id="lb-h-art">{d('artwork.title')}</h2>
              <p className="fw-q-hint">{artwork.approvedId ? d('artwork.introApproved') : d('artwork.introNone')}</p>
            </div>
            <span className="fw-q-actions">
              <Button size="sm" variant="primary" heldReason={add ? d(add) : null} onClick={() => actions?.onDialog?.({ kind: 'addProof', note: '' })}>
                <FileUp size={13} aria-hidden /> {d('artwork.add')}
              </Button>
              <Button size="sm" heldReason={d('held.brandLater')}>
                <Send size={13} aria-hidden /> {d('artwork.send')}
              </Button>
            </span>
          </div>
          {artwork.versions.length === 0 ? (
            <EmptyState title={d('artwork.empty')} description={d(artwork.mayManage ? 'artwork.emptyBody' : 'artwork.emptyBodyView')} />
          ) : (
            <ol className="fw-lbd-versions">
              {artwork.versions.map((version) => (
                <li key={version.id} className="fw-lbd-version">
                  <div className="fw-q-section-head">
                    <span className="fw-q-cell-row">
                      <b>{d('artwork.version', { n: version.versionNo })}</b>
                      <Pill tone={STATUS_TONE[version.status]} dot>
                        {d(`artworkStatus.${version.status}`)}
                      </Pill>
                      {version.id === artwork.approvedId && <span className="fw-q-hint">{d('artwork.prints')}</span>}
                    </span>
                    <span className="fw-q-actions">
                      <Button size="sm" heldReason={version.file ? null : d('held.noFile')} onClick={() => actions?.onOpenProof?.(version.id)} aria-label={d('artwork.openN', { n: version.versionNo })}>
                        <ExternalLink size={13} aria-hidden /> {d('artwork.open')}
                      </Button>
                    </span>
                  </div>
                  <p className="fw-q-hint">
                    {version.file ? version.file.name : d('artwork.noFile')} · {d('artwork.madeBy', { name: version.author?.name ?? '—', time: formatDateTime(version.createdAt, { locale }) })}
                    {version.byYou ? ` · ${d('artwork.byYou')}` : ''}
                  </p>
                  {version.note && <p className="fw-lbd-note">{version.note}</p>}
                  {/* The proof that prints and every proof waiting: its sign-off, a held approval saying why on screen. */}
                  {(version.id === current?.id || version.status === 'DRAFT') && <SignOff detail={detail} version={version} artwork={artwork} onApprove={() => actions?.onDialog?.({ kind: 'approveProof', versionId: version.id, reason: '' })} />}
                  {version.id !== current?.id && version.status === 'APPROVED' && <p className="fw-q-hint">{d('artwork.approvedBy', { name: version.approvedBy?.name ?? '—', time: version.approvedAt ? formatDateTime(version.approvedAt, { locale }) : '—' })}</p>}
                  <span className="fw-q-actions">
                    {version.status !== 'RETIRED' && (
                      <Button size="sm" variant="danger-outline" heldReason={retireHeld(version, artwork, false) ? d(retireHeld(version, artwork, false)!) : null} onClick={() => actions?.onDialog?.({ kind: 'retireProof', versionId: version.id, reason: '' })}>
                        {d('artwork.retire')}
                      </Button>
                    )}
                    {version.status === 'DRAFT' && (
                      <Button size="sm" variant="quiet" heldReason={removeHeld(version, artwork, false) ? d(removeHeld(version, artwork, false)!) : null} onClick={() => actions?.onRemoveProof?.(version.id)}>
                        {d('artwork.remove')}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </Card>
      <Card padded>
        <section className="fw-q-section" aria-labelledby="lb-h-art-wo">
          <div className="fw-q-section-head">
            <div className="fw-q-section-title">
              <h2 id="lb-h-art-wo">{d('artwork.workOrders')}</h2>
              <p className="fw-q-hint">{d('artwork.workOrdersIntro')}</p>
            </div>
          </div>
          {artwork.workOrders.length === 0 ? (
            <p className="fw-q-hint">{d('artwork.noWorkOrders')}</p>
          ) : (
            <SummaryTable
              label={d('artwork.workOrders')}
              stackOnPhone
              columns={[d('artwork.col.workOrder'), d('artwork.col.firstPrint'), d('artwork.col.follows')]}
              rows={artwork.workOrders.map((order) => ({
                id: order.id,
                cells: [
                  workOrders ? (
                    <Link key="w" className="fw-q-link fw-q-code" href={`${prefix}/production/work-orders/${encodeURIComponent(order.id)}`}>
                      {order.number}
                    </Link>
                  ) : (
                    <span key="w" className="fw-q-code">
                      {order.number}
                    </span>
                  ),
                  order.firstPrintAt ? formatDateTime(order.firstPrintAt, { locale }) : d('artwork.notPrinted'),
                  order.artwork ? d('artwork.version', { n: order.artwork.versionNo }) : order.firstPrintAt ? d('artwork.followsNone') : d('artwork.followsLater'),
                ],
              }))}
            />
          )}
        </section>
      </Card>
    </div>
  )
}

/** The proof's sign-off: made by its author, approved by a second person, and (a brand's label) the brand's approval. */
function SignOff({ detail, version, artwork, busy = false, onApprove }: { detail: LabelDetail; version: ArtworkVersion; artwork: Artwork; busy?: boolean; onApprove?: () => void }) {
  const d = useT('compliance-labels-depth')
  const ds = useDsWords()
  const locale = useLocale()
  const held = approveHeld(version, artwork, busy)
  const steps: SignOffStep[] = [
    { id: 'made', label: d('signoff.made'), role: d('signoff.madeRole'), state: 'signed', signer: version.author?.name ?? '—', signedAt: formatDateTime(version.createdAt, { locale }) },
    {
      id: 'approved',
      label: d('signoff.approved'),
      role: d('signoff.approvedRole'),
      state: version.status === 'APPROVED' ? 'signed' : version.status === 'RETIRED' && !version.approvedAt ? 'rejected' : version.status === 'RETIRED' ? 'signed' : held && held !== 'held.busy' ? 'held' : 'waiting',
      ...(version.approvedBy ? { signer: version.approvedBy.name, signedAt: version.approvedAt ? formatDateTime(version.approvedAt, { locale }) : undefined } : {}),
      ...(version.status === 'RETIRED' && !version.approvedAt ? { rejectedReason: d('signoff.retiredUnapproved') } : {}),
      whoMay: d('signoff.whoMay'),
      heldReason: version.status === 'DRAFT' && held ? d(held) : null,
      rules: [{ id: 'author', kind: 'authorNotApprover', state: version.byYou ? 'broken' : 'met', text: version.byYou ? d('signoff.ruleYours') : d('signoff.ruleOk') }],
      ...(version.status === 'DRAFT' && onApprove ? { action: { label: d('artwork.approve'), onClick: onApprove, busy } } : {}),
    },
    ...(detail.makerPartyId
      ? [{ id: 'brand', label: d('signoff.brand'), role: d('signoff.brandRole'), state: 'held' as const, heldReason: d('held.brandLater') }]
      : []),
  ]
  return <SignOffPanel title={d('signoff.title')} steps={steps} labels={ds.signOffPanel} headingLevel={3} />
}

/** pop:lb-approve — the proof beside its sign-off; Approve proof by a person other than its author. */
export function ApproveProofDialog({ detail, depth, dialog, busy, actions }: { detail: LabelDetail; depth: RecordDepth; dialog: Extract<RecordDialog, { kind: 'approveProof' }>; busy: boolean; actions?: LabelRecordActions }) {
  const d = useT('compliance-labels-depth')
  const q = useT('quality')
  const shell = useT('shell')
  const artwork = depth.artwork.value
  const version = artwork?.versions.find((entry) => entry.id === dialog.versionId) ?? null
  const close = () => actions?.onDialog?.(null)
  if (!artwork || !version) return null
  const held = approveHeld(version, artwork, busy)
  const src = depth.proof?.versionId === version.id ? depth.proof.src : null
  const title = d('approve.title', { code: detail.code, revision: detail.revision, n: version.versionNo })
  return (
    <Modal
      open
      onClose={close}
      size="xl"
      title={title}
      footer={
        <>
          <Button onClick={close}>{q('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? d(held) : null} onClick={() => actions?.onApproveProof?.(version.id, dialog.reason)}>
            {busy ? <Spinner size={12} /> : null} {d('approve.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-lbd-approve">
        <div className="fw-lbd-approve-proof">
          {!version.file ? (
            <Banner tone="warning" title={d('artwork.noFile')} />
          ) : !src || src.problem ? (
            src?.problem ? (
              <Banner
                tone="warning"
                title={d('approve.proofFailed')}
                action={
                  <Button size="sm" onClick={() => actions?.onRetryProof?.()}>
                    {q('common.retry')}
                  </Button>
                }
              />
            ) : (
              <p className="fw-q-loading" role="status">
                <Spinner size={14} /> {d('approve.proofLoading')}
              </p>
            )
          ) : src.value === null ? (
            <p className="fw-q-loading" role="status">
              <Spinner size={14} /> {d('approve.proofLoading')}
            </p>
          ) : isPdf(version.file.contentType) && typeof src.value !== 'string' ? (
            <PdfViewer src={src.value} title={version.file.name} fileName={version.file.name} labels={pdfViewerLabels(shell)} height="min(60vh, 640px)" />
          ) : (
            <img className="fw-lbd-picture" src={typeof src.value === 'string' ? src.value : undefined} alt={d('approve.picture', { n: version.versionNo })} />
          )}
        </div>
        <div className="fw-q-form fw-lbd-dialog">
          {version.note && (
            <p>
              <span className="fw-q-hint">{d('approve.note', { name: version.author?.name ?? '—' })}</span> {version.note}
            </p>
          )}
          <SignOff detail={detail} version={version} artwork={artwork} busy={busy} />
          <Field label={d('approve.comment')} hint={d('approve.commentHint')}>
            <Textarea rows={2} maxLength={300} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
          </Field>
          <p className="fw-q-hint">{artwork.approvedId && artwork.approvedId !== version.id ? d('approve.replaces', { n: artwork.versions.find((entry) => entry.id === artwork.approvedId)?.versionNo ?? '—' }) : d('approve.first')}</p>
          <Problem />
        </div>
      </div>
    </Modal>
  )

  function Problem() {
    if (!depth.cellProblem || depth.cellProblem.at !== `proof|${version!.id}`) return null
    return (
      <Banner tone="danger" title={d(depth.cellProblem.key)}>
        {depth.cellProblem.lines && depth.cellProblem.lines.length > 0 && <span lang="en">{depth.cellProblem.lines.join(' ')}</span>}
      </Banner>
    )
  }
}

/** Add a proof: a PDF or a picture uploaded as a file of the label, with a note; a draft that waits for a second person. */
export function AddProofDialog({ detail, depth, dialog, busy, actions }: { detail: LabelDetail; depth: RecordDepth; dialog: Extract<RecordDialog, { kind: 'addProof' }>; busy: boolean; actions?: LabelRecordActions }) {
  const d = useT('compliance-labels-depth')
  const q = useT('quality')
  const artwork = depth.artwork.value
  const close = () => actions?.onDialog?.(null)
  const picked = depth.picked
  const fileProblem = proofFileProblem(picked ? { contentType: picked.contentType, size: picked.size } : null)
  const base = artwork ? addProofHeld(artwork, depth.can, busy) : 'held.busy'
  const held = base ?? fileProblem
  const problem = depth.cellProblem?.at === 'proof|add' ? depth.cellProblem : null
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={d('add.title', { code: detail.code, revision: detail.revision })}
      footer={
        <>
          <Button onClick={close}>{q('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? d(held) : null} onClick={() => actions?.onAddProof?.(dialog.note)}>
            {busy ? <Spinner size={12} /> : null} {d('add.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-q-form fw-lbd-dialog">
        <p className="fw-q-hint">{d('add.intro')}</p>
        <FileDropzone accept=".pdf,.png,.jpg,.jpeg,.webp" maxBytes={PROOF_MAX_BYTES} onFiles={(files) => actions?.onPickProof?.(files[0] ?? null)} hint={d('add.hint')} />
        {picked && (
          <p className="fw-q-cell-row">
            <b>{picked.name}</b> <span className="fw-q-hint">{d('add.size', { kb: Math.max(1, Math.round(picked.size / 1024)) })}</span>
            {fileProblem && <span className="fw-lb-error">{d(fileProblem)}</span>}
          </p>
        )}
        <Field label={d('add.note')} hint={d('add.noteHint')}>
          <Textarea rows={2} maxLength={500} value={dialog.note} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
        </Field>
        {problem && (
          <Banner tone="danger" title={d(problem.key)}>
            {problem.lines && problem.lines.length > 0 && <span lang="en">{problem.lines.join(' ')}</span>}
          </Banner>
        )}
      </div>
    </Modal>
  )
}

/** Retire a proof: it no longer prints (the approved one); a draft goes out of the way. Kept on record. */
export function RetireProofDialog({ depth, dialog, busy, actions }: { depth: RecordDepth; dialog: Extract<RecordDialog, { kind: 'retireProof' }>; busy: boolean; actions?: LabelRecordActions }) {
  const d = useT('compliance-labels-depth')
  const q = useT('quality')
  const artwork = depth.artwork.value
  const version = artwork?.versions.find((entry) => entry.id === dialog.versionId) ?? null
  const close = () => actions?.onDialog?.(null)
  if (!artwork || !version) return null
  const held = retireHeld(version, artwork, busy)
  const problem = depth.cellProblem?.at === `proof|${version.id}` ? depth.cellProblem : null
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={d('retireProof.title', { n: version.versionNo })}
      footer={
        <>
          <Button onClick={close}>{q('common.cancel')}</Button>
          <Button variant="danger" heldReason={held ? d(held) : null} onClick={() => actions?.onRetireProof?.(version.id, dialog.reason)}>
            {busy ? <Spinner size={12} /> : null} {d('retireProof.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-q-form fw-lbd-dialog">
        <p>{version.status === 'APPROVED' ? d('retireProof.approved') : d('retireProof.draft')}</p>
        <Field label={d('retireProof.reason')} hint={d('retireProof.reasonHint')}>
          <Textarea rows={2} maxLength={300} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
        </Field>
        {problem && <Banner tone="danger" title={d(problem.key)} />}
      </div>
    </Modal>
  )
}
