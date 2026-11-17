'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, FileX, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { isPageKey } from '../../../../quality/_shared/hooks'
import { CheckList, dash, Facts, NoticeBanner, Section } from '../../../../quality/_shared/parts'
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
  RECORD_TABS,
  recordResultHeld,
  resultsNewestFirst,
  type DocumentDraft,
  type LotRecordModel,
  type RecordDialog,
  type RecordTab,
  type ResultDraft,
} from '../../model'
import { CrViMark, LabMessages, LotStatusPill } from '../../view/parts'
import { DecideDialog, DocumentDialog, ResultDialog } from './dialogs'
// B-W2b-288 (FU2:03): the lab's price of a result.
import { costWords, LAB_COST_NAMESPACE } from '../../lab-cost/lab-cost'
// ---- B-TH-267: the lot on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

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
}

/**
 * The lot record of Tests & substances (SCR-054; design compliance.tests "Test report" record in W1's shape, B-W1-34 part 2 "Lot
 * record"), on RecordFrame (B-TH-267; the rule of picture 38, the tabs of 08-tabs O-CMP-TST): the band in the shell's band row (‹ Tests
 * & substances, "Lot <code>", ONE pill — its quality status —, the material, the Cr VI mark, how it came and "Same conversation as
 * Warehouse › Lots & traceability" in its details; the primary by state — Record result while its Cr VI result is awaited, else the
 * next decision —, held with why; ⋯ the other decisions, Record result, Add document, Copy; the frame's Thread button ⌘J and its
 * ONE Keyboard line with the page's c and r), the docked thread beside both tabs (the lot's ONE thread, the Lot record, the same as Warehouse ›
 * Lots'; Activity's tools in its "⋯", R-ACT), the tabs 4 → 2: Results & limits (the Cr VI results newest first, a superseded one
 * marked; read only) and Documents & release (the checklist in words and the decisions, then the supplier's documents with Add
 * document right under the checklist that names what is missing — typed lot documents on their own route, R-2 — and what the lot
 * needs); every banner in the ONE notice of the body column. Fetches nothing: LotRecord.tsx reads and writes; the thread comes in as
 * `thread` (the office's OfficeRecordThread docked, or a design case's) and `printThread`.
 */
export function LotRecordView({ model, actions, thread, printThread }: { model: LotRecordModel; actions?: LotRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <LabMessages>
      <Record model={model} actions={actions} thread={thread} printThread={printThread} />
    </LabMessages>
  )
}

/** The record type the frame remembers the thread's width by (the thread's own type, shared with Warehouse › Lots). */
const RECORD_TYPE = 'Lot'

