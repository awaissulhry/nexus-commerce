'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { Download, MoreHorizontal, RotateCcw } from 'lucide-react'
import { Card, EmptyState, Menu, PressableRow, ProgressBar, type MenuItemDef } from '@nexus/ui/components'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { CaseChip, CaseItem, CasesRead, ComplaintsRead } from '../api'
import { answerCell, caseHref, complaintStateOfStatus, eightDProgress, itemLine, stateTone, stateWords } from '../model'
import { useReturnWords } from '../words'
import { Loading, OfflineBanner, ReadFailed } from './parts'
import { StartDialog, type StartDialogActions, type StartDialogModel } from './StartDialog'
import '../returns.css'

/**
 * SCR-187 › Returns & claims (design portal.customer.returns: sec:cases "Your returns and claims", sec:complaints
 * "Complaints"): the chips (Open by default · Waiting for you · Closed · All), every case in the shared list frame
 * (select-all, shift range, x / Space, Export N while rows are selected, keys only in the footer's info icon, cards on a
 * phone) with the next step for the customer; then — for the Quality role — the complaints with how far the investigation
 * got and when we answer. No money on this page. "Start a return or claim" is the band's primary (the pop-up below).
 */

export interface ReturnsListViewModel {
  state: 'loading' | 'error' | 'ready'
  read: CasesRead | null
  /** The chip asked in the address (null: the API's default, Open). */
  chip: CaseChip | null
  q: string
  prefix: string
  selected: readonly string[]
  /** Live: the cases changed since they were read. */
  updates: number
  /** No connection: what was loaded and when. */
  offlineSince: string | null
  /** The Quality role's complaints (`hidden`: the person does not follow them). */
  complaints: { state: 'loading' | 'error' | 'ready' | 'hidden'; read: ComplaintsRead | null }
  /** "Start a return or claim" in the empty list waits: why (words), or null. */
  startHeld: string | null
  start: StartDialogModel | null
  /** Design cases: the keys panel open. */
  keysOpen?: boolean
}

export interface ReturnsListActions {
  onChip?: (chip: CaseChip) => void
  onSearch?: (q: string) => void
  onClear?: () => void
  onSelect?: (ids: string[]) => void
  onOpen?: (row: CaseItem) => void
  onOpenComplaint?: (id: string) => void
  onRetry?: () => void
  onRetryComplaints?: () => void
  onShowUpdates?: () => void
  onExport?: (ids: readonly string[]) => void
  onStart?: () => void
  onHelp?: () => void
  start?: StartDialogActions
}

const CHIP_ORDER: readonly CaseChip[] = ['OPEN', 'WAITING', 'CLOSED', 'ALL']
const rowKey = (row: Pick<CaseItem, 'type' | 'id'>) => `${row.type}:${row.id}`

