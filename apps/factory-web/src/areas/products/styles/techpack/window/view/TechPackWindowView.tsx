'use client'

import { useState } from 'react'
import { FileText, Printer, QrCode, RefreshCw, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { ScanView, TechPackVersion } from '../../api'
import { NAMESPACES, newestFirst, NS, printedCode, scanWords, valueOf, versionWords, type Read, type TechPackCan } from '../../model'
import { MakePdfDialog, type MakeDialogActions, type MakeDialogModel } from '../../view/MakePdfDialog'
import type { TechPackNotice } from '../../view/TechPackTabView'
import '../../techpack.css'

/** The style as the window shows it (its code, name and revisions). */
export interface WindowStyle {
  id: string
  code: string
  name: string
  revisions: ReadonlyArray<{ id: string; revision: number; status: 'DRAFT' | 'RELEASED' | 'OBSOLETE' }>
}

/** SCR-306 — Tech pack PDF (design products.styles tab:styles.techpack, a new tab; and the landing of a scanned QR). */
export interface TechPackWindowModel {
  can: TechPackCan
  online: boolean
  /** The QR's code when the window opened from a scan (`?scan=`), and its verdict. */
  scanCode: string | null
  scan: Read<ScanView> | null
  style: Read<WindowStyle> | null
  revisionId: string | null
  versions: Read<TechPackVersion[]> | null
  /** The version shown (asked, the scanned one, else the newest); null: none yet. */
  versionId: string | null
  pdf: Read<Uint8Array> | null
  make: MakeDialogModel | null
  notice: TechPackNotice | null
}

export interface TechPackWindowActions {
  onRevision?: (revisionId: string) => void
  onVersion?: (versionId: string) => void
  /** Show the newest version the scan points at. */
  onNewest?: () => void
  onScanCode?: (code: string) => void
  onRetry?: () => void
  onMake?: () => void
  make?: MakeDialogActions
  onDismissNotice?: () => void
}

/**
 * tab:styles.techpack "Tech pack PDF" (sent to workshops and customers; kept open while sampling): a stored version of the
 * revision's tech pack in the DS PdfViewer — which revision, which version (each says its audience, language and the code
 * printed under its QR), Make new version, Print. Opened from a scanned QR (`/tech-pack/<code>`), it first says whether that
 * printed page is current, and offers the newest. Fetches nothing: TechPackWindow.tsx loads it.
 */
export function TechPackWindowView({ model, actions }: { model: TechPackWindowModel; actions?: TechPackWindowActions }) {
  return (
    <WithMessages namespaces={[...NAMESPACES, 'shell']}>
      <Window model={model} actions={actions} />
    </WithMessages>
  )
}

function Window({ model, actions }: { model: TechPackWindowModel; actions?: TechPackWindowActions }) {
  const t = useT(NS)
  const shell = useT('shell')
  const locale = useLocale()
  if (!model.can.view) {
    return (
      <div className="fw-tp-window">
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('techpack.window.forbidden.title')} description={t('techpack.window.forbidden.body')} />
      </div>
    )
  }
  if (model.scanCode !== null && model.scan?.status === 'error') return <ScanFailed model={model} actions={actions} />
  if (model.scanCode === null && model.style === null) return <ScanFailed model={model} actions={actions} />
  if (model.style?.status === 'error') {
    return (
      <div className="fw-tp-window">
        <EmptyState
          icon={<FileText size={24} aria-hidden />}
          title={t('techpack.window.failed')}
          description={t(model.style.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              <RefreshCw size={13} aria-hidden /> {t('techpack.common.retry')}
            </Button>
          }
        />
      </div>
    )
  }
  const style = valueOf(model.style)
  const revisions = style ? [...style.revisions].sort((a, b) => b.revision - a.revision) : []
  const revision = revisions.find((entry) => entry.id === model.revisionId) ?? null
  const versions = newestFirst(valueOf(model.versions) ?? [])
  const version = versions.find((entry) => entry.id === model.versionId) ?? null
  const pdf = valueOf(model.pdf)
  const scan = valueOf(model.scan)
  const verdict = scan ? scanWords(scan) : null
  const title = style && revision ? (version ? t('techpack.window.title', { code: style.code, revision: revision.revision, version: version.version }) : t('techpack.window.titleNoVersion', { code: style.code, revision: revision.revision })) : t('techpack.window.titlePlain')
  const label = (entry: TechPackVersion) => {
    const words = versionWords(entry)
    return t(words.key, { ...words.params, audience: entry.audience ? t(`techpack.audience.${entry.audience}`) : '', language: t(`techpack.language.${entry.language === 'en' ? 'en' : 'it'}`) })
  }
  const showsScanned = scan && version && scan.printed.revisionId === model.revisionId && scan.printed.version === version.version
  const newerHere = !!scan?.newer && !(scan.newer.revisionId === model.revisionId && (scan.newer.version === null || scan.newer.version === version?.version))

  return (
    <div className="fw-tp-window">
      <div className="fw-tp-window-band fw-tp-noprint">
        <span className="fw-tp-cell">
          <h1 className="fw-tp-h1">{title}</h1>
          <span className="fw-tp-hint">{style ? style.name : t('techpack.window.reading')}</span>
        </span>
        <span className="fw-tp-actions">
          {revisions.length > 0 && (
            <Select size="sm" aria-label={t('techpack.window.revision')} value={model.revisionId ?? ''} onChange={(event) => actions?.onRevision?.(event.target.value)}>
              {revisions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t('techpack.window.revisionOption', { revision: entry.revision, status: t(`techpack.revisionStatus.${entry.status}`) })}
                </option>
              ))}
            </Select>
          )}
          {versions.length > 0 && (
            <Select size="sm" aria-label={t('techpack.window.version')} value={model.versionId ?? ''} onChange={(event) => actions?.onVersion?.(event.target.value)}>
              {versions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {label(entry)}
                </option>
              ))}
            </Select>
          )}
          <Button size="sm" heldReason={!model.can.make ? t('techpack.held.noMake') : !model.online ? t('techpack.held.offline') : !revision ? t('techpack.held.noRevision') : null} onClick={() => actions?.onMake?.()}>
            <FileText size={13} aria-hidden /> {t('techpack.window.make')}
          </Button>
          <Button size="sm" variant="primary" heldReason={pdf ? null : t('techpack.window.printHeld')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('techpack.window.print')}
          </Button>
        </span>
      </div>

      {verdict && scan && (
        <Banner
          tone={verdict.tone}
          title={
            <span className="fw-tp-inline">
              <QrCode size={14} aria-hidden /> {t('techpack.scan.scanned', { code: printedCode(scan.code) })}
            </span>
          }
          action={
            newerHere ? (
              <Button size="sm" variant="primary" onClick={() => actions?.onNewest?.()}>
                {scan.newer!.version !== null ? t('techpack.scan.openNewer', { version: scan.newer!.version, revision: scan.newer!.revision }) : t('techpack.scan.openRevision', { revision: scan.newer!.revision })}
              </Button>
            ) : undefined
          }
        >
          {t(verdict.key, verdict.params)}
          {version && !showsScanned ? ` ${t('techpack.scan.nowShowing', { version: version.version, revision: revision?.revision ?? '—' })}` : ''}
        </Banner>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('techpack.common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {revision && revision.status !== 'RELEASED' && version && <Banner tone={revision.status === 'DRAFT' ? 'info' : 'warning'} title={t(revision.status === 'DRAFT' ? 'techpack.banner.draft' : 'techpack.banner.obsolete', { revision: revision.revision })} />}

      {version && (
        <p className="fw-tp-hint fw-tp-noprint">
          {t('techpack.window.made', { audience: version.audience ? t(`techpack.audienceLong.${version.audience}`) : '—', code: printedCode(version.code), at: formatDateTime(version.createdAt, { locale }), by: version.createdBy ?? '—' })}
        </p>
      )}

      {!style || model.versions === null || model.versions.status === 'loading' ? (
        <p className="fw-tp-hint fw-tp-inline" role="status">
          <Spinner size={14} /> {t('techpack.window.reading')}
        </p>
      ) : model.versions.status === 'error' ? (
        <Banner
          tone="danger"
          title={t('techpack.window.versionsFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('techpack.common.retry')}
            </Button>
          }
        >
          {t(model.versions.problem)}
        </Banner>
      ) : !version ? (
        <Card padded>
          <EmptyState
            icon={<FileText size={24} aria-hidden />}
            title={t('techpack.window.none.title', { revision: revision?.revision ?? '—' })}
            description={t(model.can.make ? 'techpack.window.none.body' : 'techpack.window.none.bodyNoMake')}
            action={
              model.can.make ? (
                <Button size="sm" variant="primary" heldReason={!model.online ? t('techpack.held.offline') : null} onClick={() => actions?.onMake?.()}>
                  {t('techpack.window.make')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : model.pdf?.status === 'error' ? (
        <Banner
          tone="danger"
          title={t('techpack.window.pdfFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('techpack.common.retry')}
            </Button>
          }
        >
          {t(model.pdf.problem)}
        </Banner>
      ) : pdf ? (
        <PdfViewer src={pdf} title={title} fileName={`${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(82vh, 1100px)" />
      ) : (
        <p className="fw-tp-hint fw-tp-inline" role="status">
          <Spinner size={14} /> {t('techpack.window.opening')}
        </p>
      )}

      {model.make && <MakePdfDialog model={model.make} can={model.can} online={model.online} actions={actions?.make} />}
    </div>
  )
}

/** A scan that names no page this person may see (or none at all): say so, and let them type the printed code. */
function ScanFailed({ model, actions }: { model: TechPackWindowModel; actions?: TechPackWindowActions }) {
  const t = useT(NS)
  const [code, setCode] = useState(model.scanCode ?? '')
  const problem = model.scan?.status === 'error' ? model.scan.problem : null
  return (
    <div className="fw-tp-window">
      <Card padded className="fw-tp-scan">
        <EmptyState
          icon={<QrCode size={24} aria-hidden />}
          title={problem === 'techpack.problem.read.not_found' ? t('techpack.scan.notFound.title') : problem ? t('techpack.scan.failed') : t('techpack.scan.type.title')}
          description={problem === 'techpack.problem.read.not_found' ? t('techpack.scan.notFound.body') : problem ? t(problem) : t('techpack.scan.type.body')}
        />
        <form
          className="fw-tp-scan-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) actions?.onScanCode?.(code.trim())
          }}
        >
          <Field label={t('techpack.scan.type.label')} hint={t('techpack.scan.type.hint')}>
            <Input value={code} maxLength={200} autoComplete="off" spellCheck={false} onChange={(event) => setCode(event.target.value)} />
          </Field>
          <Button type="submit" variant="primary" heldReason={code.trim() ? null : t('techpack.scan.type.held')}>
            {t('techpack.scan.type.go')}
          </Button>
        </form>
      </Card>
    </div>
  )
}
