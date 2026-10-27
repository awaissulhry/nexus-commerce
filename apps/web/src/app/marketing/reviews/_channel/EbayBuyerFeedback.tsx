'use client'

/**
 * Reviews › eBay — "Leave feedback for buyers" (PR G, eBay's REST Feedback API). The sales eBay lists as waiting for the
 * seller's feedback (`GET /api/reviews/area/ebay/buyer-feedback`, read by Nexus every 30 minutes), each with the buyer,
 * market and sale date of its Nexus order when Nexus has it. A grid with ticks, select-all and a bulk bar (ruling 7);
 * "Leave positive" on a row, "Leave positive feedback for all N…" in the header.
 *
 * Nexus never leaves feedback by itself: the window's "Send for approval" asks ONE approval
 * (`POST …/buyer-feedback/send`: a request for one sale, a change plan for several) that a person decides on the
 * Approvals page; only then does eBay get it. eBay's rules (`@nexus/shared/review-reply-rules`): positive only, up to 500
 * characters (the Textarea counts), within 90 days of the sale, never while a return or case is open — a sale that
 * cannot get feedback says why and is left out of a send. No optimistic rows: the call, `emitInvalidation`, a re-read,
 * then a toast in the server's numbers.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { ThumbsUp } from 'lucide-react'
import { Banner, Card, Field, Modal, useToast } from '@/design-system/components'
import {
  GridCard, GridNoRowsOverlay, GridSelectionActions, GridToolbar, NexusGrid, SelectionLabel, gridGeometry,
  type ColDef, type GridApi, type ICellRendererParams,
} from '@/design-system/grid'
import { Button, Pill, Skeleton, Textarea } from '@/design-system/primitives'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsGet, reviewsSend } from '../_lib/reviewsFetch'
import {
  BUYER_FEEDBACK_LIMIT, DEFAULT_BUYER_FEEDBACK, MANAGE_BUYER_FEEDBACK, buyerResultWords, buyerRowHeld, buyerRowView, buyerSendHeld, buyerSendLabel, buyerSendNote,
  type BuyerFeedbackPage, type BuyerFeedbackRow, type BuyerFeedbackSendAnswer,
} from './ebayToolsModel'
import { lockParams, type ReviewsLock } from './reviewsScope'
import s from './channel.module.css'

export const LEAVE_FEEDBACK_ID = 'ebay-leave-feedback'

interface RowContext { canManage: boolean; onLeave: (row: BuyerFeedbackRow) => void }
type Cell = ICellRendererParams<BuyerFeedbackRow, unknown, RowContext>

const SaleCell = memo(function SaleCell({ data }: Cell) {
  if (!data) return null
  const v = buyerRowView(data)
  return <span className={s.stack}><span className={s.main}>{v.item}</span><span className={s.sub}>{v.order}</span></span>
})

const BuyerCell = memo(function BuyerCell({ data }: Cell) {
  if (!data) return null
  const v = buyerRowView(data)
  return <span className={s.stack}><span className={data.buyer ? s.main : s.sub}>{v.who}</span><span className={s.sub}>{v.where}</span></span>
})

const WhenCell = memo(function WhenCell({ data }: Cell) {
  if (!data) return null
  return <span className={s.sub}>{buyerRowView(data).when}</span>
})

const StatusCell = memo(function StatusCell({ data }: Cell) {
  if (!data) return null
  const v = buyerRowView(data)
  const why = data.state === 'AWAITING' ? data.held ?? data.lastWords : data.left?.text ? `“${data.left.text}”` : null
  return (
    <span className={s.stack}>
      <span><Pill tone={v.status.tone}>{v.status.words}</Pill></span>
      {why && <span className={s.sub} title={why}>{why}</span>}
    </span>
  )
})

const ActionCell = memo(function ActionCell({ data, context }: Cell) {
  if (!data || data.state !== 'AWAITING') return null
  const held = buyerRowHeld(data, context?.canManage ?? false)
  return (
    <Button size="sm" heldReason={held} onClick={() => context?.onLeave(data)} aria-label={`Leave positive feedback for ${buyerRowView(data).who}`}>
      <ThumbsUp size={13} aria-hidden /> Leave positive
    </Button>
  )
})

const COLUMNS: ColDef<BuyerFeedbackRow>[] = [
  { colId: 'sale', headerName: 'Sale', minWidth: 200, flex: 1, cellRenderer: SaleCell },
  { colId: 'buyer', headerName: 'Buyer', width: 180, cellRenderer: BuyerCell },
  { colId: 'when', headerName: 'Sold', width: 190, cellRenderer: WhenCell },
  { colId: 'status', headerName: 'Status', width: 200, cellRenderer: StatusCell },
  { colId: 'action', headerName: '', width: 150, cellRenderer: ActionCell },
]
const rowId = (p: { data: BuyerFeedbackRow }) => p.data.id

export function EbayBuyerFeedback({ lock, canManage }: { lock: ReviewsLock; canManage: boolean }) {
  const { toast } = useToast()
  const market = lockParams(lock).market
  const [page, setPage] = useState<BuyerFeedbackPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)

  const load = useCallback(async () => {
    const mine = ++latest.current
    setBusy(true)
    const res = await reviewsGet<BuyerFeedbackPage>('/reviews/area/ebay/buyer-feedback', { market })
    if (mine !== latest.current) return
    setBusy(false)
    if (res.data) {
      setPage(res.data)
      setError(null)
    } else {
      setError(res.error)
    }
  }, [market])
  useEffect(() => { void load() }, [load])
  useInvalidationChannel(['review.updated'], () => void load())

  const rows = useMemo(() => page?.rows ?? [], [page])
  const ready = useMemo(() => rows.filter((r) => r.state === 'AWAITING' && !r.held), [rows])
  const [api, setApi] = useState<GridApi<BuyerFeedbackRow> | null>(null)
  const [ticked, setTicked] = useState<BuyerFeedbackRow[]>([])
  const [dialog, setDialog] = useState<BuyerFeedbackRow[] | null>(null)
  const onLeave = useCallback((row: BuyerFeedbackRow) => setDialog([row]), [])
  const context = useMemo<RowContext>(() => ({ canManage, onLeave }), [canManage, onLeave])
  const columnDefs = useMemo(() => COLUMNS, [])
  const rowSelection = useMemo<NonNullable<ComponentProps<typeof NexusGrid<BuyerFeedbackRow>>['rowSelection']>>(() => ({
    mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false,
  }), [])
  const selectionColumnDef = useMemo(() => ({ width: gridGeometry.selectColW, maxWidth: gridGeometry.selectColW, resizable: false }), [])
  const onGridReady = useCallback((e: { api: GridApi<BuyerFeedbackRow> }) => setApi(e.api), [])
  const onSelectionChanged = useCallback((e: { api: GridApi<BuyerFeedbackRow> }) => setTicked(e.api.getSelectedRows()), [])
  const clear = useCallback(() => { if (api && !api.isDestroyed()) api.deselectAll() }, [api])
  const noRowsParams = useMemo(() => ({
    title: 'No sales wait for your feedback',
    message: page?.readWords ?? 'eBay lists the sales you have not left feedback for yet; Nexus reads them every 30 minutes.',
  }), [page?.readWords])

  const allHeld = !page ? 'The list is still loading.' : !canManage ? MANAGE_BUYER_FEEDBACK : ready.length === 0 ? 'No sale can get feedback now: each one says why in the list.' : null
  const tickedHeld = buyerSendHeld({ canManage, rows: ticked, text: DEFAULT_BUYER_FEEDBACK })

  return (
    <section id={LEAVE_FEEDBACK_ID} aria-label="Leave feedback for buyers">
      <Card
        header={`Leave feedback for buyers${page ? ` · ${page.counts.awaiting.toLocaleString('en')} waiting` : ''}`}
        headingLevel={2}
        description={`${page?.rule ?? 'Positive only, up to 500 characters, within 90 days of the completed sale.'} Each send waits for approval in Nexus.`}
        headerAction={(
          <Button size="sm" variant="primary" heldReason={allHeld} onClick={() => setDialog(ready)}>
            {`Leave positive feedback for all ${ready.length.toLocaleString('en')}…`}
          </Button>
        )}
      >
        <div className={s.stackGap}>
          {page?.readWords && <Banner tone="info" title={page.readWords} />}
          {error && !page ? (
            <Banner tone="danger" title="The sales waiting for your feedback could not be read." action={<Button size="sm" onClick={() => void load()} heldReason={busy ? 'Reading…' : null}>Try again</Button>}>
              {error}
            </Banner>
          ) : !page ? (
            <Skeleton height={160} />
          ) : (
            <GridCard
              toolbar={(
                <GridToolbar
                  count={ticked.length > 0 ? <><b>{ticked.length.toLocaleString('en')}</b> selected</> : <><b>{rows.length.toLocaleString('en')}</b> sales</>}
                  right={page.counts.waitingApproval > 0 ? <Button asChild size="sm"><Link href="/fleet/approvals">Open Approvals ({page.counts.waitingApproval})</Link></Button> : undefined}
                >
                  {ticked.length > 0 ? (
                    <GridSelectionActions>
                      <Button size="sm" aria-label="Send the ticked sales for approval" onClick={() => setDialog(ticked)} heldReason={tickedHeld}>
                        <ThumbsUp size={13} aria-hidden /> <SelectionLabel>{`Leave positive for ${ticked.length.toLocaleString('en')}…`}</SelectionLabel>
                      </Button>
                      <Button size="sm" variant="link" onClick={clear}>Clear</Button>
                    </GridSelectionActions>
                  ) : (
                    <span className={s.sub}>{`${page.counts.ready.toLocaleString('en')} ready · ${page.counts.waitingApproval.toLocaleString('en')} waiting for approval · ${page.counts.held.toLocaleString('en')} held`}</span>
                  )}
                </GridToolbar>
              )}
            >
              <NexusGrid<BuyerFeedbackRow>
                domLayout="autoHeight"
                rows="media"
                rowData={rows}
                columnDefs={columnDefs}
                getRowId={rowId}
                context={context}
                rowSelection={rowSelection}
                selectionColumnDef={selectionColumnDef}
                onGridReady={onGridReady}
                onSelectionChanged={onSelectionChanged}
                noRowsOverlayComponent={GridNoRowsOverlay}
                noRowsOverlayComponentParams={noRowsParams}
              />
            </GridCard>
          )}
          <p className={s.note}>Feedback for a buyer cannot be changed after it is sent; you can add one follow-up on eBay later. Buyers with an open return or case are held until it closes.</p>
        </div>
      </Card>

      {dialog && (
        <LeaveDialog
          rows={dialog}
          canManage={canManage}
          onClose={() => setDialog(null)}
          onDone={(words, tone) => { setDialog(null); clear(); toast(words, tone); void load() }}
        />
      )}
    </section>
  )
}

interface LeaveDialogProps {
  rows: readonly BuyerFeedbackRow[]
  canManage: boolean
  onClose: () => void
  onDone: (words: string, tone: 'success' | 'warning') => void
}

/** The feedback text (counted against eBay's 500), what a send asks for, and "Send for approval". */
function LeaveDialog({ rows, canManage, onClose, onDone }: LeaveDialogProps) {
  const [text, setText] = useState(DEFAULT_BUYER_FEEDBACK)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const held = buyerSendHeld({ canManage, rows, text, busy })
  const sendable = rows.filter((r) => !r.held).length
  const note = buyerSendNote(rows)
  const first = rows.length === 1 ? buyerRowView(rows[0]) : null

  const send = async () => {
    setBusy(true)
    setError(null)
    const res = await reviewsSend<BuyerFeedbackSendAnswer>('POST', '/reviews/area/ebay/buyer-feedback/send', { ids: rows.map((r) => r.id), text: text.trim() }, { idempotent: true, what: 'feedback for buyers' })
    setBusy(false)
    if (!res.data) {
      setError(res.error)
      return
    }
    emitInvalidation({ type: 'review.updated', meta: { buyerFeedback: res.data.changed } })
    const result = buyerResultWords(res.data)
    onDone(result.words, result.tone)
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={first ? `Positive feedback for ${first.who}` : `Positive feedback for ${rows.length.toLocaleString('en')} buyers`}
      subtitle={first ? `${first.item} · ${first.order} · ${first.where}` : undefined}
      footer={(
        <div className={s.dialogFoot}>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => void send()} heldReason={held}>{buyerSendLabel(sendable)}</Button>
        </div>
      )}
    >
      <div className={s.stackGap}>
        <Pill tone="success">Positive · eBay lets a seller leave positive feedback only</Pill>
        <Field label="Feedback text" hint={`eBay allows ${BUYER_FEEDBACK_LIMIT} characters. No links, phone numbers or e-mail addresses.`}>
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} limit={BUYER_FEEDBACK_LIMIT} />
        </Field>
        {note && <p className={s.note}>{note}</p>}
        {error && <Banner tone="danger" title={error} />}
      </div>
    </Modal>
  )
}
