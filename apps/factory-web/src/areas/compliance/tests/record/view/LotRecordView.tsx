'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal } from 'lucide-react'
import { Banner, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { isPageKey } from '../../../../quality/_shared/hooks'
import { CheckList, dash, Facts, NoAccess, NoticeBanner, RecordFrame, RecordProblem, RecordSkeleton, Section } from '../../../../quality/_shared/parts'
import type { LabResult, LotDecision, LotDetail, LotDocument } from '../../api'
import {
  blankDocument,
  blankResult,
  decisionHeld,
  decisionsFor,
  documentHeld,
  LEGAL_LIMIT,
  mgKg,
  primaryDecision,
  recordResultHeld,
  resultsNewestFirst,
  type DocumentDraft,
  type LotRecordModel,
  type RecordDialog,
  type RecordTab,
  type ResultDraft,
} from '../../model'
import { CrViMark, LabMessages, LotStatusPill, ShortcutsDialog } from '../../view/parts'
import { DecideDialog, DocumentDialog, ResultDialog } from './dialogs'

export interface LotRecordActions {
  onDialog?: (dialog: RecordDialog | null) => void
  onResultDraft?: (draft: ResultDraft) => void
  onResultFile?: (file: File) => void
  onSaveResult?: () => void
  onDocumentDraft?: (draft: DocumentDraft) => void
  onDocumentFile?: (file: File) => void
  onSaveDocument?: () => void
  onDecideDraft?: (draft: { code: string; reason: string }) => void
  onDecide?: (decision: LotDecision) => void
  onDownload?: (fileId: string) => void
  onCopy?: (text: string) => void
  onRetry?: () => void
  onDismissNotice?: () => void
  onDock?: () => void
}

/**
 * The lot record of Tests & substances (SCR-054; design compliance.tests "Test report" record in W1's shape, B-W1-34
 * part 2 "Lot record"): the band (the lot, its state and Cr VI mark, the next decision), then the tabs — Results & limits
 * (the Cr VI results newest first, a superseded one marked; read only), Documents (the supplier's documents and what the
 * lot needs), Release (the checklist in words, the decisions) and Activity (the record panels: thread, files, history).
 * Fetches nothing: LotRecord.tsx reads and writes; the record panels come in as `panels`.
 */
export function LotRecordView({ model, actions, panels }: { model: LotRecordModel; actions?: LotRecordActions; panels?: ReactNode }) {
  return (
    <LabMessages>
      <Record model={model} actions={actions} panels={panels} />
    </LabMessages>
  )
}

const TAB_IDS: readonly RecordTab[] = ['results', 'documents', 'release', 'activity']

function Record({ model, actions, panels }: { model: LotRecordModel; actions?: LotRecordActions; panels?: ReactNode }) {
  const t = useT('lab')
  const q = useT('quality')
  const locale = useLocale()
  const back = { href: `${model.prefix}/compliance/tests`, label: t('record.back') }
  const detail = model.detail.value
  const dialog = model.dialog ?? null
  const open = (next: RecordDialog | null) => actions?.onDialog?.(next)
  const lot = detail?.lot ?? null

  // c: record a result; r: the next decision (release, release again); ?: the keys.
  useEffect(() => {
    if (!lot || !detail) return
    const onKey = (event: KeyboardEvent) => {
      if (dialog || !isPageKey(event)) return
      if (event.key === 'c' && recordResultHeld(lot, model.can) === null) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'result' })
      } else if (event.key === 'r') {
        const primary = primaryDecision(lot)
        if (primary && decisionHeld(primary, detail, model.can, model.me) === null) {
          event.preventDefault()
          actions?.onDialog?.({ kind: 'decide', decision: primary })
        }
      } else if (event.key === '?') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'shortcuts' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, detail, dialog, lot, model.can, model.me])

  if (!model.can.lotsView) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />
  if (model.detail.problem) return <RecordProblem problem={model.detail.problem} back={<Link href={back.href}>{back.label}</Link>} onRetry={actions?.onRetry} />
  if (!detail || !lot) return <RecordSkeleton />

  const heldText = (decision: LotDecision): string | null => {
    const held = decisionHeld(decision, detail, model.can, model.me)
    return held ? t(held.key, held.params) : null
  }
  const resultHeld = recordResultHeld(lot, model.can)
  const docHeld = documentHeld(lot, model.can)
  const primary = primaryDecision(lot)
  const decisions = decisionsFor(lot)
  const receiver = model.me !== null && lot.receivedById === model.me

  const menu: MenuItemDef[] = [
    ...decisions
      .filter((decision) => decision !== primary)
      .map((decision) => {
        const held = heldText(decision)
        return { id: decision, label: t(`decide.${decision}.menu`), onSelect: () => open({ kind: 'decide', decision }), disabled: held !== null, description: held ?? undefined }
      }),
    { id: 'document', label: t('document.add'), onSelect: () => open({ kind: 'document' }), disabled: docHeld !== null, description: docHeld ? t(docHeld) : undefined },
    { id: 'sep', separator: true },
    { id: 'copy', label: t('row.copy'), onSelect: () => actions?.onCopy?.(lot.code) },
    { id: 'keys', label: t('keys.title'), onSelect: () => open({ kind: 'shortcuts' }) },
  ]

  const tabs = TAB_IDS.map((id) => ({
    id,
    label: t(`record.tab.${id}`),
    count: id === 'results' ? detail.results.length : id === 'documents' ? detail.documents.filter((doc) => doc.status === 'ACTIVE').length : id === 'release' && (lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED') ? detail.checklist.open.length : null,
  }))
  const tabHref = (tab: string) => `${model.prefix}/compliance/tests/${encodeURIComponent(lot.id)}?tab=${tab}`

  const band = (
    <span className="fw-lab-band-actions">
      {lot.crVi.required && lot.qualityStatus !== 'REJECTED' && lot.crVi.status !== 'FAIL' && (
        <Button size="sm" onClick={() => open({ kind: 'result' })} heldReason={resultHeld ? t(resultHeld) : null}>
          {t('record.recordResult')}
        </Button>
      )}
      {primary && (
        <Button size="sm" variant="primary" onClick={() => open({ kind: 'decide', decision: primary })} heldReason={heldText(primary)}>
          {t(`decide.${primary}.menu`)}
        </Button>
      )}
      <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={menu} />
    </span>
  )

  const body = (() => {
    switch (model.tab) {
      case 'documents':
        return <DocumentsTab detail={detail} held={docHeld} can={model.can.filesRead} onAdd={() => open({ kind: 'document' })} onDownload={actions?.onDownload} />
      case 'release':
        return <ReleaseTab model={model} detail={detail} heldText={heldText} onDecide={(decision) => open({ kind: 'decide', decision })} />
      case 'activity':
        return panels ?? <Section title={t('record.tab.activity')}>{<p className="fw-q-hint">{t('record.noPanels')}</p>}</Section>
      default:
        return <ResultsTab model={model} detail={detail} held={resultHeld} onRecord={() => open({ kind: 'result' })} onDownload={actions?.onDownload} />
    }
  })()

  return (
    <>
      <RecordFrame
        back={back}
        title={t('record.title', { code: lot.code })}
        meta={
          <span className="fw-q-cell-row">
            <span>
              {lot.item.code} · {lot.item.name}
            </span>
            {lot.item.isPpeComponent && <Tag tone="info">{t('list.ppeComponent')}</Tag>}
            <span className="fw-q-hint">{lot.receipt ? t('record.receivedWith', { receipt: lot.receipt.number, date: lot.receivedAt ? formatDate(lot.receivedAt, { locale }) : '—' }) : t('record.opening')}</span>
          </span>
        }
        status={
          <span className="fw-q-cell-row">
            <LotStatusPill status={lot.qualityStatus} />
            <CrViMark lot={lot} withValue={false} />
          </span>
        }
        actions={band}
        tabs={tabs}
        active={model.tab}
        tabHref={tabHref}
        dock={panels && model.tab !== 'activity' ? panels : undefined}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <NoticeBanner notice={model.notice} namespace="lab" onDismiss={actions?.onDismissNotice} />
        {receiver && lot.qualityStatus === 'QUARANTINE' && <Banner tone="info" title={t('record.youReceived')} />}
        {body}
      </RecordFrame>

      <ResultDialog
        open={dialog?.kind === 'result'}
        lot={lot}
        rule={detail.rule.crViEvidenceRule}
        draft={model.resultDraft ?? blankResult(model.today)}
        today={model.today}
        canThenRelease={model.can.lotsRelease && !receiver && lot.qualityStatus === 'QUARANTINE'}
        busy={!!model.busy}
        problem={dialog?.kind === 'result' ? (model.dialogProblem ?? null) : null}
        lines={model.dialogLines}
        onDraft={(draft) => actions?.onResultDraft?.(draft)}
        onFile={(file) => actions?.onResultFile?.(file)}
        onSave={() => actions?.onSaveResult?.()}
        onClose={() => open(null)}
      />
      <DocumentDialog
        open={dialog?.kind === 'document'}
        lot={lot}
        draft={model.documentDraft ?? blankDocument()}
        today={model.today}
        busy={!!model.busy}
        problem={dialog?.kind === 'document' ? (model.dialogProblem ?? null) : null}
        onDraft={(draft) => actions?.onDocumentDraft?.(draft)}
        onFile={(file) => actions?.onDocumentFile?.(file)}
        onSave={() => actions?.onSaveDocument?.()}
        onClose={() => open(null)}
      />
      {dialog?.kind === 'decide' && (
        <DecideDialog
          open
          decision={dialog.decision}
          lot={lot}
          checklist={detail.checklist}
          held={heldText(dialog.decision)}
          code={model.decideDraft?.code ?? ''}
          reason={model.decideDraft?.reason ?? ''}
          busy={!!model.busy}
          problem={model.dialogProblem ?? null}
          lines={model.dialogLines}
          onCode={(code) => actions?.onDecideDraft?.({ code, reason: model.decideDraft?.reason ?? '' })}
          onReason={(reason) => actions?.onDecideDraft?.({ code: model.decideDraft?.code ?? '', reason })}
          onConfirm={() => actions?.onDecide?.(dialog.decision)}
          onClose={() => open(null)}
        />
      )}
      <ShortcutsDialog
        open={dialog?.kind === 'shortcuts'}
        onClose={() => open(null)}
        keys={[
          { keys: ['c'], does: t('keys.record') },
          { keys: ['r'], does: t('keys.release') },
          { keys: ['⌘', 'J'], does: q('record.dockHint') },
          { keys: ['⌘', '↵'], does: t('keys.submit') },
          { keys: ['?'], does: t('keys.all') },
        ]}
      />
    </>
  )
}

