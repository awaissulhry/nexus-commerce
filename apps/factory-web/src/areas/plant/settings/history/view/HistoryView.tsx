'use client'

import { useMemo } from 'react'
import { Card, EmptyState } from '@nexus/ui/components'
import type { ColDef } from '@nexus/ui/grid'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import { TIME_ZONE } from '../../../_shared/model'
import type { AuditEntry } from '../../depth-api'
import { historyWords } from '../../depth-model'
import type { Section, SiteChoice } from '../../depth-view-model'
import { PLANT_SETTINGS_NAMESPACES } from '../../model'
import { SectionState, useSettingsWords } from '../../view/parts'
import '../../settings.css'

export interface HistoryModel {
  /** audit.read: without it the window says so and reads nothing. */
  canRead: boolean
  read: Section<AuditEntry[]>
  /** The person's sites, to name where a change was made (null site: the whole group's lists). */
  sites: readonly SiteChoice[]
}

/**
 * SCR-241-audit — Plant settings' audit log in a window of its own (design plant.settings tab:audit: "⌘-click 'History'"):
 * every change of the routing, the unsafe lock, the check types, the symptoms and the machine types the person may read,
 * newest first — when · who (an office person; Nexus for the system) · what, in words · where (a site, or the whole
 * group) · why. A read-only list on the shared list frame (no selection: nothing applies to many rows). Fetches nothing.
 */
export function HistoryView({ model, actions }: { model: HistoryModel; actions?: { onRetry?: () => void } }) {
  return (
    <WithMessages namespaces={PLANT_SETTINGS_NAMESPACES}>
      <Log model={model} onRetry={actions?.onRetry} />
    </WithMessages>
  )
}

function Log({ model, onRetry }: { model: HistoryModel; onRetry?: (() => void) | undefined }) {
  const t = useSettingsWords()
  const locale = useLocale()
  const columns = useMemo<ColDef<AuditEntry>[]>(() => {
    return [
      { colId: 'when', headerName: t('history.when'), minWidth: 170, flex: 0.9, valueGetter: (params) => (params.data ? formatDateTime(params.data.at, { locale, timeZone: TIME_ZONE }) : '') },
      { colId: 'who', headerName: t('history.who'), minWidth: 160, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.actorName ?? t('history.system')) : '') },
      {
        colId: 'what',
        headerName: t('history.what'),
        minWidth: 260,
        flex: 2,
        valueGetter: (params) => {
          if (!params.data) return ''
          const said = historyWords(params.data)
          return t(said.key, said.params)
        },
      },
      { colId: 'where', headerName: t('history.where'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.siteId ? (model.sites.find((site) => site.id === params.data!.siteId)?.name ?? '—') : t('history.group')) : '') },
      { colId: 'why', headerName: t('history.why'), minWidth: 160, flex: 1.2, valueGetter: (params) => params.data?.reason ?? '—' },
    ]
  }, [t, locale, model.sites])
  return (
    <div className="fw-pls">
      <div className="fw-pls-cardtitle">
        <h1 className="fw-pls-window-title">{t('history.title')}</h1>
        <p className="fw-pls-hint">{t('history.intro')}</p>
      </div>
      <Card padded>
        {!model.canRead ? (
          <EmptyState title={t('history.failed')} description={t('history.noRight')} />
        ) : (
          <SectionState read={model.read} title={t('history.title')} onRetry={onRetry}>
            {(entries) => (
              <ListFrame<AuditEntry>
                label={t('history.title')}
                listKey={null}
                rows={entries}
                rowId={(entry) => entry.id}
                columns={columns}
                rowKind="text"
                count={t('history.count', { count: entries.length })}
                state={entries.length === 0 ? <EmptyState title={t('history.empty')} /> : undefined}
              />
            )}
          </SectionState>
        )}
      </Card>
    </div>
  )
}
