'use client'

import { useMemo } from 'react'
import { Download, ExternalLink, FileCheck2, MoreHorizontal, Upload } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { ActionList, type ActionGroup } from '@nexus/ui/patterns/ActionList/index'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { Countdown, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { recordPageOf, type PortalKind } from '../../../shell/nav/portal-nav'
import { AccountCard, type CardState } from '../../../shared/account/view/AccountCard'
import { dayWriter } from '../../orders/words'
import { askGroups, downloadHeld, NS, type AskItem, type DocRow, type Words } from '../model'
import { UploadDialog, type UploadDialogActions, type UploadDialogModel } from './UploadDialog'
import '../documents.css'

/**
 * SCR-190 — the supplier's Documents (B-W2b-193; design portal.supplier.documents, archetype portal-page): "We ask for"
 * (the DS ActionList: the kind and what it is for, why in our words, by when, Upload in the row — held with the reason
 * when it waits for our check, in a preview, offline or without the right to upload) and "Your documents" on the shared
 * list frame (kind and file · for · issuer · number · issued · expires with the countdown · our check, a refusal with its
 * reason · Open in a new tab, Replace with a new version, Upload again; select-all + Download N of what we shared back;
 * cards on a phone). The page fills the main area. The frame draws the band (title, as of, Upload a document, ⋯ Ask a
 * question). No money anywhere (C2).
 */

export interface DocumentsViewModel {
  state: CardState
  /** Still loading after about a second. */
  slow: boolean
  /** The read's clock (countdowns render the same on the server and the first client render). */
  now: number
  /** `/p/<party code>` and who reads (record links). */
  prefix: string
  kinds: readonly PortalKind[]
  asks: readonly AskItem[]
  rows: readonly DocRow[]
  selected: readonly string[]
  /** The row being opened or downloaded. */
  busy: string | null
  /** Why every send of the page waits (a `held.*` key), or null. */
  held: string | null
  /** The admins' names (who gives the right to upload). */
  admins: readonly string[]
  receipt: { tone: 'success' | 'warning'; words: Words } | null
  /** A refused open or download (a key). */
  problem: string | null
  dialog: UploadDialogModel | null
  /** Design cases: the documents list's focused row. */
  focusRow?: number
}

export interface DocumentsActions {
  onUpload?: (item: AskItem | null) => void
  onReplace?: (row: DocRow) => void
  onAgain?: (row: DocRow) => void
  onOpen?: (row: DocRow) => void
  onDownload?: (rows: readonly DocRow[]) => void
  onSelected?: (ids: string[]) => void
  onRetry?: () => void
  onHideReceipt?: () => void
  onHideProblem?: () => void
  dialog?: UploadDialogActions
}

export function DocumentsView({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions }) {
  return (
    <WithMessages namespaces={[NS, 'portal', 'portal-account', 'lists', 'ds-words']}>
      <DocumentsBody model={model} actions={actions} />
    </WithMessages>
  )
}

/** A held key in words (who gives the right to upload). */
export function heldText(t: (key: string, params?: Readonly<Record<string, string | number>>) => string, key: string | null, admins: readonly string[]): string | null {
  if (!key) return null
  if (key === 'held.mayNotUpload') return admins.length > 0 ? t('held.mayNotUpload', { names: admins.join(', ') }) : t('held.mayNotUploadNone')
  return t(key)
}

function DocumentsBody({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions | undefined }) {
  const t = useT(NS)
  const say = (words: Words) => t(words.key, words.params)
  const held = heldText(t, model.held, model.admins)
  return (
    <div className="fw-psdoc">
      {model.receipt ? (
        <div role="status">
          <Banner
            tone={model.receipt.tone}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onHideReceipt?.()}>
                {t('receipt.hide')}
              </Button>
            }
          >
            {say(model.receipt.words)}
          </Banner>
        </div>
      ) : null}
      {model.problem ? (
        <div role="alert">
          <Banner
            tone="danger"
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onHideProblem?.()}>
                {t('receipt.hide')}
              </Button>
            }
          >
            {t(model.problem)}
          </Banner>
        </div>
      ) : null}
      <AskSection model={model} actions={actions} />
      <MineSection model={model} actions={actions} held={held} />
      {model.dialog ? <UploadDialog model={model.dialog} heldWords={heldText(t, model.dialog.held, model.admins)} actions={actions?.dialog} /> : null}
    </div>
  )
}

