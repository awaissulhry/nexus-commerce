'use client'

import { Lock } from 'lucide-react'
import { Banner, Card, Disclosure } from '@nexus/ui/components'
import { Button, Checkbox } from '@nexus/ui/primitives'
import { FileDropzone, FileRow } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { attachOutcome, heldCount, takesSheetTick, type HeldFile } from '../new-files'

export const NEW_FILES_NS = 'orders-new-files'

export interface CustomerFilesModel {
  held: readonly HeldFile[]
  /** files.upload: without it the order is made without files (said, never hidden). */
  canUpload: boolean
  /** Files left out of the last drop (more than 20). */
  leftOut: number
  /** The order made, when its files did not all attach (the page stays: Retry, or Open the order). */
  made: { readonly number: string; readonly href: string } | null
  busy: boolean
}

export interface CustomerFilesActions {
  onDrop?: (files: File[]) => void
  onSheet?: (key: string, sheet: boolean) => void
  onRemove?: (key: string) => void
  onRetry?: () => void
  onOpenOrder?: () => void
}

/**
 * B-TH-231 — New order's fold "Customer files" (O-SAL-ORD-NEW.form-F08; SCR-039): drop, paste or browse the customer's files
 * while the order is typed; each is listed with its name, size and kind (a refused one with its reason, SVG naming the way out);
 * a PDF or a photo can be ticked "This is a measurement sheet". They are HELD in the page ("Added when you confirm") and go to
 * the new order right after Confirm, office only. When some do not attach the order stays made: "Order SO-… made; 2 files did
 * not attach · Retry". Draws its model only.
 */
export function CustomerFiles({ model, actions }: { model: CustomerFilesModel; actions?: CustomerFilesActions }) {
  return (
    <WithMessages namespaces={[NEW_FILES_NS]}>
      <Fold model={model} actions={actions} />
    </WithMessages>
  )
}

/** The order is made: "Order SO-… made; 2 files did not attach · Retry · Open the order" (or "attaching its files…"), above the page. */
export function FilesOutcome({ model, actions }: { model: CustomerFilesModel; actions?: CustomerFilesActions }) {
  return (
    <WithMessages namespaces={[NEW_FILES_NS]}>
      <Outcome model={model} actions={actions} />
    </WithMessages>
  )
}

function Outcome({ model, actions }: { model: CustomerFilesModel; actions?: CustomerFilesActions | undefined }) {
  const t = useT(NEW_FILES_NS)
  const outcome = attachOutcome(model.held)
  if (!model.made) return null
  return (
    <Banner
      tone={outcome.failed > 0 ? 'warning' : 'info'}
      title={outcome.failed > 0 ? t('outcome.title', { number: model.made.number, count: outcome.failed }) : t('outcome.attaching', { number: model.made.number })}
      action={
        outcome.failed > 0 ? (
          <span className="fw-so-actions">
            <Button size="sm" heldReason={model.busy ? t('file.attaching') : null} onClick={() => actions?.onRetry?.()}>
              {t('outcome.retry')}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => actions?.onOpenOrder?.()}>
              {t('outcome.open')}
            </Button>
          </span>
        ) : undefined
      }
    >
      {outcome.failed > 0 ? t('outcome.body') : null}
    </Banner>
  )
}

function Fold({ model, actions }: { model: CustomerFilesModel; actions?: CustomerFilesActions | undefined }) {
  const t = useT(NEW_FILES_NS)
  const count = heldCount(model.held)
  return (
    <Card padded>
      <Disclosure className="fw-so-files" summary={count > 0 ? `${t('fold.title')} · ${t('fold.count', { count })}` : t('fold.title')} open={model.held.length > 0 || undefined}>
        <div className="fw-so-files-body">
          <p className="fw-so-hint">{t('fold.hint')}</p>
          {model.canUpload ? (
            !model.made && <FileDropzone multiple onFiles={(files) => actions?.onDrop?.(files)} hint={t('fold.drop')} disabled={model.busy} />
          ) : (
            <p className="fw-so-hint">
              <Lock size={14} aria-hidden /> {t('fold.noRight')}
            </p>
          )}
          {model.leftOut > 0 && <Banner tone="warning" title={t('file.leftOut', { count: model.leftOut })} />}
          {model.held.length > 0 && (
            <ul className="fw-so-files-list">
              {model.held.map((file) => (
                <li key={file.key}>
                  <FileRow
                    name={file.name}
                    size={file.sizeBytes}
                    tone={file.problem || file.state === 'failed' ? 'danger' : 'neutral'}
                    status={file.problem ? t(file.problem.key, file.problem.params) : file.state === 'held' ? null : t(`file.${file.state}`)}
                    {...(model.made || model.busy ? {} : { onRemove: () => actions?.onRemove?.(file.key) })}
                    labels={{ remove: t('file.remove', { name: file.name }) }}
                  />
                  {takesSheetTick(file) && (
                    <Checkbox
                      className="fw-so-files-sheet"
                      label={
                        <span>
                          {t('file.sheet')} <span className="fw-so-hint">· {t('file.sheetHint')}</span>
                        </span>
                      }
                      checked={file.sheet}
                      disabled={file.state !== 'held' && file.state !== 'failed'}
                      onChange={(event) => actions?.onSheet?.(file.key, event.target.checked)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Disclosure>
    </Card>
  )
}