/** One result: its verdict and value against the limit, the facts of the report, superseded when a later FAIL replaced it. */
function ResultItem({ result, onDownload }: { result: LabResult; onDownload?: (fileId: string) => void }) {
  const t = useT('lab')
  const locale = useLocale()
  const value =
    result.valueMgKg !== null
      ? t('crVi.value', { value: mgKg(result.valueMgKg, locale), limit: mgKg(result.limitMgKg, locale) })
      : t('results.notDetected', { lod: mgKg(result.detectionLimitMgKg, locale), limit: mgKg(result.limitMgKg, locale) })
  return (
    <li className="fw-lab-result">
      <div className="fw-lab-result-head">
        <Tag tone={result.verdict === 'PASS' ? 'success' : 'danger'}>{t(`results.verdict.${result.verdict}`)}</Tag>
        <span className="fw-q-num fw-q-name">{value}</span>
        {result.superseded && <Tag tone="neutral">{t('results.superseded')}</Tag>}
      </div>
      <Facts
        items={[
          { label: t('results.method'), value: result.method },
          { label: t('results.lab'), value: result.lab },
          { label: t('results.report'), value: dash(result.reportNumber) },
          { label: t('results.testedOn'), value: formatDate(result.testedOn, { locale }) },
          { label: t('results.evidence'), value: t(`evidence.${result.evidence}`) },
          ...(result.evidence === 'SUPPLIER_REPORT'
            ? [
                { label: t('results.article'), value: dash(result.article) },
                { label: t('results.period'), value: result.periodFrom && result.periodTo ? `${formatDate(result.periodFrom, { locale })} – ${formatDate(result.periodTo, { locale })}` : '—' },
              ]
            : []),
          { label: t('results.recorded'), value: formatDateTime(result.createdAt, { locale }) },
        ]}
      />
      {result.note && <p className="fw-q-hint">{result.note}</p>}
      <span className="fw-q-cell-row">
        <span className="fw-q-code">{result.file?.originalName ?? t('results.fileUnknown')}</span>
        {onDownload && result.file && (
          <Button size="sm" variant="quiet" onClick={() => onDownload(result.fileId)} aria-label={t('results.download', { name: result.file.originalName })}>
            <Download size={14} aria-hidden /> {t('results.downloadShort')}
          </Button>
        )}
      </span>
    </li>
  )
}

