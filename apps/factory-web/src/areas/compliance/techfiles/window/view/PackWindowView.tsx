'use client'

import Link from 'next/link'
import { Eye, FileArchive, FileDown, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { FileSummary, Pack } from '../../api'
import { authorityAddress, NAMESPACES, PACK_TONE, recordAddress, shortHash, valueOf, type Read } from '../../model'
import { languageName, SectionFailed, StatePill, useWhen, useWords } from '../../view/parts'
import '../../techfiles.css'

/** SCR-326 — Evidence pack (PDF) (design compliance.techfiles tab:tf-pack-pdf, a new tab): the built pack to hand over. */
export interface PackWindowModel {
  prefix: string
  /** compliance.certificates.view. */
  canView: boolean
  pack: Read<Pack>
  /** The file it was built from (its style for the title). */
  file: Read<Pick<FileSummary, 'id' | 'number' | 'style'>> | null
  pdf: Read<Uint8Array> | null
  /** A download being read (PDF or ZIP). */
  downloading: 'PDF' | 'ZIP' | null
}

export interface PackWindowActions {
  onRetry?: () => void
  onDownload?: (file: 'PDF' | 'ZIP') => void
}

/**
 * The pack's PDF in the DS PdfViewer (a plain link cannot send the company header, so the page reads the bytes): which pack,
 * for whom, in which language, its documents and fingerprint, Download PDF, Download ZIP (the documents themselves with their
 * checksums), what the authority sees on the link (a new tab), back to the technical file. A pack still building or failed
 * says so. Fetches nothing: PackWindow.tsx loads it.
 */
export function PackWindowView({ model, actions }: { model: PackWindowModel; actions?: PackWindowActions }) {
  return (
    <WithMessages namespaces={[...NAMESPACES, 'shell']}>
      <Window model={model} actions={actions} />
    </WithMessages>
  )
}

function Window({ model, actions }: { model: PackWindowModel; actions?: PackWindowActions | undefined }) {
  const t = useWords()
  const shell = useT('shell')
  const when = useWhen()
  const locale = useLocale()
  if (!model.canView) {
    return (
      <div className="fw-tf-window">
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('access.title')} description={t('access.body')} />
      </div>
    )
  }
  if (model.pack.status === 'loading') {
    return (
      <div className="fw-tf-window">
        <p className="fw-tf-muted" role="status">
          <Spinner size={14} /> {t('window.reading')}
        </p>
      </div>
    )
  }
  if (model.pack.status === 'error') {
    return (
      <div className="fw-tf-window">
        <SectionFailed title={t('window.failed')} problem={model.pack.problem} onRetry={actions?.onRetry} />
      </div>
    )
  }
  const pack = model.pack.value
  const file = valueOf(model.file)
  const title = file ? t('window.title', { number: pack.number, style: `${file.style.code} ${file.style.name}` }) : pack.number
  return (
    <div className="fw-tf-window">
      <div className="fw-tf-window-head">
        <div className="fw-tf-stack-tight">
          <h1 className="fw-tf-window-title">{title}</h1>
          <span className="fw-tf-row">
            <StatePill group="packStatus" state={pack.status} tone={PACK_TONE[pack.status]} />
            <span className="fw-tf-muted">
              {t(`purpose.${pack.purpose}`)} · {languageName(pack.language, locale)} · {pack.recipient}
            </span>
            {pack.builtAt && <span className="fw-tf-muted">{t('packs.builtOn', { date: when(pack.builtAt), name: pack.builtBy?.name ?? '—' })}</span>}
          </span>
          {pack.status === 'BUILT' && (
            <span className="fw-tf-muted">
              {t('window.facts', { count: pack.documents ?? 0, hash: shortHash(pack.fingerprint) })}
            </span>
          )}
        </div>
        <div className="fw-tf-row">
          {pack.status === 'BUILT' && (
            <>
              <Button size="sm" disabled={model.downloading !== null} heldReason={pack.pdf ? null : t('held.notBuilt')} onClick={() => actions?.onDownload?.('PDF')}>
                <FileDown size={14} aria-hidden /> {t('window.downloadPdf')}
              </Button>
              <Button size="sm" disabled={model.downloading !== null} heldReason={pack.zip ? null : t('held.notBuilt')} onClick={() => actions?.onDownload?.('ZIP')}>
                <FileArchive size={14} aria-hidden /> {t('window.downloadZip')}
              </Button>
              <Button size="sm" variant="quiet" asChild>
                <Link href={authorityAddress(model.prefix, pack.id)} target="_blank">
                  <Eye size={14} aria-hidden /> {t('packs.preview')}
                </Link>
              </Button>
            </>
          )}
          {pack.technicalFileId && (
            <Button size="sm" variant="quiet" asChild>
              <Link href={recordAddress(model.prefix, pack.technicalFileId, 'pack')}>{t('window.toFile')}</Link>
            </Button>
          )}
        </div>
      </div>
      <p className="fw-tf-never">{t('pack.never')}</p>
      {pack.status === 'BUILDING' && <Banner tone="info" title={t('window.building')} />}
      {pack.status === 'FAILED' && (
        <Banner tone="danger" title={t('pack.failed')}>
          {pack.failureReason ? <p className="fw-tf-muted">{pack.failureReason}</p> : null}
        </Banner>
      )}
      {pack.status === 'BUILT' &&
        (model.pdf === null || model.pdf.status === 'loading' ? (
          <p className="fw-tf-muted" role="status">
            <Spinner size={14} /> {t('window.opening')}
          </p>
        ) : model.pdf.status === 'error' ? (
          <SectionFailed title={t('window.pdfFailed')} problem={model.pdf.problem} onRetry={actions?.onRetry} />
        ) : (
          <Card padded>
            <PdfViewer src={model.pdf.value} title={title} fileName={pack.pdf?.name ?? `${pack.number}.pdf`} labels={pdfViewerLabels(shell)} height="min(82vh, 1100px)" />
          </Card>
        ))}
    </div>
  )
}