export function ReturnsListView({ model, actions }: { model: ReturnsListViewModel; actions?: ReturnsListActions }) {
  const words = useReturnWords()
  const { t, locale, date, at } = words
  const ds = useDsWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const read = model.read
  const rows = model.state === 'loading' && !read ? null : (read?.items ?? [])
  const chip = read?.chip ?? model.chip ?? 'OPEN'

  const columns = useMemo((): ColDef<CaseItem>[] => {
    const CaseCell = ({ data }: ICellRendererParams<CaseItem>) => {
      if (!data) return null
      return (
        <a
          className="fw-pret-rowlink"
          href={caseHref(latest.current.model.prefix, data.type, data.id)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
            event.preventDefault()
            latest.current.actions?.onOpen?.(data)
          }}
        >
          <RefPair theirs={data.yourRef} ours={data.number} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} layout="stacked" size="sm" copy={false} match={latest.current.model.q || null} labels={ds.refPair} />
        </a>
      )
    }
    const TypeCell = ({ data }: ICellRendererParams<CaseItem>) => (data ? <span className="fw-pret-clip" title={t(`type.${data.type}`)}>{t(`typeShort.${data.type}`)}</span> : null)
    const ItemCell = ({ data }: ICellRendererParams<CaseItem>) => {
      if (!data) return null
      const line = itemLine(data, t)
      return (
        <span className="fw-pret-stack">
          <span className="fw-pret-clip">{line.main}</span>
          {line.more ? <span className="fw-pret-sub fw-pret-clip">{line.more}</span> : null}
        </span>
      )
    }
    const OpenedCell = ({ data }: ICellRendererParams<CaseItem>) => (data ? <span>{date(data.opened)}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<CaseItem>) =>
      data ? (
        <Pill tone={stateTone(data.type, data.state)} truncate>
          {stateWords(t, locale, data.type, data.state, data.words)}
        </Pill>
      ) : null
    const NextCell = ({ data }: ICellRendererParams<CaseItem>) =>
      data ? (
        <span className={data.next.forYou ? 'fw-pret-next is-yours fw-pret-clip' : 'fw-pret-next fw-pret-clip'} title={data.next.words[locale]}>
          {data.next.forYou ? <span className="fw-pret-yours">{t('list.yourMove')} </span> : null}
          {data.next.words[locale]}
        </span>
      ) : null
    const UpdatedCell = ({ data }: ICellRendererParams<CaseItem>) => (data ? <span className="fw-pret-sub" title={at(data.lastUpdate)}>{date(data.lastUpdate)}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<CaseItem>) => {
      if (!data) return null
      const prefix = latest.current.model.prefix
      const items: MenuItemDef[] = [
        { id: 'status', label: t('row.status'), href: caseHref(prefix, data.type, data.id, 'status') },
        { id: 'request', label: t('row.request'), href: caseHref(prefix, data.type, data.id, 'request') },
        { id: 'messages', label: t('row.messages'), href: caseHref(prefix, data.type, data.id, 'messages') },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<CaseItem>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<CaseItem> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      // The phone card's title is the column's text: their reference first, our case number.
      { ...column('case', t('col.case'), CaseCell, { flex: 1.2, minWidth: 236 }), valueGetter: ({ data }) => (data ? [data.yourRef, data.number].filter(Boolean).join(' · ') : '') },
      { ...column('type', t('col.type'), TypeCell, { flex: 0.5, minWidth: 84 }), valueGetter: ({ data }) => (data ? t(`type.${data.type}`) : '') },
      { ...column('item', t('col.item'), ItemCell, { flex: 1.3, minWidth: 140 }), valueGetter: ({ data }) => (data ? itemLine(data, t).main : '') },
      { ...column('opened', t('col.opened'), OpenedCell, { flex: 0.55, minWidth: 108 }), valueGetter: ({ data }) => (data ? date(data.opened) : '') },
      { ...column('status', t('col.status'), StatusCell, { flex: 0.9, minWidth: 176 }), valueGetter: ({ data }) => (data ? stateWords(t, locale, data.type, data.state, data.words) : '') },
      { ...column('next', t('col.next'), NextCell, { flex: 1.8, minWidth: 176 }), valueGetter: ({ data }) => data?.next.words[locale] ?? '' },
      { ...column('updated', t('col.updated'), UpdatedCell, { flex: 0.55, minWidth: 108 }), valueGetter: ({ data }) => (data ? date(data.lastUpdate) : '') },
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, locale, date, at, ds.refPair])

  const count = model.selected.length
  const bulk = (
    <Button size="sm" onClick={() => actions?.onExport?.(model.selected)} aria-label={t('bulk.export', { count })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
    </Button>
  )

  const searching = model.q.trim() !== ''
  const filtered = searching || (model.chip !== null && model.chip !== 'OPEN')
  const nothingAtAll = read !== null && read.chips.find((entry) => entry.chip === 'ALL')?.count === 0 && !searching
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('list.failed')} description={t('list.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      nothingAtAll || !filtered ? (
        <EmptyState
          icon={<RotateCcw size={24} aria-hidden />}
          title={nothingAtAll ? t('list.empty') : t('list.emptyOpenTitle')}
          description={nothingAtAll ? t('list.emptyBody') : t('list.emptyOpen')}
          action={
            <Button size="sm" variant="primary" heldReason={model.startHeld} onClick={() => actions?.onStart?.()}>
              {t('band.start')}
            </Button>
          }
        />
      ) : (
        <EmptyState title={t('list.noMatch')} description={searching ? t('list.noMatchSearch', { q: model.q.trim() }) : t('list.noMatchChip')} action={<Button size="sm" onClick={() => actions?.onClear?.()}>{t('list.clear')}</Button>} />
      )
    ) : undefined

  const shownCount = read ? t('list.count', { count: read.items.length }) : ''
  const chips = read ? CHIP_ORDER.flatMap((code) => read.chips.filter((entry) => entry.chip === code)) : []

  return (
    <div className="fw-pret">
      <OfflineBanner since={model.offlineSince} />
      <section className="fw-pret-section" aria-labelledby="fw-pret-cases">
        <h2 id="fw-pret-cases" className="fw-pret-h2">
          {t('list.cases')}
        </h2>
        <div className="fw-pret-chiprow">
          <div className="fw-pret-chips" role="group" aria-label={t('chips.label')}>
            {chips.map((entry) => (
              <FilterChip key={entry.chip} pressed={entry.chip === chip} onClick={() => actions?.onChip?.(entry.chip)} aria-label={t('chips.chip', { name: t(`chip.${entry.chip}`), count: entry.count })}>
                {t(`chip.${entry.chip}`)} <span className="fw-pret-chip-count">{entry.count}</span>
              </FilterChip>
            ))}
          </div>
          {filtered ? (
            <Button size="sm" variant="quiet" onClick={() => actions?.onClear?.()}>
              {t('chips.clear')}
            </Button>
          ) : null}
        </div>
        <ListFrame<CaseItem>
          label={t('list.label')}
          title={t('list.title')}
          listKey={null}
          rows={model.state === 'error' ? [] : rows}
          rowId={rowKey}
          columns={columns}
          count={shownCount}
          search={
            <Input
              type="search"
              aria-label={t('list.search')}
              placeholder={t('list.searchHint')}
              defaultValue={model.q}
              onKeyDown={(event) => {
                if (event.key === 'Enter') actions?.onSearch?.((event.target as HTMLInputElement).value)
                if (event.key === 'Escape' && (event.target as HTMLInputElement).value === '') (event.target as HTMLInputElement).blur()
              }}
              onBlur={(event) => {
                if (event.target.value.trim() !== model.q.trim()) actions?.onSearch?.(event.target.value)
              }}
            />
          }
          selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          keys={[]}
          onHelp={actions?.onHelp}
          onOpen={(row) => actions?.onOpen?.(row)}
          state={state}
          cards={{ hrefOf: (row) => caseHref(model.prefix, row.type, row.id) }}
          keysOpen={model.keysOpen}
        />
      </section>
      <Complaints model={model} actions={actions} />
      {model.start ? <StartDialog model={model.start} actions={actions?.start} /> : null}
    </div>
  )
}