function ResultsTab({ model, detail, held, onRecord, onDownload }: { model: LotRecordModel; detail: LotDetail; held: string | null; onRecord: () => void; onDownload?: (fileId: string) => void }) {
  const t = useT('lab')
  const locale = useLocale()
  const { lot } = detail
  const results = resultsNewestFirst(detail.results)
  const answer = model.answer
  const register = answer?.trace?.register ?? null
  return (
    <div className="fw-q-stack">
      {answer?.trace && (
        <Banner tone="danger" title={t('answer.laterFail', { code: lot.code })}>
          <span className="fw-q-cell">
            <span>{t('answer.workOrders', { count: answer.trace.workOrders.length })}</span>
            {answer.trace.workOrders.length > 0 && (
              <ul className="fw-q-lines">
                {answer.trace.workOrders.map((order) => (
                  <li key={order.workOrderId}>{t('answer.workOrder', { number: order.number ?? '—', batch: order.batchNumber ?? '—', issued: order.issued })}</li>
                ))}
              </ul>
            )}
            {register &&
              (register.opened && register.entryId ? (
                <Link className="fw-q-link" href={`${model.prefix}/compliance/register/${encodeURIComponent(register.entryId)}`}>
                  {t('answer.registerOpened', { reference: register.reference ?? '—' })}
                </Link>
              ) : (
                <span>
                  {t('answer.registerNone')} <span className="fw-q-hint">{register.words}</span>
                </span>
              ))}
          </span>
        </Banner>
      )}
      <div className="fw-q-main-side">
        <Section
          id="lab-results"
          title={t('results.title')}
          sub={lot.crVi.required ? t('results.sub', { limit: mgKg(lot.crVi.limitMgKg ?? LEGAL_LIMIT, locale) }) : t('results.notRequired')}
          actions={
            lot.crVi.required && lot.qualityStatus !== 'REJECTED' && lot.crVi.status !== 'FAIL' ? (
              <Button size="sm" onClick={onRecord} heldReason={held ? t(held) : null}>
                {t('record.recordResult')}
              </Button>
            ) : undefined
          }
        >
          {results.length === 0 ? (
            <EmptyState title={lot.crVi.required ? t('results.empty') : t('results.notRequired')} description={lot.crVi.required ? t('results.emptyBody') : undefined} />
          ) : (
            <ul className="fw-lab-results">
              {results.map((result) => (
                <ResultItem key={result.id} result={result} onDownload={model.can.filesRead ? onDownload : undefined} />
              ))}
            </ul>
          )}
        </Section>
        <Section id="lab-rule" title={t('results.ruleTitle')} sub={t(`rule.source.${detail.rule.source}`)}>
          <p>{t(`rule.title.${detail.rule.crViEvidenceRule}`)}</p>
          <p className="fw-q-hint">{t('rule.limit', { limit: mgKg(LEGAL_LIMIT, locale) })}</p>
          <p className="fw-q-hint">{t('results.failFinal')}</p>
        </Section>
      </div>
    </div>
  )
}

