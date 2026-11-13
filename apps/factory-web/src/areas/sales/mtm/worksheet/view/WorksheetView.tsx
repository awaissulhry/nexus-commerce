'use client'

import Link from 'next/link'
import { FileText, Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Worksheet } from '../../api'
import { recordHref, type Phrase } from '../../model'
import { MtmMessages, useWords } from '../../parts'

/** SCR-431 — the worksheet and order form's new tab (tab:mtm.worksheet). */
export interface WorksheetModel {
  readonly prefix: string
  readonly profileId: string
  /** sales.measurements.view (to read and open it). */
  readonly allowed: boolean
  /** sales.mtm.record (to keep a new version). */
  readonly mayMake: boolean
  readonly title: { readonly rider: string; readonly garment: string; readonly revision: number } | null
  readonly versions: { readonly status: 'loading' } | { readonly status: 'ready'; readonly items: readonly Worksheet[] } | { readonly status: 'error'; readonly problem: string }
  /** The version shown (its document id). */
  readonly shown: string | null
  /** Its PDF: an address (or bytes in the design cases), null while opened. */
  readonly pdf: string | Uint8Array | null
  readonly pdfProblem: string | null
  readonly busy: boolean
  readonly problem: Phrase | null
  /** The last keep answered the newest (the contents did not change). */
  readonly sameAsNewest: boolean
}

/**
 * tab:mtm.worksheet — "MTM worksheet and order form (PDF)" (design sales.mtm, SAL-303: printed and signed at the fitting): the
 * worksheet of the rider's newest revision kept as a version (the same contents give the newest back: nothing written), shown in
 * the DS PdfViewer with Print; earlier versions to open (each opening is recorded on the profile). Never a price; office only.
 * Fetches nothing.
 */
export function WorksheetView({ model, onMake, onShow, onRetry }: { model: WorksheetModel; onMake?: () => void; onShow?: (documentId: string) => void; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={['shell']}>
      <MtmMessages>
        <Page model={model} onMake={onMake} onShow={onShow} onRetry={onRetry} />
      </MtmMessages>
    </WithMessages>
  )
}

function Page({ model, onMake, onShow, onRetry }: { model: WorksheetModel; onMake?: () => void; onShow?: (documentId: string) => void; onRetry?: () => void }) {
  const { t, say, when } = useWords()
  const shell = useT('shell')
  if (!model.allowed)
    return (
      <div className="fw-mtm-pdf">
        <EmptyState title={t('sheet.noRight')} description={t('held.right', { right: t('right.view') })} />
      </div>
    )
  if (model.versions.status === 'loading')
    return (
      <div className="fw-mtm-pdf">
        <p className="fw-mtm-hint" role="status">
          <Spinner size={14} /> {t('sheet.reading')}
        </p>
      </div>
    )
  if (model.versions.status === 'error')
    return (
      <div className="fw-mtm-pdf">
        <EmptyState
          title={t('sheet.failed')}
          description={t(model.versions.problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </div>
    )
  const versions = model.versions.items
  const shown = versions.find((sheet) => sheet.id === model.shown) ?? null
  const title = model.title ? t('sheet.title', { rider: model.title.rider, garment: model.title.garment, revision: model.title.revision }) : t('sheet.titleShort')
  const make = (
    <Button size="sm" variant={versions.length > 0 ? 'secondary' : 'primary'} heldReason={model.mayMake ? (model.busy ? t('common.working') : null) : t('held.right', { right: t('right.record') })} onClick={() => onMake?.()}>
      <FileText size={13} aria-hidden /> {versions.length > 0 ? t('sheet.makeAgain') : t('sheet.make')}
    </Button>
  )
  return (
    <div className="fw-mtm-pdf">
      <div className="fw-mtm-head fw-mtm-noprint">
        <span className="fw-mtm-tight">
          <span className="fw-mtm-h2">{title}</span>
          <Link className="fw-mtm-link fw-mtm-hint" href={recordHref(model.prefix, model.profileId)}>
            {t('sheet.back')}
          </Link>
        </span>
        <span className="fw-mtm-actions">
          {versions.length > 1 && (
            <Select size="sm" aria-label={t('sheet.version')} value={model.shown ?? ''} onChange={(event) => onShow?.(event.target.value)}>
              {versions.map((sheet) => (
                <option key={sheet.id} value={sheet.id}>
                  {t('sheet.versionOption', { version: sheet.version, revision: sheet.revision, when: when(sheet.createdAt) })}
                </option>
              ))}
            </Select>
          )}
          {shown && <Tag tone="neutral">{t('sheet.versionTag', { version: shown.version, revision: shown.revision })}</Tag>}
          {make}
          <Button size="sm" variant="primary" heldReason={model.pdf ? null : t('sheet.printHeld')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('sheet.print')}
          </Button>
        </span>
      </div>
      {model.problem && <Banner tone="danger" title={say(model.problem)} />}
      {model.sameAsNewest && <Banner tone="info" title={t('sheet.same')} />}
      {versions.length === 0 ? (
        <EmptyState title={t('sheet.none')} description={model.mayMake ? t('sheet.noneBody') : t('sheet.noneNoRight')} action={model.mayMake ? make : undefined} />
      ) : model.pdfProblem ? (
        <Banner
          tone="danger"
          title={t('sheet.pdfFailed')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : model.pdf && shown ? (
        <PdfViewer src={model.pdf} title={title} fileName={`${shown.number ?? 'worksheet'}.pdf`} labels={pdfViewerLabels(shell)} height="min(82vh, 1100px)" />
      ) : (
        <p className="fw-mtm-hint" role="status">
          <Spinner size={14} /> {t('sheet.opening')}
        </p>
      )}
      <p className="fw-mtm-hint fw-mtm-noprint">{t('sheet.foot')}</p>
    </div>
  )
}