/** sec:complaints — the Quality role's complaints: hidden for anyone else; a failed read says so (never drawn as none). */
function Complaints({ model, actions }: { model: ReturnsListViewModel; actions?: ReturnsListActions }) {
  const words = useReturnWords()
  const { t, locale, date, day, at } = words
  const ds = useDsWords()
  const part = model.complaints
  if (part.state === 'hidden') return null
  const items = part.read?.items ?? []
  return (
    <section className="fw-pret-section" aria-labelledby="fw-pret-complaints">
      <h2 id="fw-pret-complaints" className="fw-pret-h2">
        {t('complaints.title')}
        {part.read ? <span className="fw-pret-h2-count">{items.length}</span> : null}
      </h2>
      <p className="fw-pret-hint">{t('complaints.hint')}</p>
      {part.state === 'loading' ? (
        <Loading rows={2} height={56} />
      ) : part.state === 'error' ? (
        <ReadFailed title={t('complaints.failed')} onRetry={actions?.onRetryComplaints} />
      ) : items.length === 0 ? (
        <p className="fw-pret-quiet">{t('complaints.empty')}</p>
      ) : (
        <Card className="fw-pret-complaints">
          {items.map((row) => {
            const progress = eightDProgress(row.stepReached)
            return (
              <PressableRow
                key={row.id}
                stacked
                label={
                  <span className="fw-pret-complaint-head">
                    <RefPair theirs={row.yourRef} ours={row.number} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} size="sm" copy={false} labels={ds.refPair} />
                    <Pill tone={stateTone('COMPLAINT', complaintStateOfStatus(row.status))}>{stateWords(t, locale, 'COMPLAINT', complaintStateOfStatus(row.status), row.words)}</Pill>
                  </span>
                }
                description={t('complaints.open', { number: row.number })}
                onClick={() => actions?.onOpenComplaint?.(row.id)}
              >
                <span className="fw-pret-complaint-body">
                  <span className="fw-pret-subject">{row.subject}</span>
                  <span className="fw-pret-sub">{t('complaints.opened', { date: date(row.opened) })}</span>
                  <span className="fw-pret-step">
                    <span className="fw-pret-sub">{row.stepReached ? t('complaints.step', { step: row.stepReached[locale] }) : t('complaints.noStep')}</span>
                    {progress ? <ProgressBar value={Math.round((progress.done / progress.of) * 100)} ariaLabel={t('complaints.progress', { done: progress.done, of: progress.of })} /> : null}
                  </span>
                  <span className="fw-pret-sub">{answerCell(row, t, day, at)}</span>
                </span>
              </PressableRow>
            )
          })}
        </Card>
      )}
    </section>
  )
}
