'use client'

import { FileImage, FileText } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { FollowupsMessages, useFollowupsWords, type FollowupsSay } from '../../../../../lib/options-followups/words'
import type { PortalArtwork, PortalOptions } from '../api'
import '../options.css'

/** SCR-434's view model: the order's lines with options or artwork. */
export interface OptionsSectionModel {
  read: { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: PortalOptions }
  /** Why opening a file waits (an office preview, offline: the page's words), or null. */
  fileHeld: FollowupsSay | null
  problem: FollowupsSay | null
  /** The file being opened. */
  opening: string | null
}

export interface OptionsSectionActions {
  onOpen?: (file: PortalArtwork) => void
  onDownload?: (file: PortalArtwork) => void
  onRetry?: () => void
}

/**
 * SCR-434 — the options and artwork of the customer's order (B-W2b-374; XF3:04; the portal's Order › Lines): each line with
 * options says them as the confirmation prints them, and the artwork the office shows in the portal opens (a picture or a
 * PDF; logged) or downloads. It fetches nothing.
 */
export function OptionsSection({ model, actions }: { model: OptionsSectionModel; actions?: OptionsSectionActions }) {
  return (
    <FollowupsMessages>
      <Body model={model} actions={actions} />
    </FollowupsMessages>
  )
}

function Body({ model, actions }: { model: OptionsSectionModel; actions?: OptionsSectionActions }) {
  const { t, say, lang } = useFollowupsWords()
  const lines = model.read.status === 'ready' ? model.read.value.lines : []
  return (
    <section className="fw-popt" aria-labelledby="fw-popt-title">
      <h2 id="fw-popt-title" className="fw-popt-h2">
        {t('portal.title')}
      </h2>
      {model.problem && <Banner tone="danger">{say(model.problem)}</Banner>}
      {model.read.status === 'loading' && (
        <p className="fw-popt-hint" role="status">
          <Spinner size={12} /> {t('portal.loading')}
        </p>
      )}
      {model.read.status === 'error' && (
        <Banner tone="danger" action={actions?.onRetry ? <Button size="sm" onClick={actions.onRetry}>{t('common.retry')}</Button> : undefined}>
          {t('portal.problem')}
        </Banner>
      )}
      {model.read.status === 'ready' && lines.length === 0 && <p className="fw-popt-hint">{t('portal.empty')}</p>}
      {lines.length > 0 && (
        <div className="fw-popt-lines">
          {lines.map((line) => (
            <Card key={line.lineId} header={t('portal.line', { seq: line.seq })}>
              <div className="fw-popt-line">
                {line.options.length > 0 && (
                  <div>
                    <h3 className="fw-popt-h3">{t('portal.options')}</h3>
                    <ul className="fw-popt-list">
                      {line.options.map((option, index) => (
                        <li key={index}>{option[lang] || option.en}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <h3 className="fw-popt-h3">{t('portal.artwork')}</h3>
                  {line.artwork.length === 0 ? (
                    <p className="fw-popt-hint">{t('portal.noArtwork')}</p>
                  ) : (
                    <ul className="fw-popt-files">
                      {line.artwork.map((file) => (
                        <li key={file.fileId} className="fw-popt-file">
                          {file.picture ? <FileImage size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
                          <span className="fw-popt-name">{file.name}</span>
                          <span className="fw-popt-hint">{t(file.picture ? 'portal.picture' : 'portal.document')}</span>
                          <span className="fw-popt-actions">
                            <Button size="sm" variant="ghost" heldReason={model.fileHeld ? say(model.fileHeld) : model.opening === file.fileId ? t('common.loading') : null} onClick={() => actions?.onOpen?.(file)}>
                              {t('portal.open')}
                            </Button>
                            <Button size="sm" variant="ghost" heldReason={model.fileHeld ? say(model.fileHeld) : null} onClick={() => actions?.onDownload?.(file)}>
                              {t('portal.download')}
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  )
}