function DocumentItem({ document, onDownload }: { document: LotDocument; onDownload?: (fileId: string) => void }) {
  const t = useT('lab')
  const locale = useLocale()
  const inForce = document.inForce ?? document.status === 'ACTIVE'
  return (
    <li className="fw-lab-result">
      <div className="fw-lab-result-head">
        <span className="fw-q-name">{t(`kind.${document.kind}`)}</span>
        <Tag tone={inForce ? 'success' : 'neutral'}>{inForce ? t('documents.inForce') : document.status === 'ARCHIVED' ? t('documents.archived') : t('documents.notInForce')}</Tag>
      </div>
      <Facts
        items={[
          { label: t('documents.validTo'), value: document.validTo ? formatDate(document.validTo, { locale }) : t('documents.noExpiry') },
          { label: t('documents.added'), value: formatDateTime(document.createdAt, { locale }) },
        ]}
      />
      {document.note && <p className="fw-q-hint">{document.note}</p>}
      <span className="fw-q-cell-row">
        <span className="fw-q-code">{document.file?.originalName ?? t('results.fileUnknown')}</span>
        {onDownload && document.file && (
          <Button size="sm" variant="quiet" onClick={() => onDownload(document.fileId)} aria-label={t('results.download', { name: document.file.originalName })}>
            <Download size={14} aria-hidden /> {t('results.downloadShort')}
          </Button>
        )}
      </span>
    </li>
  )
}

