'use client'

import { useEffect, useMemo, useState } from 'react'
import { Archive, Download, Search } from 'lucide-react'
import { EmptyState, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../lib/i18n/format'
import { useLocale, useT } from '../../lib/i18n/provider'
import { WithMessages } from '../../record-panels/i18n'
import { ListFrame } from '../ListFrame'
import { listKeys, type ListKey } from '../model'

/**
 * The list frame's design lab (`/design/list-frame`): made-up records in the frame, live in the browser — tick rows,
 * the header box (mixed while some are ticked), shift-click a range, j / k / x / Enter / ?, the footer's keys icon. Each
 * case starts from its model; the ticks then follow the clicks.
 */

export interface LabRow {
  id: string
  code: string
  name: string
  status: 'ACTIVE' | 'PROSPECT' | 'BLOCKED'
  country: string
  updatedAt: string
}

export interface ListFrameLabModel {
  rows: readonly LabRow[] | null
  total: number | null
  selected: readonly string[]
  /** More rows than loaded (the footer's Show more). */
  more?: boolean
  updates?: number
  state?: 'failed' | 'empty' | 'no-match'
  /** A list without bulk actions: no checkboxes. */
  readOnly?: boolean
  focusRow?: number
  keysOpen?: boolean
  helpOpen?: boolean
}

const TONE = { ACTIVE: 'success', PROSPECT: 'info', BLOCKED: 'danger' } as const

function NameCell({ data }: ICellRendererParams<LabRow>) {
  if (!data) return null
  return (
    <span className="fw-list-lab-name">
      <a href={`#${data.id}`}>{data.name}</a>
      <span>{data.code}</span>
    </span>
  )
}

export function ListFrameLab({ model }: { model: ListFrameLabModel }) {
  return (
    <WithMessages namespaces={['lists']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Lab({ model }: { model: ListFrameLabModel }) {
  const t = useT('lists')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected)
  const [help, setHelp] = useState(!!model.helpOpen)
  const [query, setQuery] = useState('')
  useEffect(() => setSelected(model.selected), [model.selected])

  const StatusCell = ({ data }: ICellRendererParams<LabRow>) =>
    data ? (
      <Pill tone={TONE[data.status]} dot>
        {t(`lab.status.${data.status}`)}
      </Pill>
    ) : null
  const columns = useMemo<ColDef<LabRow>[]>(
    () => [
      { colId: 'name', headerName: t('lab.col.name'), field: 'name', flex: 2, minWidth: 220, cellRenderer: NameCell },
      { colId: 'status', headerName: t('lab.col.status'), field: 'status', flex: 1, minWidth: 130, cellRenderer: StatusCell },
      { colId: 'country', headerName: t('lab.col.country'), field: 'country', flex: 1, minWidth: 110 },
      {
        colId: 'updated',
        headerName: t('lab.col.updated'),
        field: 'updatedAt',
        flex: 1,
        minWidth: 120,
        valueFormatter: (params) => (params.value ? formatDate(params.value as string, { locale }) : '—'),
      },
    ],
    // The cells read `t` and `locale` through the closure: a language change rebuilds them.
    [t, locale],
  )
  const own: ListKey[] = [{ keys: ['c'], does: t('lab.newKey') }]
  const state =
    model.state === 'failed' ? (
      <EmptyState title={t('lab.failed')} action={<Button size="sm">{t('lab.retry')}</Button>} />
    ) : model.state === 'empty' ? (
      <EmptyState
        title={t('lab.empty')}
        action={
          <Button size="sm" variant="primary">
            {t('lab.newRecord')}
          </Button>
        }
      />
    ) : model.state === 'no-match' ? (
      <EmptyState title={t('lab.noMatch')} action={<Button size="sm">{t('lab.clearFilters')}</Button>} />
    ) : undefined
  const rows = model.rows

  return (
    <div className="fw-list-lab">
      <ListFrame<LabRow>
        label={t('lab.title')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows && model.total !== null ? t('lab.count', { shown: rows.length, total: model.total }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            placeholder={t('lab.search')}
            aria-label={t('lab.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        }
        selection={
          model.readOnly
            ? undefined
            : {
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" aria-label={t('lab.export', { count: selected.length })}>
                      <Download size={13} aria-hidden /> <SelectionLabel>{t('lab.export', { count: selected.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" variant="danger-outline" aria-label={t('lab.archive', { count: selected.length })}>
                      <Archive size={13} aria-hidden /> <SelectionLabel>{t('lab.archive', { count: selected.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
        }
        updates={model.updates ? { count: model.updates, onShow: () => undefined } : null}
        more={model.more && rows && model.total !== null ? { label: t('lab.more', { count: Math.min(50, model.total - rows.length) }), onMore: () => undefined } : null}
        keys={own}
        onHelp={() => setHelp(true)}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      <Modal open={help} onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
        <ul className="fw-list-lab-help">
          {listKeys(own, !model.readOnly).map((entry) => (
            <li key={entry.does}>
              <b>{entry.keys.join(' ')}</b> — {t(entry.does) === entry.does ? entry.does : t(entry.does)}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  )
}
