'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Info, Lock, X } from 'lucide-react'
import { Button, Checkbox, Tag, Toggle } from '@nexus/ui/primitives'
import { Banner, Modal } from '@nexus/ui/components'
import {
  GridFooterSpacer,
  GridFooterStrip,
  GridSelectionActions,
  GridSheet,
  GridToolbar,
  LoadedRowsSelectionHeader,
  NexusGrid,
  SelectionLabel,
  gridGeometry,
  groupToneClasses,
  type ColDef,
  type ColGroupDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
} from '@nexus/ui/grid'
import { WithMessages } from '../../../record-panels/i18n'
import { useOfficeApi } from '../../../lib/session/context'
import { useT } from '../../../lib/i18n/provider'
import type { Translate } from '../../../lib/i18n/messages'
import { isApiError } from '../../../lib/api/errors'
import { useRoomWidth } from '../../../lib/order-cells/use-room-width'
import { isPhoneRoom } from '../../../lib/orders-sheet/rows'
import { PeoplePicture } from '../../../lib/people-picture/view/PeoplePicture'
import { ListKeysInfo } from '../../../list-frame/ListKeysInfo'
import { EXTRA_RIGHTS, readByCustomer, setEveryCustomer, setExtra, setGiven, type ByCustomer, type ExtraRight, type PoolCustomer, type PoolPerson } from './api'
import { NS, bulkStepOf, customersOf, customersOfPerson, givenKey, givenSetOf, hasExtra, nextGiven, withEvery, withExtra, withTick } from './model'
import './people-by-customer.css'

/**
 * owb-of4 steps 3–4 — People › People by customer (design § 5f, § 5h; the base's declared page): a NexusGrid of office people ×
 * customers, a tick per cell (given / not), each person's picture as letters, the column "Extra rights" with three switches (Allow
 * production · Pack and send · Print and start), and bulk over the selected people: Give to every customer · Take out for every
 * customer… (asks first). Read only for a person without `may.write` (only the owner and admin write it). On a phone: one card per
 * person, its customers as chips.
 */
export function PeopleByCustomerPage() {
  return (
    <WithMessages namespaces={[NS, 'lists']}>
      <Page />
    </WithMessages>
  )
}

type Read = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: ByCustomer } | { readonly status: 'failed'; readonly words: string }

interface PoolContext {
  readonly read: ByCustomer
  readonly given: ReadonlySet<string>
  readonly busy: ReadonlySet<string>
  readonly t: Translate
  readonly onTick: (partyId: string, userId: string) => void
  readonly onExtra: (userId: string, right: ExtraRight, on: boolean) => void
}

type CellParams = ICellRendererParams<PoolPerson, unknown, PoolContext>

function refusalOf(error: unknown, t: Translate): string {
  if (isApiError(error)) {
    if (error.kind === 'forbidden') return t('refused.forbidden')
    if (error.kind === 'conflict') return t('refused.stale')
    if (error.kind === 'not_found') return t('refused.gone')
    if (error.kind === 'unavailable') return t('refused.offline')
  }
  return t('refused.failed')
}

