'use client'

import { useEffect, useId, useState } from 'react'
import { Banner, Card, Tabs, tabPanelProps } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../lib/i18n/provider'
import { WithMessages } from '../i18n'
import { fileGroups, type PanelTab, type RecordPanelsViewModel } from '../model'
import type { RecordPanelsActions } from './actions'
import { FilesPanel } from './FilesPanel'
import { HistoryPanel } from './HistoryPanel'
import { ThreadPanel } from './ThreadPanel'
import '../record-panels.css'

export type { RecordPanelsViewModel } from '../model'
export type { RecordPanelsActions } from './actions'

/**
 * SCR-006 — the record panels (A2 §2.1): the same three panels on every record, as tabs — Thread (internal notes and
 * mail with the record's party, newest first, and the composer), Files (who sees each, versions, retention, upload,
 * download, the PDF viewer) and History (messages, changes and files in one feed with filter chips). Tasks come in W2.
 * It draws ONE view model and fetches nothing (RecordPanels.tsx loads it); it works as wide as a page and as narrow as
 * a phone. Design-system parts only: Card, Tabs, ReplyComposer, FileRow, Timeline, PdfViewer, Banner, EmptyState.
 */
export function RecordPanelsView({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  return (
    <WithMessages namespaces={['records']}>
      <Panels model={model} actions={actions} />
    </WithMessages>
  )
}

function Panels({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  const t = useT('records')
  const idBase = useId()
  const [tab, setTab] = useState<PanelTab>(model.tab ?? 'thread')
  useEffect(() => setTab(model.tab ?? 'thread'), [model.tab])
  // "Now" for retention dates, read once per mount (a server render and the first client render agree on the day).
  const [now] = useState(() => new Date())
  const count = (items: readonly unknown[] | null) => (items === null ? null : items.length)
  const tabs = [
    // No count while older messages are still to load: the pill would say fewer than there are.
    { id: 'thread', label: t('panels.tabs.thread'), count: model.messages.more ? null : count(model.messages.items) },
    // Files counts documents (a file and its earlier versions are one), as the list shows them.
    ...(model.can.readFiles ? [{ id: 'files', label: t('panels.tabs.files'), count: model.files.items === null ? null : fileGroups(model.files.items).length }] : []),
    { id: 'history', label: t('panels.tabs.history') },
  ]
  const active = tabs.some((item) => item.id === tab) ? tab : 'thread'

  return (
    <Card padded className="fw-rp">
      <section aria-label={t('panels.label', { title: model.title })} className="fw-rp-inner">
        <Tabs
          ariaLabel={t('panels.tabs.label')}
          tabs={tabs}
          active={active}
          idBase={idBase}
          overflow="scroll"
          onChange={(id) => {
            setTab(id as PanelTab)
            actions?.onTab?.(id as PanelTab)
          }}
        />
        {model.notice && (
          <Banner
            tone={model.notice.tone}
            title={t(model.notice.key)}
            action={actions?.onDismissNotice ? <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>{t('panels.dismiss')}</Button> : undefined}
          />
        )}
        {/* Every panel stays mounted (hidden when not chosen): a note being written survives a look at the files. */}
        <div {...tabPanelProps(idBase, 'thread')} hidden={active !== 'thread'} className="fw-rp-panel">
          <ThreadPanel model={model} actions={actions} />
        </div>
        {model.can.readFiles && (
          <div {...tabPanelProps(idBase, 'files')} hidden={active !== 'files'} className="fw-rp-panel">
            <FilesPanel model={model} actions={actions} now={now} />
          </div>
        )}
        <div {...tabPanelProps(idBase, 'history')} hidden={active !== 'history'} className="fw-rp-panel">
          <HistoryPanel model={model} actions={actions} />
        </div>
      </section>
    </Card>
  )
}