/** The lot while it is read, when it is not there for this person, or the page is not for the role: inside the frame, no thread. */
function LotState({ model, onRetry }: { model: LotRecordModel; onRetry?: () => void }) {
  const t = useT('lab')
  const q = useT('quality')
  const listHref = `${model.prefix}/compliance/tests`
  const back = <Link href={listHref}>{t('record.back')}</Link>
  const problem = model.can.lotsView ? (model.detail.problem ?? null) : 'noAccess'
  const missing = problem === 'problem.notFound'
  const forbidden = problem === 'noAccess' || problem === 'problem.forbidden'
  return (
    <RecordFrame recordType={RECORD_TYPE} personId={model.personId ?? null} band={{ back, title: problem === null ? <Skeleton width={260} height={22} /> : t('record.name'), moreLabel: t('record.more') }} thread={null} threadLabel={t('record.dockLabel')}>
      {problem === null ? (
        <Card padded aria-busy="true">
          <p className="fw-q-hint" role="status">
            <Spinner size={14} /> {t('record.loading')}
          </p>
          <div className="fw-q-stack">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      ) : (
        <Card padded>
          <EmptyState
            icon={forbidden ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
            title={problem === 'noAccess' ? t('noAccess.title') : t(missing ? 'record.notFound' : forbidden ? 'record.forbidden' : 'record.failed')}
            description={problem === 'noAccess' ? t('noAccess.body') : missing ? t('record.notFoundBody') : q(problem)}
            action={
              missing || forbidden || !onRetry ? (
                <Button size="sm" asChild>
                  {back}
                </Button>
              ) : (
                <Button size="sm" onClick={onRetry}>
                  {q('common.retry')}
                </Button>
              )
            }
          />
        </Card>
      )}
    </RecordFrame>
  )
}

function Record({ model, actions, thread, printThread }: { model: LotRecordModel; actions?: LotRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const t = useT('lab')
  const locale = useLocale()
  const detail = model.detail.value
  const dialog = model.dialog ?? null
  const open = (next: RecordDialog | null) => actions?.onDialog?.(next)
  const lot = detail?.lot ?? null

  // c: record a result; r: the next decision (release, release again). ⌘J is the frame's (the thread); the keys are listed in the band
  // menu's ONE Keyboard line (band.keys; TH-6 part B, PR-14: no "?" overlay).
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, detail, dialog, lot, model.can, model.me])

  if (!model.can.lotsView || model.detail.problem || !detail || !lot) return <LotState model={model} onRetry={actions?.onRetry} />

  const heldText = (decision: LotDecision): string | null => {
    const held = decisionHeld(decision, detail, model.can, model.me)
    return held ? t(held.key, held.params) : null
  }
  const resultHeld = recordResultHeld(lot, model.can)
  const docHeld = documentHeld(lot, model.can)
  const primary = primaryDecision(lot)
  const decisions = decisionsFor(lot)
  const receiver = model.me !== null && lot.receivedById === model.me
  // A result may still be recorded (the Results tab's own button shows on the same rule).
  const takesResult = lot.crVi.required && lot.qualityStatus !== 'REJECTED' && lot.crVi.status !== 'FAIL'
  // B-TH-267: ONE primary by state — Record result while the Cr VI result is awaited, else the next decision.
  const resultFirst = takesResult && lot.crVi.status === 'PENDING'
  const bandPrimary: LotDecision | 'result' | null = resultFirst ? 'result' : primary

  const menu: MenuItemDef[] = [
    ...decisions
      .filter((decision) => decision !== bandPrimary)
      .map((decision) => {
        const held = heldText(decision)
        return { id: decision, label: t(`decide.${decision}.menu`), onSelect: () => open({ kind: 'decide', decision }), disabled: held !== null, description: held ?? undefined }
      }),
    ...(takesResult && bandPrimary !== 'result' ? [{ id: 'result', label: t('record.recordResult'), onSelect: () => open({ kind: 'result' }), disabled: resultHeld !== null, description: resultHeld ? t(resultHeld) : undefined }] : []),
    { id: 'document', label: t('document.add'), onSelect: () => open({ kind: 'document' }), disabled: docHeld !== null, description: docHeld ? t(docHeld) : undefined },
    { id: 'sep', separator: true },
    { id: 'copy', label: t('row.copy'), onSelect: () => actions?.onCopy?.(lot.code) },
  ]
  // TH-6 part B (PR-14): the record's own keys, listed first in the frame's ONE Keyboard window (⌘J and the thread's keys are the frame's).
  const keys = [{ keys: ['c'], label: t('keys.record') }, { keys: ['r'], label: t('keys.release') }]

  // B-TH-267: the two tabs, each counting what it asks (the open checks while the lot waits a decision).
  const base = `${model.prefix}/compliance/tests/${encodeURIComponent(lot.id)}`
  const openChecks = lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED' ? detail.checklist.open.length : null
  const tabs: TabItem[] = RECORD_TABS.map((id: RecordTab) => ({ id, href: `${base}?tab=${id}`, label: t(`record.tab.${id}`), count: id === 'results' ? detail.results.length : openChecks }))
  const warehouseHref = `${model.prefix}/warehouse/lots/${encodeURIComponent(lot.id)}`

  const bandButton =
    bandPrimary === 'result' ? (
      <Button size="sm" variant="primary" aria-keyshortcuts="c" onClick={() => open({ kind: 'result' })} heldReason={resultHeld ? t(resultHeld) : null}>
        {t('record.recordResult')}
      </Button>
    ) : bandPrimary ? (
      <Button size="sm" variant="primary" aria-keyshortcuts="r" onClick={() => open({ kind: 'decide', decision: bandPrimary })} heldReason={heldText(bandPrimary)}>
        {t(`decide.${bandPrimary}.menu`)}
      </Button>
    ) : undefined

  const register = model.answer?.trace?.register ?? null

  return (
    <>
      <RecordFrame
        recordType={RECORD_TYPE}
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: <Link href={`${model.prefix}/compliance/tests`}>{t('record.back')}</Link>,
          title: t('record.title', { code: lot.code }),
          status: <LotStatusPill status={lot.qualityStatus} />,
          meta: (
            <span className="fw-q-cell-row">
              <CrViMark lot={lot} withValue={false} />
              <span>
                {lot.item.code} · {lot.item.name}
              </span>
              {lot.item.isPpeComponent && <Tag tone="info">{t('list.ppeComponent')}</Tag>}
              <span className="fw-q-hint">{lot.receipt ? t('record.receivedWith', { receipt: lot.receipt.number, date: lot.receivedAt ? formatDate(lot.receivedAt, { locale }) : '—' }) : t('record.opening')}</span>
              {/* B-TH-267: ONE conversation per lot — the thread docked here is Warehouse › Lots' (the Lot record). */}
              {model.can.stockView ? (
                <Link className="fw-q-link fw-q-hint" href={warehouseHref}>
                  {t('record.sameThread')}
                </Link>
              ) : (
                <span className="fw-q-hint">{t('record.sameThread')}</span>
              )}
            </span>
          ),
          primary: bandButton,
          more: menu,
          moreLabel: t('record.more'),
          keys,
        }}
      >
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-267: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {model.answer?.trace && (
            <Banner tone="danger" title={t('answer.laterFail', { code: lot.code })}>
              <span className="fw-q-cell">
                <span>{t('answer.workOrders', { count: model.answer.trace.workOrders.length })}</span>
                {model.answer.trace.workOrders.length > 0 && (
                  <ul className="fw-q-lines">
                    {model.answer.trace.workOrders.map((order) => (
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
          {model.blocked && model.blocked.length > 0 && (
            <Banner tone="info" title={t('answer.blocked', { count: model.blocked.length })}>
              <ul className="fw-q-lines">
                {model.blocked.map((order) => (
                  <li key={order.workOrderId}>{t('answer.workOrder', { number: order.number ?? '—', batch: order.batchNumber ?? '—', issued: order.issued })}</li>
                ))}
              </ul>
            </Banner>
          )}
          <NoticeBanner notice={model.notice} namespace="lab" onDismiss={actions?.onDismissNotice} />
          {receiver && lot.qualityStatus === 'QUARANTINE' && <Banner tone="info" title={t('record.youReceived')} />}
        </RecordNotices>

        {model.tab === 'release' ? (
          <ReleaseTab model={model} detail={detail} heldText={heldText} docHeld={docHeld} onDecide={(decision) => open({ kind: 'decide', decision })} onAdd={() => open({ kind: 'document' })} onDownload={actions?.onDownload} />
        ) : (
          <ResultsTab model={model} detail={detail} held={resultHeld} onRecord={() => open({ kind: 'result' })} onDownload={actions?.onDownload} />
        )}
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
        // B-W2b-288 (FU2:03)
        costGrain={!!model.costGrain}
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
    </>
  )
}

/** One result: its verdict and value against the limit, the facts of the report, superseded when a later FAIL replaced it. */
function ResultItem({ result, onDownload }: { result: LabResult; onDownload?: (fileId: string) => void }) {
  const t = useT('lab')
  // B-W2b-288 (FU2:03)
  const w = useT(LAB_COST_NAMESPACE)
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
          // B-W2b-288 (FU2:03): the lab's price (sent only to the cost grain).
          ...(result.cost ? [{ label: w('labCost.result'), value: costWords(result.cost, locale) }] : []),
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
  // B-TH-267: a later FAIL's answer (its work orders, the register entry) is in the ONE notice above the tabs' content.
  return (
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

/** The supplier's documents (typed lot documents, each on its own route: the release checklist counts them, R-2) and Add document. */
function DocumentsSection({ detail, held, can, onAdd, onDownload }: { detail: LotDetail; held: string | null; can: boolean; onAdd: () => void; onDownload?: (fileId: string) => void }) {
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

/**
 * B-TH-267 — Documents & release (Documents merged into Release, R-5 / R-6: both answer "may this lot be used?" for the quality
 * person, every action of both kept): the release checklist in words with the decisions and when it was decided, then — right under
 * the checklist that names what is missing — the supplier's documents with Add document and what the lot needs.
 */
function ReleaseTab({ model, detail, heldText, docHeld, onDecide, onAdd, onDownload }: { model: LotRecordModel; detail: LotDetail; heldText: (decision: LotDecision) => string | null; docHeld: string | null; onDecide: (decision: LotDecision) => void; onAdd: () => void; onDownload?: (fileId: string) => void }) {
  const t = useT('lab')
  const locale = useLocale()
  const { lot, checklist } = detail
  const decisions = decisionsFor(lot)
  const open = lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED'
  return (
    <div className="fw-q-stack">
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
      <DocumentsSection detail={detail} held={docHeld} can={model.can.filesRead} onAdd={onAdd} onDownload={onDownload} />
    </div>
  )
}

export type { RecordTab }
