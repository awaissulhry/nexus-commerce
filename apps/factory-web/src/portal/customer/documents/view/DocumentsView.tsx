'use client'

import { Lock } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, FilterChip, Skeleton } from '@nexus/ui/primitives'
import { DocumentPreview, type DocumentPreviewActions, type DocumentPreviewModel } from '../preview/view/DocumentPreview'
import type { LibraryChip } from '../api'
import type { ChipView } from '../model'
import { useDocumentWords } from '../words'
import { ConformitySection, type ConformityActions, type ConformityModel } from './Conformity'
import { LibrarySection, type LibraryActions, type LibraryModel } from './Library'
import { PayDialog, type PayDialogActions, type PayDialogModel } from './PayDialog'
import { ToPaySection, type ToPayActions, type ToPayModel } from './ToPay'
import '../documents.css'

/**
 * SCR-186 — the customer's Documents (design portal.customer.documents; SAL-086, SAL-087, SAL-092, FIN-118, QHS-111): Which
 * documents (the groups the role sees, as chips with counts), To pay (Finance and Admin), All documents (every issued
 * document in its fixed versions), Conformity per style you received (Quality, Buyer, Viewer), the document pop-up and the
 * Pay pop-up. A chip filters the library; All shows every section, Invoices & statements also To pay, Conformity also the
 * conformity per style. No connection: the frame's one notice says so; here the actions that send are held with the reason.
 * Fills the main area (no page max-width). Draws one view model and fetches nothing.
 */

export interface DocumentsViewModel {
  /** The library's first read: the chips (null while it runs, or failed). */
  chips: { state: 'loading' | 'error' | 'ready'; items: readonly ChipView[] }
  group: LibraryChip
  /** The role sees no prices: said once. */
  noPrices: boolean
  /** A line about the invoice the address named (`?invoice=`), a key with its words. */
  notice: { key: string; params?: Readonly<Record<string, string | number>>; tone: 'info' | 'warning' } | null
  /** Any read takes longer than a second. */
  slow?: boolean
  toPay: ToPayModel | null
  library: LibraryModel
  conformity: ConformityModel | null
  preview: DocumentPreviewModel | null
  /** A refused open outside the pop-up, a key with its words. */
  problem: { key: string; params?: Readonly<Record<string, string | number>> } | null
  pay: PayDialogModel | null
}

export interface DocumentsViewActions {
  onChip?: (chip: LibraryChip) => void
  onRetryChips?: () => void
  toPay?: ToPayActions
  library?: LibraryActions
  conformity?: ConformityActions
  preview?: DocumentPreviewActions
  pay?: PayDialogActions
  onDismissNotice?: () => void
  onDismissProblem?: () => void
}

export function DocumentsView({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsViewActions }) {
  const { t } = useDocumentWords()
  return (
    <div className="fw-pdoc">
      {model.notice ? <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} action={actions?.onDismissNotice ? <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>{t('state.hide')}</Button> : undefined} /> : null}
      {model.problem ? <Banner tone="warning" title={t(model.problem.key, model.problem.params)} action={actions?.onDismissProblem ? <Button size="sm" variant="quiet" onClick={actions.onDismissProblem}>{t('state.hide')}</Button> : undefined} /> : null}

      <section className="fw-pdoc-kinds" aria-labelledby="fw-pdoc-kinds">
        <h2 id="fw-pdoc-kinds" className="fw-pdoc-kinds-title">
          {t('chips.title')}
        </h2>
        {model.chips.state === 'loading' ? (
          <div className="fw-pdoc-chips" role="status" aria-label={model.slow ? t('state.slow') : t('state.loading')}>
            <Skeleton width={72} height={32} />
            <Skeleton width={140} height={32} />
            <Skeleton width={120} height={32} />
            {model.slow ? <span className="fw-pdoc-sub">{t('state.slow')}</span> : null}
          </div>
        ) : model.chips.state === 'error' ? (
          <div className="fw-pdoc-chips">
            <span className="fw-pdoc-sub">{t('chips.failed')}</span>
            <Button size="sm" onClick={() => actions?.onRetryChips?.()}>
              {t('state.retry')}
            </Button>
          </div>
        ) : (
          <div className="fw-pdoc-chips" role="group" aria-label={t('chips.label')}>
            {model.chips.items.map((entry) => {
              const name = t(`group.${entry.chip}`)
              return (
                <FilterChip key={entry.chip} pressed={entry.chip === model.group} count={entry.count} onClick={() => actions?.onChip?.(entry.chip)} aria-label={t('chips.chip', { name, count: entry.count })}>
                  {name}
                </FilterChip>
              )
            })}
          </div>
        )}
        {model.noPrices ? (
          <p className="fw-pdoc-noprices">
            <Lock size={14} aria-hidden /> <span>{t('chips.noPrices')}</span>
          </p>
        ) : null}
      </section>

      {model.toPay ? <ToPaySection model={model.toPay} actions={actions?.toPay} /> : null}
      <LibrarySection model={model.library} actions={actions?.library} />
      {model.conformity ? <ConformitySection model={model.conformity} actions={actions?.conformity} /> : null}

      {model.preview ? <DocumentPreview model={model.preview} actions={actions?.preview} /> : null}
      {model.pay ? <PayDialog model={model.pay} actions={actions?.pay} /> : null}
    </div>
  )
}

/** A typed or old address the person's role does not open (design noPermission): who to ask, and the way Home. */
export function DocumentsClosedView({ model }: { model: { admins: readonly string[]; homeHref: string } }) {
  const { t } = useDocumentWords()
  return (
    <div className="fw-pdoc">
      <EmptyState
        icon={<Lock size={24} aria-hidden />}
        title={t('noAccess.title')}
        description={model.admins.length > 0 ? t('noAccess.ask', { names: model.admins.join(', ') }) : t('noAccess.askAdmin')}
        action={
          <Button asChild>
            <a href={model.homeHref}>{t('noAccess.home')}</a>
          </Button>
        }
      />
    </div>
  )
}
