'use client'

/**
 * Reviews › Settings › Emails & unsubscribes — the unsubscribe list: addresses that never get our review e-mails
 * (GET /api/email/suppressions; it needs "Manage privacy settings", and without it the list is held with that reason).
 *
 * Row checkboxes, select-all and a bulk bar (build spec ruling 7): "Remove…" takes off only bounced and hand-added
 * addresses and counts what it removes; a buyer's own unsubscribe stays (only the buyer can undo that), so Remove is held
 * when every ticked address is the buyer's. Remove asks first. "Export" downloads the ticked addresses. "Add address"
 * puts one on the list by hand. Every change: the call, then the list is read again, then a toast in the server's count.
 */
import { useCallback, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Banner, Card, EmptyState, Field, Modal, useToast } from '@/design-system/components'
import { NexusGrid, type ColDef, type GridApi, type ICellRendererParams } from '@/design-system/grid'
import { BulkActionBar } from '@/design-system/patterns'
import { Button, Input, Skeleton } from '@/design-system/primitives'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { ReadFailed } from './ReadFailed'
import {
  BUYER_HELD, addressProblem, canRemove, dayWords, maskEmail, removeConfirmWords, removePlan, removedWords, suppressionScope,
  suppressionWhy, suppressionsCsv, visibleSuppressions, type SuppressionRow,
} from './settingsModel'
import type { SettingsRead } from './useSettingsRead'
import s from './settings.module.css'

export const PRIVACY_HELD = "You need 'Manage privacy settings' to see and change the unsubscribe list."
const FIRST = 10

interface Ctx {
  canEdit: boolean
  onRemoveOne: (row: SuppressionRow) => void
}

function AddressCell({ data }: ICellRendererParams<SuppressionRow>) {
  if (!data) return null
  return <span className={s.cellStrong}>{maskEmail(data.email)}</span>
}

function WhyCell({ data }: ICellRendererParams<SuppressionRow>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <span>{suppressionWhy(data)}</span>
      <span className={s.cellSub}>{suppressionScope(data.channel)}</span>
    </span>
  )
}

function SinceCell({ data }: ICellRendererParams<SuppressionRow>) {
  return data ? <span className={s.num}>{dayWords(data.createdAt)}</span> : null
}

function RemoveCell({ data, context }: ICellRendererParams<SuppressionRow, unknown, Ctx>) {
  if (!data) return null
  const held = !canRemove(data) ? BUYER_HELD : !context.canEdit ? PRIVACY_HELD : null
  return (
    <span className={s.cellActions}>
      <Button size="sm" variant="quiet" heldReason={held} onClick={() => context.onRemoveOne(data)} aria-label={`Remove ${maskEmail(data.email)} from the list`}>
        Remove
      </Button>
    </span>
  )
}

const COLUMNS: ColDef<SuppressionRow>[] = [
  { colId: 'address', headerName: 'Address', width: 220, minWidth: 180, cellRenderer: AddressCell },
  { colId: 'why', headerName: 'Why', flex: 2, minWidth: 240, cellRenderer: WhyCell, autoHeight: true },
  { colId: 'since', headerName: 'Since', width: 130, minWidth: 120, cellRenderer: SinceCell },
  { colId: 'remove', headerName: '', width: 110, minWidth: 100, cellRenderer: RemoveCell, sortable: false },
]

const getRowId = (p: { data: SuppressionRow }) => p.data.id

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface UnsubscribeListProps {
  /** null = the person may not see the list. */
  read: SettingsRead<{ rows: SuppressionRow[] }> | null
}