/** A record's links (the company has none: it is the supplier itself). */
function RecordLinks({ records, prefix, kinds }: { records: readonly { type: string; id: string; label: string }[]; prefix: string; kinds: readonly PortalKind[] }) {
  if (records.length === 0) return null
  return (
    <span className="fw-psdoc-links">
      {records.map((record, index) => {
        const page = recordPageOf(kinds, record.type, record.id)
        return (
          <span key={record.id}>
            {index > 0 ? ', ' : null}
            <a href={`${prefix}${page ?? `/open/${record.type}/${record.id}`}`}>{record.label}</a>
          </span>
        )
      })}
    </span>
  )
}

// ── We ask for ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function AskSection({ model, actions }: { model: DocumentsViewModel; actions?: DocumentsActions | undefined }) {
  const t = useT(NS)
  const locale = useLocale()
  const ds = useDsWords()
  const day = dayWriter(locale)
  const say = (words: Words) => t(words.key, words.params)
  const groups: ActionGroup[] = askGroups(model.asks).map(({ group, items }) => ({
    id: group,
    label: t(`documents.group.${group}`),
    items: items.map((item) => ({
      id: item.id,
      title: t('documents.askTitle', { kind: t(item.title.kind), for: say(item.title.for) }),
      record: item.records.length > 0 ? <RecordLinks records={item.records} prefix={model.prefix} kinds={model.kinds} /> : undefined,
      meta: item.waiting ? `${say(item.why)} · ${t('documents.withUs')}` : say(item.why),
      due: item.due ? { at: `${item.due.day}T12:00:00Z`, state: item.due.state, text: day(item.due.day) } : null,
      verb: { label: item.waiting ? t('documents.sendAnother') : t('documents.upload'), kind: 'dialog' as const, onRun: () => actions?.onUpload?.(item), heldReason: heldText(t, item.held, model.admins) },
    })),
  }))
  const open = model.asks.filter((item) => !item.waiting).length
  return (
    <AccountCard id="requested" title={t('documents.asked.title')} description={t('documents.asked.subtitle')} state={model.state} slow={model.slow} failed={t('documents.failed')} onRetry={actions?.onRetry} action={model.state === 'ready' && model.asks.length > 0 ? <Pill tone={open > 0 ? 'warning' : 'success'}>{open > 0 ? t('documents.asked.open', { count: open }) : t('documents.asked.allWithUs')}</Pill> : undefined}>
      <ActionList groups={groups} headingLevel={3} sort={false} empty={t('documents.asked.empty')} labels={ds.actionList} countdownLabels={ds.countdown} now={model.now} />
    </AccountCard>
  )
}

// ── Your documents ───────────────────────────────────────────────────────────────────────────────────────────────────────
type Line = DocRow

