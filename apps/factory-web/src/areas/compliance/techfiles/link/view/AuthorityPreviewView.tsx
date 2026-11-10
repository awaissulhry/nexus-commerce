'use client'

import { BookOpen, FileArchive, FileText, KeyRound, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Input, Pill, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Pack } from '../../api'
import { linkLive, NAMESPACES, type Read } from '../../model'
import { languageName, SectionFailed, useDay, useWords } from '../../view/parts'
import '../../techfiles.css'

/** SCR-327 — Authority link preview (design compliance.techfiles tab:tf-authority, a new tab; links.document). */
export interface AuthorityPreviewModel {
  canView: boolean
  /** The company the link names as its sender. */
  sender: string
  pack: Read<Pack>
  /** Before the password (what the link asks first) or after it (the files). */
  step: 'password' | 'files'
  /** The PDF read in the page (memory only). */
  preview: Read<Uint8Array> | null
  /** The clock (fixtures fix it). */
  now: string
}

export interface AuthorityPreviewActions {
  onStep?: (step: 'password' | 'files') => void
  onRead?: () => void
  onClosePreview?: () => void
  onRetry?: () => void
}

const sizeOf = (bytes: number, locale: string): string => {
  const units = locale === 'it' ? ['B', 'kB', 'MB'] : ['B', 'KB', 'MB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`
}

/**
 * What the authority will see on the time-limited link (links.document W2b: a DOCUMENT_VIEW link of the pack's PDF and ZIP with
 * a password): the sender, how long it works, the password step, then the two files with their size and checksum — the PDF can
 * be read in the page. The words are the link page's own (`link-files`); nothing here opens the link or counts as an open.
 * Fetches nothing: AuthorityPreview.tsx loads the pack and the PDF.
 */
export function AuthorityPreviewView({ model, actions }: { model: AuthorityPreviewModel; actions?: AuthorityPreviewActions }) {
  return (
    <WithMessages namespaces={[...NAMESPACES, 'link-files', 'shell']}>
      <Preview model={model} actions={actions} />
    </WithMessages>
  )
}

function Preview({ model, actions }: { model: AuthorityPreviewModel; actions?: AuthorityPreviewActions | undefined }) {
  const t = useWords()
  const link = useT('link-files')
  const shell = useT('shell')
  const locale = useLocale()
  const day = useDay()
  if (!model.canView) {
    return (
      <div className="fw-tf-window">
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('access.title')} description={t('access.body')} />
      </div>
    )
  }
  if (model.pack.status === 'loading')
    return (
      <div className="fw-tf-window">
        <p className="fw-tf-muted" role="status">
          <Spinner size={14} /> {t('window.reading')}
        </p>
      </div>
    )
  if (model.pack.status === 'error')
    return (
      <div className="fw-tf-window">
        <SectionFailed title={t('window.failed')} problem={model.pack.problem} onRetry={actions?.onRetry} />
      </div>
    )
  const pack = model.pack.value
  const now = new Date(model.now)
  const live = pack.links.filter((entry) => linkLive(entry, now)).sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))
  const newest = live[0] ?? null
  const files = [pack.pdf ? { ...pack.pdf, kind: 'PDF' as const } : null, pack.zip ? { ...pack.zip, kind: 'ZIP' as const } : null].filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  const sum = (sha: string) => sha.slice(0, 12)

  return (
    <div className="fw-tf-window">
      <div className="fw-tf-window-head">
        <div className="fw-tf-stack-tight">
          <h1 className="fw-tf-window-title">{t('preview.title', { number: pack.number })}</h1>
          <span className="fw-tf-muted">{t('preview.lead', { recipient: pack.recipient, language: languageName(pack.language, locale) })}</span>
        </div>
        <SegmentedControl
          ariaLabel={t('preview.step')}
          size="sm"
          value={model.step}
          onChange={(value) => actions?.onStep?.(value as 'password' | 'files')}
          options={[
            { value: 'password', label: t('preview.before') },
            { value: 'files', label: t('preview.after') },
          ]}
        />
      </div>
      {pack.status !== 'BUILT' && <Banner tone="warning" title={t('preview.notBuilt')} />}
      <Banner tone="info" title={t('preview.nothingCounts')}>
        {newest ? t('preview.links', { count: live.length, date: day(newest.expiresAt) }) : t('preview.noLink')}
      </Banner>

      <div className="fw-tf-linkcol">
        <Card padded>
          <div className="fw-tf-stack">
            <span className="fw-tf-muted">{model.sender}</span>
            <h2 className="fw-tf-h">{link('title.shared', { sender: model.sender })}</h2>
            <span className="fw-tf-row">
              <span>{newest ? link('status.works', { date: formatDate(newest.expiresAt, { locale }) }) : t('preview.worksUntilChosen')}</span>
              <Pill tone="neutral">{t('preview.opensCount')}</Pill>
            </span>
            {model.step === 'password' ? (
              <>
                <h3 className="fw-tf-h3">
                  <KeyRound size={14} aria-hidden /> {link('password.title')}
                </h3>
                <p>{link('password.lead', { count: files.length, sender: model.sender })}</p>
                <Field label={link('password.label')} hint={link('password.hint')}>
                  <Input size="sm" type="password" value="" readOnly aria-readonly placeholder="••••••••" />
                </Field>
                <Button variant="primary" heldReason={t('preview.held')}>
                  {link('password.open')}
                </Button>
              </>
            ) : (
              <>
                <p>{link('lead.shared', { sender: model.sender, count: files.length })}</p>
                <h3 className="fw-tf-h3">{link('files.title.shared', { count: files.length })}</h3>
                <ul className="fw-tf-linkfiles">
                  {files.map((entry) => (
                    <li key={entry.id}>
                      {entry.kind === 'PDF' ? <FileText size={18} aria-hidden /> : <FileArchive size={18} aria-hidden />}
                      <span className="fw-tf-stack-tight">
                        <span className="fw-tf-strong">{entry.name}</span>
                        <span className="fw-tf-muted" title={link('file.checksumFull', { sum: entry.sha256 })}>
                          {sizeOf(entry.sizeBytes, locale)} · {link('file.checksum', { sum: sum(entry.sha256) })}
                        </span>
                      </span>
                      <span className="fw-tf-row-tight">
                        {entry.kind === 'PDF' && (
                          <Button size="sm" onClick={() => actions?.onRead?.()}>
                            <BookOpen size={13} aria-hidden /> {link('file.read')}
                          </Button>
                        )}
                        <Button size="sm" variant="quiet" heldReason={t('preview.held')}>
                          {link('file.download')}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
                {model.preview &&
                  (model.preview.status === 'loading' ? (
                    <p className="fw-tf-muted" role="status">
                      <Spinner size={14} /> {t('window.opening')}
                    </p>
                  ) : model.preview.status === 'error' ? (
                    <SectionFailed title={t('window.pdfFailed')} problem={model.preview.problem} onRetry={actions?.onRead} />
                  ) : (
                    <PdfViewer src={model.preview.value} title={pack.pdf?.name ?? pack.number} fileName={pack.pdf?.name ?? `${pack.number}.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 900px)" />
                  ))}
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
