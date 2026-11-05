'use client'

import { Archive, ChevronLeft, ChevronRight, ExternalLink, Printer, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Pill, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { KeptDocument, ReceiptAnswer } from '../../api'
import { issuedByText, itemName, RECEIPT_TONE, type Problem } from '../../model'
import '../../ppe.css'
import { NoPpeAccess, PPE_NAMESPACES, problemText, useDay, useWhen, useWords } from '../../view/parts'

/** SCR-211-receipt — the receipt window's view model (one or several receipts, one at a time). */
export interface ReceiptTabModel {
  /** safety.view. */
  readonly canView: boolean
  /** safety.ppe.issue: keep a PIN receipt's PDF. */
  readonly canKeep: boolean
  /** files.read: open the stored scan or the kept PDF. */
  readonly canReadFiles: boolean
  readonly ids: readonly string[]
  readonly index: number
  readonly language: 'it' | 'en'
  readonly record: { readonly value: ReceiptAnswer | null; readonly problem: string | null }
  readonly pdf: Uint8Array | null
  readonly pdfProblem: string | null
  readonly keeping: boolean
  readonly kept: { readonly document: KeptDocument; readonly made: boolean } | null
  readonly keepProblem: Problem | null
  readonly fileProblem: string | null
}

export interface ReceiptTabActions {
  onLanguage?: (language: 'it' | 'en') => void
  onMove?: (index: number) => void
  onKeep?: () => void
  onRetry?: () => void
  onOpenFile?: (fileId: string) => void
}

/**
 * tab:receipt — "Receipt (PDF)" (design plant.ppe new tab, "Per issue, signed"; Issues › receipt, Print receipts): the receipt's
 * facts — the person, the site, when, who handed it over, how it was signed (badge + PIN at a tablet with its SHA-256 and the
 * statement the person signed, verified or not; or the paper's scan) — its lines with their void marks, and the PDF made by
 * the API (a preview stored nowhere) in Italian or English. Print prints it; a PIN receipt can be kept in the person's file
 * (Keep the PDF); a paper receipt's legal record is its signed scan (opened from here). With several receipts (Print
 * receipts), one at a time with Previous / Next.
 */
export function ReceiptTabView({ model, actions }: { model: ReceiptTabModel; actions?: ReceiptTabActions }) {
  return (
    <WithMessages namespaces={PPE_NAMESPACES}>
      <Receipt model={model} actions={actions} />
    </WithMessages>
  )
}

function Receipt({ model, actions }: { model: ReceiptTabModel; actions?: ReceiptTabActions | undefined }) {
  const t = useWords()
  const shell = useT('shell')
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  const when = useWhen()
  if (!model.canView) return <NoPpeAccess />
  const answer = model.record.value
  const receipt = answer?.receipt ?? null
  const title = receipt ? t('receipt.title', { name: receipt.employee.name, date: day(receipt.issuedAt) }) : t('receipt.titlePlain')
  const keepHeld = !receipt ? t('receipt.held') : receipt.method === 'PAPER' ? t('refusal.PAPER_RECEIPT') : !model.canKeep || !receipt.canIssue ? t('held.issue') : model.keeping ? t('held.busy') : !model.pdf ? t('receipt.held') : null
  const kept = model.kept?.document ?? receipt?.document ?? null
  const several = model.ids.length > 1

  return (
    <article className="fw-ppe-tab">
      <div className="fw-ppe-tab-band fw-ppe-noprint">
        <span className="fw-ppe-head-title">
          <h1 className="fw-ppe-h">{title}</h1>
          {receipt && (
            <Pill tone={RECEIPT_TONE[receipt.state]} dot>
              {t(`receiptState.${receipt.state}`)}
            </Pill>
          )}
        </span>
        <span className="fw-ppe-actions">
          {several && (
            <span className="fw-ppe-row" role="group" aria-label={t('receipt.several')}>
              <Button size="sm" heldReason={model.index === 0 ? t('receipt.first') : null} aria-label={t('receipt.previous')} onClick={() => actions?.onMove?.(model.index - 1)}>
                <ChevronLeft size={14} aria-hidden />
              </Button>
              <span className="fw-ppe-muted">{t('receipt.of', { n: model.index + 1, count: model.ids.length })}</span>
              <Button size="sm" heldReason={model.index >= model.ids.length - 1 ? t('receipt.last') : null} aria-label={t('receipt.next')} onClick={() => actions?.onMove?.(model.index + 1)}>
                <ChevronRight size={14} aria-hidden />
              </Button>
            </span>
          )}
          <SegmentedControl
            size="sm"
            ariaLabel={t('receipt.language')}
            value={model.language}
            onChange={(value) => actions?.onLanguage?.(value === 'en' ? 'en' : 'it')}
            options={[
              { value: 'it', label: t('receipt.it') },
              { value: 'en', label: t('receipt.en') },
            ]}
          />
          {receipt?.scan && (
            <Button size="sm" heldReason={model.canReadFiles ? null : t('held.readFiles')} onClick={() => actions?.onOpenFile?.(receipt.scan!.fileId)}>
              <ExternalLink size={13} aria-hidden /> {t('receipt.openScan')}
            </Button>
          )}
          {receipt?.method === 'FLOOR_PIN' && (
            <Button size="sm" heldReason={keepHeld} onClick={() => actions?.onKeep?.()}>
              {model.keeping ? <Spinner size={12} /> : <Archive size={13} aria-hidden />} {t('receipt.keep')}
            </Button>
          )}
          <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('receipt.held')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('receipt.print')}
          </Button>
        </span>
      </div>

      {model.record.problem ? (
        <Banner
          tone="danger"
          title={t('receipt.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.record.problem)}
        </Banner>
      ) : !answer || !receipt ? (
        <p className="fw-ppe-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : (
        <>
          <dl className="fw-ppe-facts fw-ppe-noprint">
            <div>
              <dt>{t('receipt.person')}</dt>
              <dd>{[receipt.employee.name, receipt.employee.employeeCode].filter(Boolean).join(' · ')}</dd>
            </div>
            <div>
              <dt>{t('receipt.site')}</dt>
              <dd>{receipt.site.name}</dd>
            </div>
            <div>
              <dt>{t('receipt.when')}</dt>
              <dd>{when(receipt.issuedAt)}</dd>
            </div>
            <div>
              <dt>{t('receipt.by')}</dt>
              <dd>{issuedByText(receipt.issuedBy, { worker: t('issues.byWorker'), none: '—' })}</dd>
            </div>
            <div>
              <dt>{t('receipt.signed')}</dt>
              <dd>
                {receipt.method === 'FLOOR_PIN'
                  ? t('receipt.signedPin', { device: receipt.signature?.device?.name ?? '—' })
                  : receipt.scan
                    ? t('receipt.signedPaper', { file: receipt.scan.name })
                    : t('receipt.notSigned')}
              </dd>
            </div>
            <div>
              <dt>{t('receipt.law')}</dt>
              <dd className="fw-ppe-row">
                <LawRef law={answer.law.issue} plain={t('law.issue')} labels={ds.lawRef} />
                <LawRef law={answer.law.receipt} plain={t('law.receipt')} labels={ds.lawRef} />
              </dd>
            </div>
          </dl>

          {receipt.method === 'FLOOR_PIN' && (
            <Banner tone={answer.verified ? 'success' : 'warning'} title={answer.verified ? t('receipt.verified') : t('receipt.notVerified')}>
              <span className="fw-ppe-stack">
                <span className="fw-ppe-row">
                  {answer.verified ? <ShieldCheck size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />}
                  <span className="fw-ppe-code">{`SHA-256 ${receipt.signature?.sha256 ?? '—'}`}</span>
                </span>
                {answer.statement && <q>{answer.statement}</q>}
              </span>
            </Banner>
          )}
          {receipt.state === 'NOT_SIGNED' && <Banner tone="warning" title={t('receipt.scanMissing')} />}
          {receipt.state === 'VOIDED' && <Banner tone="info" title={t('receipt.allVoided')} />}

          <div className="fw-ppe-noprint">
            <SummaryTable
              label={t('receipt.lines')}
              columns={[t('issues.col.item'), t('issues.col.size'), t('issues.col.quantity'), t('issues.col.reason'), t('issues.col.void')]}
              align={[undefined, undefined, 'right', undefined, 'left']}
              stackOnPhone
              rows={receipt.lines.map((line) => ({
                id: line.id,
                cells: [`${line.item.code} · ${itemName(line.item, locale)}`, line.size ?? t('issues.oneSize'), String(line.quantity), t(`reason.${line.reason}`), line.voided ? `${t('issues.voidedOn', { date: day(line.voided.at) })}: ${line.voided.reason ?? '—'}` : '—'],
              }))}
            />
          </div>

          {model.keepProblem && <Banner tone="danger" title={problemText(t, model.keepProblem)} />}
          {model.fileProblem && <Banner tone="danger" title={t(model.fileProblem)} />}
          {kept && (
            <Banner tone="success" title={t(model.kept && !model.kept.made ? 'receipt.keptSame' : 'receipt.kept', { version: kept.version, date: when(kept.createdAt) })}>
              <Button size="sm" variant="quiet" heldReason={model.canReadFiles ? null : t('held.readFiles')} onClick={() => actions?.onOpenFile?.(kept.fileId)}>
                <ExternalLink size={13} aria-hidden /> {t('receipt.openKept')}
              </Button>
            </Banner>
          )}

          <p className="fw-ppe-muted fw-ppe-noprint">{t('receipt.preview')}</p>
          {model.pdfProblem ? (
            <Banner
              tone="danger"
              title={t('receipt.pdfFailed')}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t(model.pdfProblem)}
            </Banner>
          ) : model.pdf ? (
            <PdfViewer src={model.pdf} title={title} fileName={`${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
          ) : (
            <p className="fw-ppe-muted" role="status">
              <Spinner size={14} /> {t('receipt.loading')}
            </p>
          )}
        </>
      )}
    </article>
  )
}
