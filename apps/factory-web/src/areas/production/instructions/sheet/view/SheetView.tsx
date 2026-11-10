'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import type { InstructionRecord } from '../../api'
import { NS, SHEET_LANGUAGES, valueOf, type Read, type SheetLanguage } from '../../model'
import { InstructionsMessages, VersionPill } from '../../view/parts'

/** SCR-285-pdf — the instruction sheet window's view model (design tab:wi-tab-pdf, a new tab). */
export interface SheetModel {
  readonly allowed: boolean
  readonly record: Read<InstructionRecord>
  /** The version printed (asked, else the one in force, else the draft); null: none yet. */
  readonly versionId: string | null
  readonly language: SheetLanguage
  readonly pdf: Read<Uint8Array> | null
}

export interface SheetActions {
  onLanguage?: (language: SheetLanguage) => void
  onVersion?: (versionId: string) => void
  onRetry?: () => void
}

/**
 * tab:wi-tab-pdf "Instruction sheet PDF" (design production.instructions: paper at the station): the version's sheet made now
 * by the API (the shared document renderer, Italian or English; kept nowhere), in the DS PdfViewer: number, version and
 * printing day, operation, style or every style, machine settings, the steps (how many photos or videos the tablet shows for
 * each), critical points, safety notes boxed; a draft or a replaced version carries its banner on the paper. Print prints.
 * Fetches nothing.
 */
export function SheetView({ model, actions }: { model: SheetModel; actions?: SheetActions }) {
  return (
    <InstructionsMessages>
      <Sheet model={model} actions={actions} />
    </InstructionsMessages>
  )
}

function Sheet({ model, actions }: { model: SheetModel; actions?: SheetActions }) {
  const t = useT(NS)
  const shell = useT('shell')
  if (!model.allowed) return <EmptyState title={t('list.forbidden.title')} description={t('list.forbidden.body')} />
  if (model.record.status === 'error') return <EmptyState title={t('sheet.failed')} description={t(model.record.problem)} />
  const record = valueOf(model.record)
  const versions = record ? [...record.versions].filter((version) => version.status !== 'DISCARDED').sort((a, b) => b.number - a.number) : []
  const version = versions.find((entry) => entry.id === model.versionId) ?? null
  const title = record && version ? t('sheet.title', { number: record.instruction.number, version: version.number }) : t('sheet.titlePlain')
  const pdf = valueOf(model.pdf)
  return (
    <div className="fw-wi-window">
      <div className="fw-wi-window-band fw-wi-noprint">
        <span className="fw-wi-cell">
          <h1 className="fw-wi-h1">{title}</h1>
          <span className="fw-wi-hint">{t('sheet.note')}</span>
        </span>
        <span className="fw-wi-actions">
          {version && <VersionPill status={version.status} />}
          <SegmentedControl
            size="sm"
            ariaLabel={t('sheet.language')}
            value={model.language}
            onChange={(value) => actions?.onLanguage?.(value === 'en' ? 'en' : 'it')}
            options={SHEET_LANGUAGES.map((code) => ({ value: code, label: t(`sheet.lang.${code}`) }))}
          />
          {versions.length > 0 && (
            <Select size="sm" aria-label={t('sheet.version')} value={model.versionId ?? ''} onChange={(event) => actions?.onVersion?.(event.target.value)}>
              {versions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t('version.pill', { number: entry.number, status: t(`status.${entry.status}`) })}
                </option>
              ))}
            </Select>
          )}
          <Button size="sm" variant="primary" heldReason={pdf ? null : t('sheet.held')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('sheet.print')}
          </Button>
        </span>
      </div>
      {version && version.status !== 'PUBLISHED' && <Banner tone="warning" title={t(version.status === 'DRAFT' ? 'sheet.draft' : 'sheet.notInForce', { number: version.number })} />}
      {!record ? (
        <p className="fw-wi-hint fw-wi-inline" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : !model.versionId ? (
        <EmptyState title={t('steps.noVersion.title')} description={t('steps.noVersion.body')} />
      ) : model.pdf?.status === 'error' ? (
        <Banner
          tone="danger"
          title={t('sheet.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.pdf.problem)}
        </Banner>
      ) : pdf ? (
        <PdfViewer src={pdf} title={title} fileName={`${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(82vh, 1100px)" />
      ) : (
        <p className="fw-wi-hint fw-wi-inline" role="status">
          <Spinner size={14} /> {t('sheet.reading')}
        </p>
      )}
    </div>
  )
}