export function UnsubscribeList({ read }: UnsubscribeListProps) {
  const { toast } = useToast()
  const canEdit = read != null
  const rows = useMemo(() => read?.data?.rows ?? [], [read?.data])
  const [showAll, setShowAll] = useState(false)
  const shown = useMemo(() => visibleSuppressions(rows, showAll, FIRST), [rows, showAll])

  // ── Selection: the grid owns it, the page reads it ──
  const gridApi = useRef<GridApi<SuppressionRow> | null>(null)
  const [ticked, setTicked] = useState<SuppressionRow[]>([])
  const onGridReady = useCallback((e: { api: GridApi<SuppressionRow> }) => { gridApi.current = e.api }, [])
  const onSelectionChanged = useCallback((e: { api: GridApi<SuppressionRow> }) => setTicked(e.api.getSelectedRows()), [])
  const clear = useCallback(() => {
    const api = gridApi.current
    if (api && !api.isDestroyed()) api.deselectAll()
    setTicked([])
  }, [])
  const plan = useMemo(() => removePlan(ticked), [ticked])

  // ── Remove (asks first) ──
  const [confirm, setConfirm] = useState<{ ids: string[]; kept: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const onRemoveOne = useCallback((row: SuppressionRow) => setConfirm({ ids: [row.id], kept: 0 }), [])
  const remove = useCallback(async () => {
    if (!confirm) return
    setBusy(true)
    const res = await reviewsSend<{ removed: number; kept: number }>('DELETE', '/email/suppressions', { ids: confirm.ids })
    setBusy(false)
    if (res.error) {
      toast(res.error, 'danger')
      return
    }
    setConfirm(null)
    clear()
    await read?.reload()
    toast(removedWords(res.data?.removed ?? 0, (res.data?.kept ?? 0) + confirm.kept), 'success')
  }, [confirm, clear, read, toast])

  // ── Add address ──
  const [adding, setAdding] = useState(false)
  const [email, setEmail] = useState('')
  const [why, setWhy] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const typed = addressProblem(email)
  const add = useCallback(async () => {
    setBusy(true)
    const res = await reviewsSend<{ created: boolean }>('POST', '/email/suppressions', { email: email.trim(), reason: why.trim() || 'Added by hand' })
    setBusy(false)
    if (res.error) {
      setAddError(res.error)
      return
    }
    setAdding(false)
    setEmail('')
    setWhy('')
    setAddError(null)
    await read?.reload()
    toast(res.data?.created === false ? 'This address was already on the list.' : 'Added to the unsubscribe list.', 'success')
  }, [email, why, read, toast])

  const context = useMemo<Ctx>(() => ({ canEdit, onRemoveOne }), [canEdit, onRemoveOne])
  const columnDefs = useMemo(() => COLUMNS, [])
  const rowSelection = useMemo<NonNullable<ComponentProps<typeof NexusGrid<SuppressionRow>>['rowSelection']>>(() => ({
    mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false,
  }), [])

  const count = rows.length
  const description = !read ? 'Addresses that never get our review e-mails.'
    : read.data ? `${count.toLocaleString('en-US')} ${count === 1 ? 'address never gets' : 'addresses never get'} our review e-mails${count >= 200 ? ' (the newest 200 show here)' : ''}.`
      : 'Addresses that never get our review e-mails.'

  return (
    <Card
      header="Unsubscribe list"
      headingLevel={3}
      description={description}
      headerAction={<Button size="sm" onClick={() => { setAddError(null); setAdding(true) }} heldReason={canEdit ? null : PRIVACY_HELD}>Add address</Button>}
      padded={false}
    >
      {!read ? (
        <div className={s.pad}><Banner tone="info" title="The list is held.">{PRIVACY_HELD}</Banner></div>
      ) : read.error && !read.data ? (
        <div className={s.pad}><ReadFailed error={read.error} onRetry={() => void read.reload()} busy={read.loading} /></div>
      ) : !read.data ? (
        <div className={s.skeletonRows} aria-hidden>{[0, 1, 2].map((i) => <Skeleton key={i} height={36} />)}</div>
      ) : count === 0 ? (
        <EmptyState title="Nobody is on the list" description="Buyers who click unsubscribe, addresses that bounce and the ones you add show here." />
      ) : (
        <>
          <BulkActionBar count={ticked.length} noun={ticked.length === 1 ? 'address ticked' : 'addresses ticked'} onClear={clear}>
            <Button size="sm" variant="danger-outline" heldReason={plan.held} onClick={() => setConfirm({ ids: plan.ids, kept: plan.kept })}>{plan.label}</Button>
            <Button size="sm" onClick={() => download('unsubscribe-list.csv', suppressionsCsv(ticked))}>Export</Button>
          </BulkActionBar>
          {plan.note && <p className={`${s.bulkNote} ${s.pad}`}>{plan.note}</p>}
          <div className={s.tableScroll}>
            <NexusGrid<SuppressionRow>
              plain
              plainMaxHeight={640}
              density="compact"
              rowData={shown}
              columnDefs={columnDefs}
              getRowId={getRowId}
              rowSelection={rowSelection}
              onGridReady={onGridReady}
              onSelectionChanged={onSelectionChanged}
              context={context}
            />
          </div>
          {count > FIRST && (
            <div className={s.listFoot}>
              <span>{showAll ? `Showing all ${count}` : `Showing 1–${FIRST} of ${count}`}</span>
              <Button size="sm" variant="link" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : 'Show all'}</Button>
            </div>
          )}
        </>
      )}

      <Modal
        open={confirm != null}
        onClose={() => setConfirm(null)}
        size="sm"
        title={confirm && confirm.ids.length === 1 ? 'Remove this address from the list?' : `Remove ${confirm?.ids.length ?? 0} addresses from the list?`}
        footer={(
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void remove()} heldReason={busy ? 'Removing…' : null}>Remove</Button>
          </>
        )}
      >
        <p className={s.hint}>{removeConfirmWords(confirm?.ids.length ?? 0)}</p>
        {confirm && confirm.kept > 0 && <p className={s.hint}>{plan.note}</p>}
      </Modal>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        size="sm"
        title="Add an address to the unsubscribe list"
        subtitle="Nexus sends it no review e-mail from now on."
        footer={(
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void add()} heldReason={busy ? 'Adding…' : typed}>Add to the list</Button>
          </>
        )}
      >
        <div className={s.templateForm}>
          {addError && <Banner tone="danger">{addError}</Banner>}
          <Field label="E-mail address" required>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="off" />
          </Field>
          <Field label="Why" hint="Only your team sees this.">
            <Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Asked by phone" />
          </Field>
        </div>
      </Modal>
    </Card>
  )
}
