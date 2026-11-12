'use client'

import { useEffect, useRef } from 'react'
import { ExternalLink } from 'lucide-react'
import type { TabItem } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../lib/i18n/ds-parts'
import type { InquiryView } from '../api'
import { RECORD_TABS, recordHref, type RecordTab } from '../model'
import { isPageKey, NoticeLine, StatusPill, useWords } from '../parts'
import type { InquiryRecordActions, InquiryRecordModel } from '../record-model'
import { fromLine, RecordBody, RecordMeta, RecordVerbs, type RecordSlots } from './RecordTabs'

/** The record's tabs with their counts (files: the inquiry's and the mail's; quote: 1 once made). */
export function recordTabs(view: InquiryView | null, t: (key: string) => string): TabItem[] {
  return RECORD_TABS.map((tab) => ({
    id: tab,
    label: t(`tab.${tab}`),
    count: !view ? null : tab === 'files' ? view.files.length + view.mailFiles.length : tab === 'quote' ? (view.quote ? 1 : null) : tab === 'request' ? (view.lines.length > 0 ? view.lines.length : null) : null,
  }))
}

/** q make quote, d decline, a assign: the open record's verbs (never while typing, in a menu, or under a stacked dialog). */
export function useRecordKeys(model: InquiryRecordModel, actions: InquiryRecordActions | undefined, insideDialog: boolean) {
  const act = useRef(actions)
  act.current = actions
  const view = model.loaded.status === 'ready' ? model.loaded.value : null
  const quiet = !!model.dialog || model.busy || model.saving
  useEffect(() => {
    if (!view) return
    const onKey = (event: KeyboardEvent) => {
      if (quiet || !isPageKey(event, insideDialog)) return
      const verb = event.key === 'q' ? 'quote' : event.key === 'd' ? 'decline' : event.key === 'a' ? 'assign' : null
      if (!verb) return
      const allowed = verb === 'quote' ? view.actions.quote.allowed : verb === 'decline' ? view.actions.decline.allowed : view.actions.assign.allowed
      if (!allowed || !model.can.manage) return
      event.preventDefault()
      act.current?.onVerb?.(verb)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, quiet, insideDialog, model.can.manage])
}

export interface DetailNavModel {
  readonly ids: readonly string[]
  readonly onGo: (id: string) => void
}

/**
 * The inquiry in a centred DetailModal (design pop:inquiries.detail; row Enter, `?open=<id>&tab=…`): the record's tabs Request ·
 * Files & specs · Quote · Activity, the customer match ("Unknown sender — match to a customer"), the sender's mail as sent;
 * Make quote (Q), Assign (A), Decline (D), ⋯ Ask for more information, Mark as lost, Open full page (a new tab); J / K the
 * next and previous inquiry of the list; Esc closes.
 */
export function InquiryDetail({ model, actions, nav, slots, onClose }: { model: InquiryRecordModel; actions?: InquiryRecordActions; nav: DetailNavModel | null; slots?: RecordSlots; onClose?: () => void }) {
  const { t } = useWords()
  const view = model.loaded.status === 'ready' ? model.loaded.value : null
  useRecordKeys(model, actions, true)
  const error =
    model.loaded.status === 'error'
      ? t(model.loaded.problem)
      : model.loaded.status === 'notFound'
        ? t('record.notFoundBody')
        : model.loaded.status === 'forbidden'
          ? t('noAccess.body')
          : undefined
  return (
    <DetailModal
      open
      onClose={() => onClose?.()}
      title={view ? `${view.number} · ${fromLine(view, t)}` : t('record.reading')}
      subtitle={view ? view.summary : undefined}
      meta={
        view ? (
          <>
            <StatusPill status={view.status} />
            <RecordMeta view={view} />
          </>
        ) : undefined
      }
      actions={
        view ? (
          <span className="fw-inq-actions">
            <Button size="sm" variant="quiet" asChild>
              <a href={recordHref(model.prefix, view.id, model.tab)} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} aria-hidden /> {t('record.openFull')}
              </a>
            </Button>
            <RecordVerbs model={model} view={view} actions={actions} />
          </span>
        ) : undefined
      }
      tabs={recordTabs(view, t)}
      activeTab={model.tab}
      onTabChange={(id) => actions?.onTab?.(id as RecordTab)}
      tabsLabel={t('record.tabs')}
      nav={nav && view && nav.ids.length > 1 && nav.ids.includes(view.id) ? { ids: nav.ids, current: view.id, onGo: nav.onGo, noun: t('record.noun') } : undefined}
      loading={model.loaded.status === 'loading'}
      error={error}
      onRetry={model.loaded.status === 'error' ? () => actions?.onRetry?.() : undefined}
    >
      {view && (
        <>
          <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
          <RecordBody model={model} view={view} actions={actions} slots={slots} />
        </>
      )}
    </DetailModal>
  )
}
