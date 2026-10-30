'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Camera, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, FileText, Mail, MoreHorizontal, Plus, Send, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, Modal } from '@nexus/ui/components'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Kbd, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { usePhotoWords } from '../../../../../lib/ds-words/photo-capture'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { LotWithHides, Receipt } from '../../api'
import type { Discrepancy, StoredPhoto } from '../../daily-api'
import { changeHeld, claimHeld, ddtPhotoHeld, DISCREPANCY_TONE, NAMESPACE, photoHeld, removeHeld, reportableWhy, reportHeld, reportIds, settleMoves, takesDiscrepancies, wantedDocuments, type Say } from '../../daily-model'
import type { ReceiptDailyActions, ReceiptDailyModel } from '../../daily-state'
import { blankDiscrepancy, claimDraft, draftOf, reportDraft, requestDraft, requestOpenHeld } from '../../daily-model'
import '../../receipts-daily.css'

/**
 * The receipt's W2a tabs (B-W2a-63; design warehouse.receipts rec "Discrepancies" and "Documents check"):
 *  - Discrepancies (SCM-118): short, over, damaged, the wrong item or colour, a missing document — each with its line,
 *    quantity, photos, state (Open / Sent / Agreed / Credited / Closed), the supplier claims that pursue it and when it
 *    was reported; New discrepancy, Send report (the PDF to the supplier on the receipt's thread), Claim from the
 *    supplier (B-W2a-44), and a row's detail (`?open=`) with its photos and the moves a person makes by hand.
 *  - Documents check (SCM-115): the supplier's delivery note with its photo, and the documents the lots still wait for
 *    with "Request from supplier" (B-W2a-F4: the standard mail in the supplier's language to its own contacts, on the receipt's thread).
 * Views only: they fetch nothing.
 */

type T = (key: string, params?: Record<string, string | number>) => string
const words = (t: T, said: Say | null | undefined): string | null => (said ? t(said.key, said.params as Record<string, string | number> | undefined) : null)

/** A discrepancy's reason in the page's language: the list's words, else the kind's. */
export function reasonWords(discrepancy: Pick<Discrepancy, 'reason' | 'kind'>, t: T, locale: string): string {
  if (discrepancy.reason) return locale === 'en' ? discrepancy.reason.labelEn : discrepancy.reason.labelIt
  return t(`kind.${discrepancy.kind}`)
}

/** "10 · DEMO-LEA-01 Nappa" or "The delivery as a whole". */
export function lineWords(discrepancy: Pick<Discrepancy, 'receiptLine'>, t: T): string {
  const line = discrepancy.receiptLine
  return line ? t('disc.line', { seq: line.seq, code: line.item.code, name: line.item.name, colour: line.colour ? ` · ${line.colour.name}` : '' }) : t('disc.wholeDelivery')
}

// ---- Discrepancies ----------------------------------------------------------------------------------------------------------