function Page() {
  const api = useOfficeApi()
  const t = useT(NS)
  const lists = useT('lists')
  const { ref, value: phone } = useRoomWidth(isPhoneRoom, false)
  const [read, setRead] = useState<Read>({ status: 'loading' })
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<readonly string[]>([])
  const [asking, setAsking] = useState<readonly string[] | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; words: string } | null>(null)
  const apiRef = useRef<GridApi<PoolPerson> | null>(null)
  const readRef = useRef<ByCustomer | null>(null)
  readRef.current = read.status === 'ready' ? read.value : null

  const load = useCallback(() => {
    const control = new AbortController()
    readByCustomer(api, control.signal)
      .then((value) => !control.signal.aborted && setRead({ status: 'ready', value }))
      .catch((error: unknown) => !control.signal.aborted && setRead({ status: 'failed', words: refusalOf(error, t) }))
    return () => control.abort()
  }, [api, t])
  useEffect(() => load(), [load])

  const mark = (key: string, on: boolean) => setBusy((current) => {
    const next = new Set(current)
    if (on) next.add(key)
    else next.delete(key)
    return next
  })

  const onTick = useCallback(
    async (partyId: string, userId: string) => {
      const now = readRef.current
      if (!now || !now.may.write) return
      const isGiven = nextGiven(givenSetOf(now.given), partyId, userId)
      const key = givenKey(partyId, userId)
      mark(key, true)
      try {
        const answer = await setGiven(api, partyId, userId, isGiven)
        setRead((current) => (current.status === 'ready' ? { status: 'ready', value: withTick(current.value, partyId, userId, isGiven, answer.given) } : current))
      } catch (error) {
        setNotice({ tone: 'danger', words: refusalOf(error, t) })
      } finally {
        mark(key, false)
      }
    },
    [api, t],
  )
  const onExtra = useCallback(
    async (userId: string, right: ExtraRight, on: boolean) => {
      const now = readRef.current
      if (!now || !now.may.write) return
      const key = `extra:${userId}:${right}`
      mark(key, true)
      try {
        const answer = await setExtra(api, userId, right, on)
        setRead((current) => (current.status === 'ready' ? { status: 'ready', value: withExtra(current.value, answer) } : current))
      } catch (error) {
        setNotice({ tone: 'danger', words: refusalOf(error, t) })
      } finally {
        mark(key, false)
      }
    },
    [api, t],
  )
  const runEvery = useCallback(
    async (userIds: readonly string[], isGiven: boolean) => {
      let done = 0
      let refused = 0
      for (const userId of userIds) {
        try {
          const answer = await setEveryCustomer(api, userId, isGiven)
          setRead((current) => (current.status === 'ready' ? { status: 'ready', value: withEvery(current.value, userId, isGiven, answer.given) } : current))
          done++
        } catch {
          refused++
        }
      }
      const words = [t(isGiven ? 'bulk.gaveDone' : 'bulk.tookDone', { count: done }), ...(refused > 0 ? [t('bulk.refused', { count: refused })] : [])].join(' · ')
      setNotice({ tone: refused > 0 ? 'warning' : 'success', words })
      setAsking(null)
    },
    [api, t],
  )
  const onBulk = (act: 'give' | 'takeOut') => {
    const now = readRef.current
    if (!now) return
    const step = bulkStepOf(act, selected, now.given, now.may.write)
    if (step.kind === 'run') void runEvery(step.userIds, step.given)
    else if (step.kind === 'ask') setAsking(step.userIds)
  }

  const value = read.status === 'ready' ? read.value : null
  const context = useMemo<PoolContext | null>(() => (value ? { read: value, given: givenSetOf(value.given), busy, t, onTick: (partyId, userId) => void onTick(partyId, userId), onExtra: (userId, right, on) => void onExtra(userId, right, on) } : null), [value, busy, t, onTick, onExtra])
  useEffect(() => {
    const grid = apiRef.current
    if (!grid || grid.isDestroyed() || !context) return
    grid.setGridOption('context', context)
    grid.refreshCells({ force: true, suppressFlash: true })
  }, [context])

  const customers = value?.customers ?? []
  const customersRef = useRef(customers)
  customersRef.current = customers
  // The columns follow the customers' ids (a tick does not draw them again); their words come with `t`.
  const customersKey = customers.map((customer) => customer.partyId).join(',')
  const columnDefs = useMemo(() => {
    const customers = customersRef.current
    const person: ColDef<PoolPerson> = { colId: 'person', headerName: t('col.person'), pinned: 'left', lockPinned: true, width: 260, minWidth: 200, valueGetter: (params) => params.data?.name ?? '', cellRenderer: PersonCell }
    const extra: ColDef<PoolPerson> = { colId: 'extra', headerName: t('col.extra'), width: 300, minWidth: 220, valueGetter: (params) => params.data?.extra.join(' ') ?? '', cellRenderer: ExtraCell }
    const ticks: Array<ColDef<PoolPerson>> = customers.map((customer) => ({
      colId: `party:${customer.partyId}`,
      headerName: customer.name,
      headerTooltip: `${customer.name} · ${customer.code}`,
      width: 170,
      minWidth: 120,
      valueGetter: (params) => (params.data && readRef.current ? (givenSetOf(readRef.current.given).has(givenKey(customer.partyId, params.data.userId)) ? 'yes' : '') : ''),
      cellRenderer: TickCell,
      cellRendererParams: { customer },
    }))
    const bands: Array<ColGroupDef<PoolPerson>> = [
      { groupId: 'who', headerName: t('group.person'), headerClass: groupToneClasses('slate'), children: [person, extra] },
      { groupId: 'customers', headerName: t('group.customers'), headerClass: groupToneClasses('blue'), children: ticks },
    ]
    return bands
  }, [customersKey, t])

  const rowSelection = useMemo(() => ({ mode: 'multiRow', checkboxes: true, headerCheckbox: false, enableClickSelection: false }) as const, [])
  const selectionColumnDef = useMemo(() => ({ width: gridGeometry.selectColW, maxWidth: gridGeometry.selectColW, resizable: false, headerComponent: LoadedRowsSelectionHeader, headerName: lists('selectAll'), pinned: 'left' as const }), [lists])
  const onGridReady = useCallback((event: GridReadyEvent<PoolPerson>) => {
    apiRef.current = event.api
  }, [])
  const onSelectionChanged = useCallback(() => {
    const grid = apiRef.current
    if (grid) setSelected(grid.getSelectedRows().map((row) => row.userId))
  }, [])
  const getRowId = useCallback((params: { data: PoolPerson }) => params.data.userId, [])
  const keys = useMemo(() => [{ keys: ['↑', '↓', '←', '→'], does: t('keys.arrows') }, { keys: ['Space'], does: t('keys.tick') }, { keys: ['⇧', 'click'], does: t('keys.range') }], [t])

  const write = value?.may.write ?? false
  const bulkBar =
    write && selected.length > 0 ? (
      <GridSelectionActions>
        <span className="fw-pbc-selcount">{t('bulk.selected', { count: selected.length })}</span>
        <Button size="sm" variant="primary" onClick={() => onBulk('give')}>
          <Check size={14} aria-hidden /> <SelectionLabel>{t('bulk.give')}</SelectionLabel>
        </Button>
        <Button size="sm" onClick={() => onBulk('takeOut')}>
          <X size={14} aria-hidden /> <SelectionLabel>{t('bulk.takeOut')}</SelectionLabel>
        </Button>
        <Button size="sm" variant="link" onClick={() => { apiRef.current?.deselectAll(); setSelected([]) }}>
          {t('bulk.clear')}
        </Button>
      </GridSelectionActions>
    ) : null

  return (
    <div className="fw-pbc" ref={ref}>
      <div className="fw-pbc-head">
        <h2 className="fw-pbc-title">{t('title')}</h2>
      </div>
      <Banner tone="info" icon={<Info size={16} aria-hidden />} title={t('intro.title')}>
        {t('intro.body')}
      </Banner>
      {value && !write && <p className="fw-pbc-quiet"><Lock size={12} aria-hidden /> {t('readOnly')}</p>}
      {notice && <Banner tone={notice.tone} title={notice.words} action={<Button size="sm" variant="quiet" onClick={() => setNotice(null)}>{t('dismiss')}</Button>} />}
      {read.status === 'failed' && <Banner tone="danger" title={read.words} action={<Button size="sm" onClick={() => { setRead({ status: 'loading' }); load() }}>{t('retry')}</Button>} />}
      {read.status === 'loading' && <p className="fw-pbc-quiet">{t('reading')}</p>}

      {value && context && (phone ? (
        <>
          {bulkBar && <div className="fw-pbc-cards-bar">{bulkBar}</div>}
          <PeopleCards read={value} write={write} selected={selected} onSelect={(userId, on) => setSelected((current) => (on ? [...current, userId] : current.filter((id) => id !== userId)))} t={t} />
        </>
      ) : (
        <GridSheet
          density="compact"
          gutter={0}
          toolbar={<GridToolbar count={t('count', { people: value.people.length, customers: value.customers.length })}>{bulkBar}</GridToolbar>}
          footer={
            <GridFooterStrip>
              <span className="fw-pbc-quiet">
                <Lock size={12} aria-hidden /> {t('foot')}
              </span>
              <GridFooterSpacer />
              <ListKeysInfo keys={keys} />
            </GridFooterStrip>
          }
        >
          <NexusGrid<PoolPerson>
            fill
            rows="media"
            rowData={value.people as PoolPerson[]}
            columnDefs={columnDefs}
            defaultColDef={{ sortable: false, resizable: true, suppressMovable: true, suppressHeaderMenuButton: true, suppressHeaderContextMenu: true }}
            getRowId={getRowId}
            rowSelection={write ? rowSelection : undefined}
            selectionColumnDef={selectionColumnDef}
            context={context}
            emptyState={<span>{t('empty')}</span>}
            onGridReady={onGridReady}
            onSelectionChanged={onSelectionChanged}
          />
        </GridSheet>
      ))}

      {asking && value && (
        <Modal
          open
          size="sm"
          onClose={() => setAsking(null)}
          title={t('ask.title', { count: asking.length })}
          subtitle={t('ask.subtitle', { rows: value.given.filter((row) => asking.includes(row.userId)).length })}
          footer={
            <>
              <Button onClick={() => setAsking(null)}>{t('cancel')}</Button>
              <Button variant="danger" onClick={() => void runEvery(asking, false)}>
                {t('ask.go', { count: asking.length })}
              </Button>
            </>
          }
        >
          <ul className="fw-pbc-list">
            {value.people.filter((person) => asking.includes(person.userId)).map((person) => (
              <li key={person.userId}>
                <span className="fw-pbc-strong">{person.name}</span> <span className="fw-pbc-muted">· {t('ask.customers', { count: customersOf(value.given, person.userId) })}</span>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

function PersonCell(params: CellParams) {
  const person = params.data
  if (!person) return null
  return (
    <span className="fw-pbc-person">
      <PeoplePicture source={{ name: person.name }} size="sm" nameBeside />
      <span className="fw-pbc-strong fw-pbc-ell">{person.name}</span>
      <span className="fw-pbc-muted fw-pbc-ell">{person.roleWords}</span>
    </span>
  )
}

function ExtraCell(params: CellParams) {
  const person = params.data
  const ctx = params.context
  if (!person || !ctx) return null
  const write = ctx.read.may.write
  return (
    <span className="fw-pbc-extra">
      {EXTRA_RIGHTS.map((right) => {
        const on = hasExtra(person, right)
        const words = ctx.t(`extra.${right}`)
        return (
          <span key={right} className="fw-pbc-switch" title={ctx.t(`extraHint.${right}`)}>
            <Toggle size="xs" checked={on} disabled={!write || ctx.busy.has(`extra:${person.userId}:${right}`)} aria-label={ctx.t('extra.aria', { right: words, name: person.name })} onChange={(next) => ctx.onExtra(person.userId, right, next)} />
            <span className="fw-pbc-small">{words}</span>
          </span>
        )
      })}
    </span>
  )
}

function TickCell(params: CellParams & { readonly customer: PoolCustomer }) {
  const person = params.data
  const ctx = params.context
  if (!person || !ctx) return null
  const key = givenKey(params.customer.partyId, person.userId)
  const on = ctx.given.has(key)
  return (
    <span className="fw-pbc-tick">
      <Checkbox
        checked={on}
        disabled={!ctx.read.may.write || ctx.busy.has(key)}
        aria-label={ctx.t(on ? 'tick.on' : 'tick.off', { name: person.name, customer: params.customer.name })}
        onChange={() => ctx.onTick(params.customer.partyId, person.userId)}
      />
      <span className={on ? 'fw-pbc-small' : 'fw-pbc-small fw-pbc-muted'}>{ctx.t(on ? 'tick.given' : 'tick.notGiven')}</span>
    </span>
  )
}

/** The phone (its room under 640 px): one card per person — the picture as letters, the role, its customers as chips, its extra rights. */
export function PeopleCards({ read, write, selected, onSelect, t }: { read: ByCustomer; write: boolean; selected: readonly string[]; onSelect: (userId: string, on: boolean) => void; t: Translate }) {
  return (
    <ul className="fw-pbc-cards" aria-label={t('cards.label')}>
      {read.people.map((person) => {
        const mine = customersOfPerson(read, person.userId)
        return (
          <li key={person.userId} className="fw-pbc-card">
            <div className="fw-pbc-card-head">
              {write && <Checkbox checked={selected.includes(person.userId)} onChange={(event) => onSelect(person.userId, event.target.checked)} aria-label={t('cards.select', { name: person.name })} />}
              <PeoplePicture source={{ name: person.name }} size="md" nameBeside />
              <span className="fw-pbc-who">
                <span className="fw-pbc-strong">{person.name}</span>
                <span className="fw-pbc-muted">{person.roleWords}</span>
              </span>
            </div>
            <div className="fw-pbc-chips">
              {mine.length === 0 ? <span className="fw-pbc-muted">{t('cards.none')}</span> : mine.map((customer) => <Tag key={customer.partyId}>{customer.name}</Tag>)}
            </div>
            {person.extra.length > 0 && (
              <div className="fw-pbc-chips">
                {person.extra.map((right) => (
                  <Tag key={right} tone="info">
                    {t(`extra.${right}`)}
                  </Tag>
                ))}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
