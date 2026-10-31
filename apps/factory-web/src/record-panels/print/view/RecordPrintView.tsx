'use client'

import { useState } from 'react'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../i18n'
import type { RecordPanelsViewModel } from '../../model'
import type { RecordPanelsActions } from '../../view/actions'
import { FilesPanel } from '../../view/FilesPanel'
import { HistoryPanel } from '../../view/HistoryPanel'
import { TasksPanel } from '../../view/TasksPanel'
import { ThreadPanel } from '../../view/ThreadPanel'
import { printPanelsModel } from '../print-model'
import '../../record-panels.css'
import '../print.css'

/**
 * B-W2b-05 (PLT-171) — the record panels in the record's print view (`?print=1`, design shell.panels tab:print): the
 * thread, the open tasks, the files (who sees each, retention) and the history one after the other, each under its
 * name, instead of tabs. The same panel views as on screen (one way to say a message, a file, a change), drawn read-only.
 */
export function RecordPrintView({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  return (
    <WithMessages namespaces={['records']}>
      <Sections model={printPanelsModel(model)} actions={actions} />
    </WithMessages>
  )
}

/** `actions`: only reading ones reach a control here (older messages, older history, the history's filter, Try again). */
function Sections({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  const t = useT('records')
  // "Now" for retention dates, read once (as the panels on screen).
  const [now] = useState(() => new Date())
  return (
    <section className="fw-rp fw-rp-print" aria-labelledby="fw-rp-print-record">
      <h2 id="fw-rp-print-record" className="fw-rp-print-record">
        {t('panels.label', { title: model.title })}
      </h2>
      <div className="fw-rp-print-part">
        <h2 className="fw-rp-print-title">{t('panels.tabs.thread')}</h2>
        <ThreadPanel model={model} actions={actions} />
      </div>
      {model.tasks && (
        <div className="fw-rp-print-part">
          <h2 className="fw-rp-print-title">{t('panels.tabs.tasks')}</h2>
          <TasksPanel model={model} actions={actions} />
        </div>
      )}
      {model.can.readFiles && (
        <div className="fw-rp-print-part">
          <h2 className="fw-rp-print-title">{t('panels.tabs.files')}</h2>
          <FilesPanel model={model} actions={actions} now={now} />
        </div>
      )}
      <div className="fw-rp-print-part">
        <h2 className="fw-rp-print-title">{t('panels.tabs.history')}</h2>
        <HistoryPanel model={model} actions={actions} />
      </div>
    </section>
  )
}