function DocumentsTab({ detail, held, can, onAdd, onDownload }: { detail: LotDetail; held: string | null; can: boolean; onAdd: () => void; onDownload?: (fileId: string) => void }) {
  const t = useT('lab')
  const { lot } = detail
  const documents = [...detail.documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <div className="fw-q-main-side">
      <Section
        id="lab-documents"
        title={t('documents.title')}
        sub={t('documents.sub')}
        actions={
          <Button size="sm" onClick={onAdd} heldReason={held ? t(held) : null}>
            {t('document.add')}
          </Button>
        }
      >
        {documents.length === 0 ? (
          <EmptyState title={t('documents.empty')} description={lot.item.isPpeComponent ? t('documents.emptyPpe') : t('documents.emptyBody')} />
        ) : (
          <ul className="fw-lab-results">
            {documents.map((document) => (
              <DocumentItem key={document.id} document={document} onDownload={can ? onDownload : undefined} />
            ))}
          </ul>
        )}
      </Section>
      <Section id="lab-needs" title={t('documents.needsTitle')}>
        <p>{lot.item.isPpeComponent ? t('documents.needsPpe') : t('documents.needsNone')}</p>
        <p className="fw-q-hint">{t('documents.needsLater')}</p>
      </Section>
    </div>
  )
}

function ReleaseTab({ model, detail, heldText, onDecide }: { model: LotRecordModel; detail: LotDetail; heldText: (decision: LotDecision) => string | null; onDecide: (decision: LotDecision) => void }) {
  const t = useT('lab')
  const locale = useLocale()
  const { lot, checklist } = detail
  const decisions = decisionsFor(lot)
  const open = lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED'
  return (
    <div className="fw-q-stack">
      {model.blocked && model.blocked.length > 0 && (
        <Banner tone="info" title={t('answer.blocked', { count: model.blocked.length })}>
          <ul className="fw-q-lines">
            {model.blocked.map((order) => (
              <li key={order.workOrderId}>{t('answer.workOrder', { number: order.number ?? '—', batch: order.batchNumber ?? '—', issued: order.issued })}</li>
            ))}
          </ul>
        </Banner>
      )}
      <div className="fw-q-main-side">
        <Section
          id="lab-release"
          title={checklist.mode === 'UNBLOCK' ? t('release.titleUnblock') : t('release.title')}
          sub={open ? (checklist.ready ? t('release.ready') : t('release.open', { count: checklist.open.length })) : t(`release.state.${lot.qualityStatus}`)}
          actions={
            decisions.length > 0 ? (
              <span className="fw-q-actions">
                {decisions.map((decision) => (
                  <Button key={decision} size="sm" variant={decision === 'release' || decision === 'unblock' ? 'primary' : decision === 'reject' || decision === 'block' ? 'danger-outline' : 'secondary'} onClick={() => onDecide(decision)} heldReason={heldText(decision)}>
                    {t(`decide.${decision}.menu`)}
                  </Button>
                ))}
              </span>
            ) : undefined
          }
        >
          {open ? (
            <CheckList label={t('release.checksLabel')} checks={checklist.checks.map((check) => ({ id: check.code, state: check.state, name: t(`check.${check.code}`), text: check.words, fix: check.fix }))} />
          ) : (
            <p className="fw-q-hint">{t(`release.final.${lot.qualityStatus}`)}</p>
          )}
        </Section>
        <Section id="lab-decided" title={t('release.decidedTitle')}>
          <Facts
            items={[
              { label: t('record.facts.status'), value: t(`status.${lot.qualityStatus}`) },
              { label: t('release.decidedAt'), value: lot.qualityDecidedAt ? formatDateTime(lot.qualityDecidedAt, { locale }) : '—' },
              { label: t('record.facts.receipt'), value: lot.receipt ? `${lot.receipt.number} · ${t(`receipt.${lot.receipt.status}`)}` : t('record.opening') },
            ]}
          />
          {lot.qualityNote && <p className="fw-q-hint">{lot.qualityNote}</p>}
          <p className="fw-q-hint">{t('release.who')}</p>
        </Section>
      </div>
    </div>
  )
}

export type { RecordTab }