export function DiscrepanciesTab({ receipt, daily, actions, prefix, timeZone }: { receipt: Receipt; daily: ReceiptDailyModel; actions?: ReceiptDailyActions; prefix: string; timeZone?: string }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone }
  const [selected, setSelected] = useState<readonly string[]>(daily.selected ?? [])
  const rows = daily.discrepancies.value
  const idsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => idsKey.includes(id))), [idsKey])
  const takes = takesDiscrepancies(receipt)
  const newHeld = !daily.can.manage ? t('held.noManage') : !takes ? t('held.receiptClosed') : null
  const reportWhy = rows ? words(t, reportHeld(rows, selected, daily.can)) : t('held.loading')
  const claimWhy = rows ? words(t, claimHeld(rows, selected, daily.can)) : t('held.loading')
  const toReport = rows ? reportIds(rows, selected) : []

  const columns = useMemo<ColDef<Discrepancy>[]>(() => {
    const open = (row: Discrepancy) => actions?.onOpen?.(row.id)
    const KindCell = ({ data }: ICellRendererParams<Discrepancy>) =>
      data ? (
        <span className="fw-by-cell">
          <button type="button" className="fw-rcd-open" onClick={() => open(data)}>
            {t('disc.number', { seq: data.seq })} · {reasonWords(data, t, locale)}
          </button>
          <span className="fw-by-cell-sub">{data.reason && data.reason.code !== data.kind ? t(`kind.${data.kind}`) : data.note ?? ''}</span>
        </span>
      ) : null
    const LineCell = ({ data }: ICellRendererParams<Discrepancy>) => (data ? <span className="fw-by-ellipsis">{lineWords(data, t)}</span> : null)
    const QuantityCell = ({ data }: ICellRendererParams<Discrepancy>) => (data ? <span className="fw-by-num">{data.quantity && data.uom ? `${quantity(data.quantity, locale, 4)} ${t(`uom.${data.uom}`)}` : '—'}</span> : null)
    const PhotosCell = ({ data }: ICellRendererParams<Discrepancy>) =>
      data ? (
        data.photos.length > 0 ? (
          <span className="fw-by-inline">
            <Camera size={13} aria-hidden /> {t('disc.photos', { count: data.photos.length })}
          </span>
        ) : (
          <span className="fw-by-cell-sub">{t('disc.noPhoto')}</span>
        )
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<Discrepancy>) => (data ? <Pill tone={DISCREPANCY_TONE[data.status]}>{t(`discStatus.${data.status}`)}</Pill> : null)
    const ClaimCell = ({ data }: ICellRendererParams<Discrepancy>) =>
      data ? (
        data.claims.length === 0 ? (
          <span className="fw-by-cell-sub">—</span>
        ) : (
          <span className="fw-by-chips">
            {data.claims.map((claim) =>
              daily.can.claimsView ? (
                <Link key={claim.id} className="fw-by-link" href={`${prefix}/purchasing/claims/${claim.id}`}>
                  {claim.number}
                </Link>
              ) : (
                <span key={claim.id}>{claim.number}</span>
              ),
            )}
          </span>
        )
      ) : null
    const SentCell = ({ data }: ICellRendererParams<Discrepancy>) => (data ? <span>{data.sentAt ? formatDateTime(data.sentAt, place) : <span className="fw-by-cell-sub">{t('disc.notSent')}</span>}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<Discrepancy>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('disc.rowMenu', { seq: data.seq }) }}
          items={[
            { id: 'open', label: t('disc.openDetail'), onSelect: () => open(data) },
            { id: 'change', label: t('disc.change'), disabled: changeHeld(data, daily.can) !== null, onSelect: () => actions?.onDialog?.({ kind: 'discrepancy', draft: draftOf(data) }) },
            ...settleMoves(data.status).map((to) => ({ id: `settle-${to}`, label: t(`settle.menu.${to}`), disabled: !daily.can.manage, onSelect: () => actions?.onDialog?.({ kind: 'settle', id: data.id, to, note: '' }) })),
            { id: 'remove', label: t('disc.remove'), tone: 'danger' as const, disabled: removeHeld(data, daily.can) !== null, onSelect: () => actions?.onDialog?.({ kind: 'remove', id: data.id }) },
          ]}
        />
      ) : null
    return [
      { colId: 'kind', headerName: t('col.kind'), minWidth: 220, flex: 1.6, cellRenderer: KindCell },
      { colId: 'line', headerName: t('col.line'), minWidth: 200, flex: 1.4, cellRenderer: LineCell },
      { colId: 'quantity', headerName: t('col.quantity'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: QuantityCell },
      { colId: 'photos', headerName: t('col.photos'), minWidth: 110, flex: 0.6, cellRenderer: PhotosCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 120, flex: 0.7, cellRenderer: StatusCell },
      { colId: 'claim', headerName: t('col.claim'), minWidth: 130, flex: 0.8, cellRenderer: ClaimCell },
      { colId: 'sent', headerName: t('col.sentAt'), minWidth: 150, flex: 0.9, cellRenderer: SentCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, daily.can, prefix, actions, timeZone])

  if (!rows) {
    return daily.discrepancies.problem ? (
      <Card padded>
        <EmptyState title={t('disc.failed')} description={t(daily.discrepancies.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
      </Card>
    ) : (
      <Card padded aria-busy="true">
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('disc.loading')}
        </p>
      </Card>
    )
  }

  const picked = rows.filter((row) => selected.includes(row.id))
  const open = rows.filter((row) => row.status !== 'CLOSED').length
  const unsent = rows.filter((row) => row.status === 'OPEN').length
  const newButton = (
    <Button size="sm" variant="primary" heldReason={newHeld} onClick={() => actions?.onDialog?.({ kind: 'discrepancy', draft: blankDiscrepancy() })} aria-keyshortcuts="n">
      <Plus size={14} aria-hidden /> {t('disc.new')}
    </Button>
  )
  const reportButton = (
    <Button size="sm" heldReason={reportWhy} onClick={() => actions?.onDialog?.({ kind: 'report', draft: reportDraft(toReport) })}>
      <Send size={13} aria-hidden /> {t('disc.sendReport')}
    </Button>
  )

  return (
    <div className="fw-by-stack">
      <div className="fw-by-head">
        <span className="fw-by-status">{rows.length === 0 ? t('disc.summaryNone') : t('disc.summary', { count: rows.length, open, unsent })}</span>
        <span className="fw-by-actions">
          {reportButton}
          {newButton}
        </span>
      </div>
      {!takes && <Banner tone="info" title={t('disc.closedReceipt')} />}
      <ListFrame<Discrepancy>
        label={t('disc.tableLabel')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('disc.count', { count: rows.length })}
        isRowSelectable={(row) => words(t, reportableWhy(row))}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" heldReason={reportWhy} aria-label={t('disc.bulk.report', { count: picked.length })} onClick={() => actions?.onDialog?.({ kind: 'report', draft: reportDraft(toReport) })}>
                <Send size={13} aria-hidden /> <SelectionLabel>{t('disc.bulk.report', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" heldReason={claimWhy} aria-label={t('disc.bulk.claim', { count: picked.length })} onClick={() => actions?.onDialog?.({ kind: 'claim', draft: claimDraft(picked.map((row) => row.id)) })}>
                <FileText size={13} aria-hidden /> <SelectionLabel>{t('disc.bulk.claim', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        keys={[{ keys: ['n'], does: t('disc.keyNew') }]}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={rows.length === 0 ? <EmptyState title={t('disc.empty.title')} description={t('disc.empty.body')} action={takes && daily.can.manage ? newButton : undefined} /> : undefined}
      />
      <p className="fw-by-hint">{t('disc.reportHint')}</p>
    </div>
  )
}

/** The photos of a discrepancy or of the DDT: each as a thumbnail that opens the picture (addresses from the container). */
export function PhotoList({ photos, addresses, label }: { photos: readonly StoredPhoto[]; addresses: ReceiptDailyModel['photos']; label: string }) {
  const t = useT(NAMESPACE)
  if (photos.length === 0) return <p className="fw-by-hint">{t('photo.none')}</p>
  return (
    <ul className="fw-rcd-photos" aria-label={label}>
      {photos.map((photo, index) => {
        const address = addresses[photo.id]
        const alt = t('photo.alt', { label, n: index + 1 })
        return (
          <li key={photo.id} className="fw-rcd-photo">
            {photo.status !== 'AVAILABLE' ? (
              <span className="fw-rcd-photo-wait">{t('photo.pending')}</span>
            ) : address ? (
              <a href={address} target="_blank" rel="noopener" aria-label={t('photo.openFull', { n: index + 1 })}>
                <img src={address} alt={alt} loading="lazy" />
              </a>
            ) : address === null ? (
              <span className="fw-rcd-photo-wait">{t('photo.failed')}</span>
            ) : (
              <span className="fw-rcd-photo-wait" role="status">
                <Spinner size={12} /> {t('photo.loading')}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** One discrepancy in a centred detail (`?open=<id>`; J / K walk the list): what was found, its photos, what happened. */
export function DiscrepancyDetail({ receipt, daily, actions, prefix, timeZone }: { receipt: Receipt; daily: ReceiptDailyModel; actions?: ReceiptDailyActions; prefix: string; timeZone?: string }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const photoWords = usePhotoWords()
  const rows = daily.discrepancies.value ?? []
  const index = rows.findIndex((row) => row.id === daily.open)
  const row = index >= 0 ? rows[index]! : null
  const [capture, setCapture] = useState(false)
  useEffect(() => setCapture(false), [row?.id])
  const ids = row?.photos.map((photo) => photo.id).join(',') ?? ''
  useEffect(() => {
    if (row && row.photos.length > 0) actions?.onPhotos?.(row.photos.filter((photo) => photo.status === 'AVAILABLE').map((photo) => photo.id))
  }, [ids])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || capture) return
      if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'j' && index < rows.length - 1) actions?.onOpen?.(rows[index + 1]!.id)
      if (event.key === 'k' && index > 0) actions?.onOpen?.(rows[index - 1]!.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (!row) return null
  const place = { locale, timeZone }
  const photoWhy = words(t, photoHeld(row, daily.can))
  const changeWhy = words(t, changeHeld(row, daily.can))
  const removeWhy = words(t, removeHeld(row, daily.can))
  return (
    <Modal
      open
      onClose={() => actions?.onOpen?.(null)}
      title={t('detail.title', { seq: row.seq, receipt: receipt.number })}
      subtitle={t('detail.position', { n: index + 1, count: rows.length })}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="quiet" heldReason={index <= 0 ? t('detail.first') : null} onClick={() => actions?.onOpen?.(rows[index - 1]!.id)} aria-keyshortcuts="k">
            <ChevronUp size={14} aria-hidden /> {t('detail.previous')} <Kbd>K</Kbd>
          </Button>
          <Button size="sm" variant="quiet" heldReason={index >= rows.length - 1 ? t('detail.last') : null} onClick={() => actions?.onOpen?.(rows[index + 1]!.id)} aria-keyshortcuts="j">
            <ChevronDown size={14} aria-hidden /> {t('detail.next')} <Kbd>J</Kbd>
          </Button>
          <span className="grow" />
          <Button size="sm" tone="danger" heldReason={removeWhy} onClick={() => actions?.onDialog?.({ kind: 'remove', id: row.id })}>
            <Trash2 size={13} aria-hidden /> {t('disc.remove')}
          </Button>
          <Button size="sm" heldReason={changeWhy} onClick={() => actions?.onDialog?.({ kind: 'discrepancy', draft: draftOf(row) })}>
            {t('disc.change')}
          </Button>
          {settleMoves(row.status).map((to) => (
            <Button key={to} size="sm" variant={to === 'CLOSED' ? 'secondary' : 'primary'} heldReason={daily.can.manage ? null : t('held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'settle', id: row.id, to, note: '' })}>
              {t(`settle.menu.${to}`)}
            </Button>
          ))}
        </>
      }
    >
      <div className="fw-by-dialog">
        <span className="fw-by-meta">
          <Pill tone={DISCREPANCY_TONE[row.status]}>{t(`discStatus.${row.status}`)}</Pill>
          <Tag tone="neutral">{t(`kind.${row.kind}`)}</Tag>
        </span>
        <p className="fw-by-text">{t(`discStatusWords.${row.status}`)}</p>
        <KeyValue
          dense
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('detail.reason'), value: reasonWords(row, t, locale) },
            { label: t('detail.line'), value: lineWords(row, t) },
            { label: t('detail.quantity'), value: row.quantity && row.uom ? `${quantity(row.quantity, locale, 4)} ${t(`uom.${row.uom}`)}` : '—' },
            { label: t('detail.recorded'), value: formatDateTime(row.createdAt, place) },
            { label: t('detail.sent'), value: row.sentAt ? formatDateTime(row.sentAt, place) : t('disc.notSent') },
            ...(row.closedAt ? [{ label: t('detail.closed'), value: formatDateTime(row.closedAt, place) }] : []),
            {
              label: t('detail.claims'),
              value:
                row.claims.length === 0
                  ? '—'
                  : row.claims.map((claim, at) => (
                      <span key={claim.id}>
                        {at > 0 ? ', ' : ''}
                        {daily.can.claimsView ? (
                          <Link className="fw-by-link" href={`${prefix}/purchasing/claims/${claim.id}`}>
                            {claim.number}
                          </Link>
                        ) : (
                          claim.number
                        )}
                      </span>
                    )),
            },
          ]}
        />
        {row.note && (
          <section aria-label={t('detail.note')}>
            <h3 className="fw-by-h3">{t('detail.note')}</h3>
            <p className="fw-by-text">{row.note}</p>
          </section>
        )}
        {row.resolutionNote && (
          <section aria-label={t('detail.resolution')}>
            <h3 className="fw-by-h3">{t('detail.resolution')}</h3>
            <p className="fw-by-text fw-rcd-pre">{row.resolutionNote}</p>
          </section>
        )}
        <section aria-label={t('detail.photos')}>
          <div className="fw-by-card-head">
            <h3 className="fw-by-h3">{t('detail.photos')}</h3>
            {!capture && (
              <Button size="sm" heldReason={photoWhy ?? (daily.uploading ? t('held.busy') : null)} onClick={() => setCapture(true)}>
                <Camera size={13} aria-hidden /> {t('photo.add')}
              </Button>
            )}
          </div>
          {capture ? (
            <PhotoCapture
              label={t('photo.captureLabel', { seq: row.seq })}
              words={photoWords}
              onCapture={async (photo) => {
                await actions?.onAddPhoto?.(row.id, photo.marked ?? photo.photo)
                setCapture(false)
              }}
              onCancel={() => setCapture(false)}
            />
          ) : (
            <PhotoList photos={row.photos} addresses={daily.photos} label={t('detail.photosOf', { seq: row.seq })} />
          )}
        </section>
        {daily.problem && !daily.dialog && <Banner tone="danger" title={words(t, daily.problem)!} />}
      </div>
    </Modal>
  )
}

// ---- Documents check ---------------------------------------------------------------------------------------------------------

export function DocumentsTab({ receipt, lots, daily, actions, prefix, timeZone }: { receipt: Receipt; lots: readonly LotWithHides[] | null; daily: ReceiptDailyModel; actions?: ReceiptDailyActions; prefix: string; timeZone?: string }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const photoWords = usePhotoWords()
  const place = { locale, timeZone }
  const ids = receipt.ddtPhotos.map((photo) => photo.id).join(',')
  useEffect(() => {
    const ready = receipt.ddtPhotos.filter((photo) => photo.status === 'AVAILABLE').map((photo) => photo.id)
    if (ready.length > 0) actions?.onPhotos?.(ready)
  }, [ids])
  const wanted = lots ? wantedDocuments(receipt, lots) : null
  const ddtWhy = words(t, ddtPhotoHeld(receipt, daily.can)) ?? (daily.uploading ? t('held.busy') : null)
  const requestWhy = words(t, requestOpenHeld(receipt, wanted, daily.can))

  const ddtCard: ReactNode = (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">{t('docs.ddtTitle')}</h3>
          {!daily.ddtStep && (
            <Button size="sm" heldReason={ddtWhy} onClick={() => actions?.onDdtStep?.(true)}>
              <Camera size={13} aria-hidden /> {receipt.ddtPhotos.length > 0 ? t('docs.ddtAnother') : t('docs.ddtPhoto')}
            </Button>
          )}
        </div>
        <KeyValue
          dense
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('docs.ddtNumber'), value: receipt.supplierDdtNumber ?? t('docs.ddtNone') },
            { label: t('docs.ddtDate'), value: receipt.supplierDdtDate ? formatDate(dayAt(receipt.supplierDdtDate), place) : '—' },
          ]}
        />
        {daily.ddtStep ? (
          <PhotoCapture label={t('docs.ddtCapture', { number: receipt.number })} words={photoWords} markup={false} onCapture={async (photo) => void (await actions?.onDdtPhoto?.(photo.photo))} onCancel={() => actions?.onDdtStep?.(false)} />
        ) : (
          <PhotoList photos={receipt.ddtPhotos} addresses={daily.photos} label={t('docs.ddtPhotos')} />
        )}
        <p className="fw-by-hint">{t('docs.ddtHint')}</p>
      </div>
    </Card>
  )

  const wantedCard: ReactNode = (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">{t('docs.wantedTitle')}</h3>
          <Button size="sm" heldReason={requestWhy} onClick={() => wanted && actions?.onDialog?.({ kind: 'request', draft: requestDraft(wanted) })}>
            <Mail size={13} aria-hidden /> {t('docs.request')}
          </Button>
        </div>
        {wanted === null ? (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('docs.loading')}
          </p>
        ) : wanted.length === 0 ? (
          <EmptyState title={t('docs.none.title')} description={t('docs.none.body')} />
        ) : (
          <ul className="fw-by-checks">
            {wanted.map((entry) => (
              <li key={entry.key} className="fw-by-check">
                <AlertTriangle size={16} className="fw-by-ico is-warning" aria-hidden />
                <span className="fw-by-check-body">
                  <span>{t(`docs.ask.${entry.ask}`)}</span>
                  {entry.lot && (
                    <span className="fw-by-cell-sub">
                      {t('docs.lotOf', { code: entry.lot.code, ref: entry.lot.supplierLotRef ?? '—', dye: entry.lot.dyeBatch ?? '—' })}{' '}
                      <Link className="fw-by-link" href={`${prefix}/compliance/tests/${entry.lot.id}`}>
                        {t('docs.recordResult')}
                      </Link>
                    </span>
                  )}
                </span>
                <Tag tone="warning">{t('docs.missing')}</Tag>
              </li>
            ))}
          </ul>
        )}
        <p className="fw-by-hint">{t('docs.wantedHint')}</p>
      </div>
    </Card>
  )

  return (
    <div className="fw-by-cards">
      {ddtCard}
      {wantedCard}
      {lots && lots.some((lot) => lot.qualityStatus === 'RELEASED') && (
        <p className="fw-by-hint fw-rcd-span">
          <CheckCircle2 size={14} className="fw-by-ico is-ok" aria-hidden /> {t('docs.released', { count: lots.filter((lot) => lot.qualityStatus === 'RELEASED').length })}
        </p>
      )}
    </div>
  )
}

/** The notice of a W2a act (a claim made, a report sent), with the link to what it made. */
export function DailyNoticeBanner({ daily, actions }: { daily: ReceiptDailyModel; actions?: ReceiptDailyActions }) {
  const t = useT(NAMESPACE)
  const notice = daily.notice
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={words(t, notice.words)!}
      action={
        <span className="fw-by-actions">
          {notice.link && (
            <Button size="sm" asChild>
              {notice.link.newTab ? (
                <a href={notice.link.href} target="_blank" rel="noopener">
                  <ExternalLink size={13} aria-hidden /> {words(t, notice.link.words)}
                </a>
              ) : (
                <Link href={notice.link.href}>{words(t, notice.link.words)}</Link>
              )}
            </Button>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
            {t('common.dismiss')}
          </Button>
        </span>
      }
    />
  )
}