function MineSection({ model, actions, held }: { model: DocumentsViewModel; actions?: DocumentsActions | undefined; held: string | null }) {
  const t = useT(NS)
  const locale = useLocale()
  const day = dayWriter(locale)
  const { prefix, kinds, now, busy } = model
  const columns = useMemo<ColDef<Line>[]>(() => {
    const KindCell = ({ data }: ICellRendererParams<Line>) =>
      data ? (
        <span className="fw-psdoc-stack">
          <span className="fw-psdoc-strong">{t(data.kind)}</span>
          <span className="fw-psdoc-muted fw-psdoc-name">{data.name}</span>
        </span>
      ) : null
    const ForCell = ({ data }: ICellRendererParams<Line>) => (data ? data.record.type === 'Party' ? <span>{t('documents.forCompany')}</span> : <RecordLinks records={[data.record]} prefix={prefix} kinds={kinds} /> : null)
    const ExpiresCell = ({ data }: ICellRendererParams<Line>) => {
      if (!data) return null
      if (!data.expiresOn) return <span className="fw-psdoc-muted">{t('documents.noExpiry')}</span>
      return (
        <span className="fw-psdoc-stack">
          <span>{day(data.expiresOn)}</span>
          {data.state === 'EXPIRED' ? (
            <span className="fw-psdoc-danger">{t('documents.expired')}</span>
          ) : data.expiringSoon ? (
            <Countdown className="fw-psdoc-soon" to={`${data.expiresOn}T22:00:00Z`} label={(left) => t('documents.expiresIn', { left })} doneLabel={t('documents.expired')} announce={false} now={now} />
          ) : null}
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<Line>) =>
      data ? (
        <span className="fw-psdoc-stack">
          <Pill tone={data.tone}>{t(`documents.state.${data.state}`)}</Pill>
          {data.reason ? <span className="fw-psdoc-muted">{t('documents.reason', { reason: data.reason })}</span> : data.state === 'ACCEPTED' && data.decidedAt ? <span className="fw-psdoc-muted">{t('documents.acceptedOn', { date: day(data.decidedAt) })}</span> : data.sentAt && !data.shared ? <span className="fw-psdoc-muted">{t('documents.sentOn', { date: day(data.sentAt) })}</span> : null}
        </span>
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<Line>) => {
      if (!data) return null
      if (data.state === 'REJECTED') {
        return (
          <Button size="sm" heldReason={held} onClick={() => actions?.onAgain?.(data)}>
            <Upload size={14} aria-hidden /> {t('documents.again')}
          </Button>
        )
      }
      if (!data.shared) return <span className="fw-psdoc-muted">{t('documents.withUs')}</span>
      return (
        <span className="fw-psdoc-actions">
          <Button size="sm" heldReason={busy === data.id ? t('documents.opening') : null} onClick={() => actions?.onOpen?.(data)} aria-label={t('documents.openOne', { name: data.name })}>
            <ExternalLink size={14} aria-hidden /> {t('documents.open')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('documents.rowMenu', { name: data.name }) }}
            items={[
              { id: 'download', label: t('documents.download'), onSelect: () => actions?.onDownload?.([data]) },
              { id: 'replace', label: t('documents.replace'), disabled: held !== null || data.replace === null, ...(held ? { description: held } : data.replace === null ? { description: t('held.notCurrent') } : {}), onSelect: () => actions?.onReplace?.(data) },
            ]}
          />
        </span>
      )
    }
    return [
      { colId: 'kind', headerName: t('documents.col.kind'), minWidth: 220, flex: 1.6, valueGetter: (params) => (params.data ? `${t(params.data.kind)} — ${params.data.name}` : ''), cellRenderer: KindCell, autoHeight: true },
      { colId: 'for', headerName: t('documents.col.for'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? (params.data.record.type === 'Party' ? t('documents.forCompany') : params.data.record.label) : ''), cellRenderer: ForCell },
      { colId: 'issuer', headerName: t('documents.col.issuer'), minWidth: 150, flex: 1, valueGetter: (params) => params.data?.issuer ?? '—' },
      { colId: 'number', headerName: t('documents.col.number'), minWidth: 120, flex: 0.8, valueGetter: (params) => params.data?.number ?? '—' },
      { colId: 'issued', headerName: t('documents.col.issued'), minWidth: 120, flex: 0.7, valueGetter: (params) => (params.data?.issuedOn ? day(params.data.issuedOn) : '—') },
      { colId: 'expires', headerName: t('documents.col.expires'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data?.expiresOn ? day(params.data.expiresOn) : t('documents.noExpiry')), cellRenderer: ExpiresCell, autoHeight: true },
      { colId: 'status', headerName: t('documents.col.status'), minWidth: 200, flex: 1.3, valueGetter: (params) => (params.data ? t(`documents.state.${params.data.state}`) : ''), cellRenderer: StatusCell, autoHeight: true },
      { colId: 'actions', headerName: t('documents.col.actions'), minWidth: 180, maxWidth: 220, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: ActionsCell },
    ]
    // `day` reads the locale only.
  }, [t, locale, prefix, kinds, now, busy, held, actions])
  const picked = model.rows.filter((row) => model.selected.includes(row.id))
  const waiting = model.rows.filter((row) => row.state === 'WAITING' || row.state === 'CHECKING').length
  const empty =
    model.state === 'ready' && model.rows.length === 0 ? (
      <EmptyState
        icon={<FileCheck2 size={22} aria-hidden />}
        title={t('documents.mine.empty')}
        description={t('documents.mine.emptyHint')}
        action={
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onUpload?.(null)}>
            <Upload size={14} aria-hidden /> {t('documents.uploadOne')}
          </Button>
        }
      />
    ) : undefined
  return (
    <AccountCard id="mine" title={t('documents.mine.title')} description={t('documents.mine.subtitle')} state={model.state} slow={model.slow} failed={t('documents.failed')} onRetry={actions?.onRetry}>
      <ListFrame<Line>
        label={t('documents.mine.title')}
        listKey={null}
        rows={model.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={waiting > 0 ? `${t('documents.mine.count', { count: model.rows.length })} · ${t('documents.mine.waiting', { count: waiting })}` : t('documents.mine.count', { count: model.rows.length })}
        selection={{
          selected: model.selected,
          onChange: (ids: string[]) => actions?.onSelected?.(ids),
          actions: (
            <Button size="sm" aria-label={t('documents.downloadN', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => actions?.onDownload?.(picked)}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('documents.downloadN', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row: Line) => {
          const why = downloadHeld(row)
          return why ? t(why) : null
        }}
        keys={[{ keys: ['u'], does: t('keys.upload') }]}
        onOpen={(row) => (row.shared ? actions?.onOpen?.(row) : undefined)}
        state={empty}
        {...(model.focusRow !== undefined ? { focusRow: model.focusRow } : {})}
        cards={{ fields: { kind: { role: 'title' }, status: { role: 'subtitle' } } }}
      />
    </AccountCard>
  )
}
