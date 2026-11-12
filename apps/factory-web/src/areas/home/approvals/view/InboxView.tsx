'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Check, ExternalLink, Inbox, MoreHorizontal, Settings2 } from 'lucide-react'
import { Banner, DetailPopover, EmptyState, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { AsOf, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { money, percent } from '../../../sales/quotes/model'
import { phraseText } from '../../today/words'
import type { ApprovalsViewModel } from '../model'
import { DEPTH_NS, type InboxActions, type InboxViewModel } from '../model'
import { amountOf, decimalMoney, filterRows, heldOf, INBOX_VIEWS, kindsOf, openIdOf, selectHeld, bulkHeld, type InboxRow } from '../inbox'
import { QuoteReview } from './ApprovalsView'
import { BulkApproveDialog } from './BulkApprove'
import { TaskReview } from './TaskReview'
import '../approvals.css'

export type { InboxViewModel, InboxActions } from '../model'

/**
 * SCR-030 — Home › Approvals in depth (B-W2b-307; PLT-085; design home.approvals): ONE inbox for every request that needs
 * a yes. The band (when read, "5 waiting for you", ⋯ Approval rules · Keyboard shortcuts, Out of office W3), the tiles
 * (Waiting for me · Overdue · Asked by me · Decided in 7 days), the notice (requests that changed since they were asked,
 * its link filters them), the requests in the shared list frame (Kind · Request · Record · Asked by · Rule (why is this
 * mine?) · Change size · Amount with the price grain · Waiting / due · Company), the kind filter and search; a request of
 * the approval engine or a quote opens its review (`?open=`), every other kind its own page. Approve N over ticked
 * requests of one kind with no signature (each re-read first); a request of one's own is never ticked (four eyes). It
 * fetches nothing (Approvals.tsx loads it).
 */
export function InboxView({ model, actions, mailSwitch, conversation }: { model: InboxViewModel; actions?: InboxActions; mailSwitch?: ReactNode; conversation?: ReactNode }) {
  return (
    <WithMessages namespaces={[DEPTH_NS, 'approvals', 'sales', 'home', 'lists']}>
      <Inbox_ model={model} actions={actions} mailSwitch={mailSwitch} conversation={conversation} />
    </WithMessages>
  )
}

function Inbox_({ model, actions, mailSwitch, conversation }: { model: InboxViewModel; actions?: InboxActions; mailSwitch?: ReactNode; conversation?: ReactNode }) {
  const t = useT(DEPTH_NS)
  const w1 = useT('approvals')
  const sales = useT('sales')
  const home = useT('home')
  const lists = useT('lists')
  const locale = useLocale()
  const controls = model.controls
  const state = { offline: model.offline, busy: model.busy }
  const [ownHelp, setOwnHelp] = useState(model.dialog?.kind === 'help')
  useEffect(() => setOwnHelp(model.dialog?.kind === 'help'), [model.dialog])
  const help = ownHelp
  const words = (key: string, params?: Record<string, string | number>) => (key.startsWith('problem.read.') || key.startsWith('problem.write.') ? sales(key, params) : t(key, params))

  // ---- each row in words ---------------------------------------------------------------------------------------------------
  const kindWords = (row: InboxRow): string => {
    if (row.task) return locale === 'it' ? row.task.kindLabel.it : row.task.kindLabel.en
    if (row.source === 'quote') return t('kind.QUOTE_APPROVAL')
    return home(`today.kind.${row.kind}`)
  }
  const sentenceOf = (row: InboxRow): string => {
    if (row.task) return row.task.summary
    if (row.quote) {
      const quote = row.quote
      if (quote.reasons.includes('MARGIN_FLOOR') && quote.marginPct !== undefined && quote.marginFloorPct !== undefined) return w1('sentence.margin', { number: quote.number, customer: quote.partyName, pct: percent(quote.marginPct, locale), floor: percent(quote.marginFloorPct, locale) })
      return w1('sentence.reasons', { number: quote.number, customer: quote.partyName, reasons: quote.reasons.map((reason) => sales(`reason.${reason}`)).join(' · ') })
    }
    return row.item ? phraseText(row.item.words.sentence, home, locale) : ''
  }
  const recordOf = (row: InboxRow): { label: string; href: string | null } => {
    if (row.task) return { label: t('row.openRecord'), href: row.href ?? null }
    if (row.quote) return { label: row.quote.number, href: row.href ?? null }
    return { label: row.item?.record.label ?? '', href: row.href ?? null }
  }
  const askedBy = (row: InboxRow): string => {
    if (row.task) return row.task.requester.me ? t('you') : row.task.requester.kind === 'WORKER' ? t('aWorker') : row.task.requester.name
    if (row.quote) return row.quote.askedBy ? (row.quote.askedBy.you ? t('you') : (row.quote.askedBy.name ?? t('colleague'))) : '—'
    return '—'
  }
  const searchText = (row: InboxRow) => [kindWords(row), sentenceOf(row), recordOf(row).label, askedBy(row)].join(' ')
  const all = model.rows.items
  const shown = useMemo(() => (all ? filterRows(all, controls, searchText) : null), [all, controls.kind, controls.q, controls.changed, locale])
  const kinds = useMemo(() => kindsOf(all ?? []), [all])

  // ---- selection (Approve N) -------------------------------------------------------------------------------------------
  const selecting = (controls.view === 'waiting' || controls.view === 'overdue') && model.can.decide
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const shownKey = shown?.map((row) => row.key).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((key) => shownKey.split(',').includes(key))), [shownKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = (shown ?? []).filter((row) => selected.includes(row.key) && selectHeld(row, state) === null)
  const pickedHeld = model.offline ? 'inbox.held.offline' : model.busy ? 'inbox.held.busy' : bulkHeld(picked)
  const pickedKind = picked[0] ? kindWords(picked[0]) : ''

  // ---- columns -------------------------------------------------------------------------------------------------------------
  const multiCompany = Object.keys(model.companies).length > 1
  const columns = useMemo<ColDef<InboxRow>[]>(() => {
    const KindCell = ({ data }: ICellRendererParams<InboxRow>) => (data ? <Tag tone={data.source === 'attention' ? 'neutral' : 'info'}>{kindWords(data)}</Tag> : null)
    const RequestCell = ({ data }: ICellRendererParams<InboxRow>) => {
      if (!data) return null
      const id = openIdOf(data)
      const text = sentenceOf(data)
      const recheck = data.task?.status === 'PENDING' ? data.task.recheck : null
      return (
        <span className="fw-apv-cell">
          {id ? (
            <Link
              className="fw-apv-link"
              href={`${model.prefix}/home/approvals?${new URLSearchParams({ ...(controls.view !== 'waiting' ? { view: controls.view } : {}), open: id }).toString()}`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                event.preventDefault()
                actions?.onOpen?.(id)
              }}
            >
              {text}
            </Link>
          ) : data.href ? (
            <Link className="fw-apv-link" href={data.href}>
              {text}
            </Link>
          ) : (
            text
          )}
          {recheck === 'CHANGED' && <span className="fw-apv-sub is-warning">{t('recheck.changedShort')}</span>}
          {data.source === 'attention' && <span className="fw-apv-sub">{t('row.ownPage')}</span>}
        </span>
      )
    }
    const RecordCell = ({ data }: ICellRendererParams<InboxRow>) => {
      if (!data) return null
      const record = recordOf(data)
      return record.href ? (
        <Link className="fw-apv-link" href={record.href}>
          {record.label}
        </Link>
      ) : (
        <span>{record.label}</span>
      )
    }
    const RuleCell = ({ data }: ICellRendererParams<InboxRow>) => {
      if (!data) return null
      const rule = data.task?.rule
      if (data.task && rule) {
        return (
          <DetailPopover trigger={<span className="fw-apv-why">{rule.name}</span>} triggerLabel={t('whyMe.open', { rule: rule.name })} label={t('whyMe.title')}>
            <div className="fw-apv-popover">
              <p className="fw-apv-hint">{locale === 'it' ? rule.sentence.it : rule.sentence.en}</p>
              <p className="fw-apv-hint">{data.task.approver.me ? t('whyMe.named') : t('whyMe.role', { role: data.task.approver.name })}</p>
              {model.can.rules && (
                <Link className="fw-apv-link" href={`${model.prefix}/admin/automation?view=approvals&rule=${encodeURIComponent(rule.id)}`}>
                  {t('whyMe.openRule')}
                </Link>
              )}
            </div>
          </DetailPopover>
        )
      }
      if (data.quote) return <span className="fw-apv-sub">{t('rule.quote')}</span>
      return <span className="fw-apv-sub">{data.item ? phraseText(data.item.words.why, home, locale) : '—'}</span>
    }
    const DueCell = ({ data }: ICellRendererParams<InboxRow>) => {
      if (!data) return null
      return (
        <span className="fw-apv-cell">
          <span>{t('since', { when: formatDateTime(data.since, { locale }) })}</span>
          {data.due && <span className={`fw-apv-sub${data.overdue ? ' is-danger' : ''}`}>{t(data.overdue ? 'dueWas' : 'due', { when: data.due.length === 10 ? data.due : formatDateTime(data.due, { locale }) })}</span>}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<InboxRow>) => {
      if (!data) return null
      const status = data.task?.status ?? data.quote?.status ?? 'PENDING'
      return <Pill tone={status === 'APPROVED' ? 'success' : status === 'REJECTED' ? 'danger' : status === 'PENDING' ? 'info' : 'neutral'}>{t(`status.${status}`)}</Pill>
    }
    const amount = (row: InboxRow | undefined): string => {
      if (!row) return ''
      if (row.quote) return money(row.quote.netAmount, row.quote.currency, locale)
      const fact = row.task ? amountOf(row.task) : null
      return fact ? decimalMoney(fact.value, fact.currency, locale) : ''
    }
    const decidedView = controls.view === 'mine' || controls.view === 'decided'
    return [
      { colId: 'kind', headerName: t('col.kind'), flex: 1, minWidth: 140, valueGetter: (params) => (params.data ? kindWords(params.data) : ''), cellRenderer: KindCell },
      { colId: 'request', headerName: t('col.request'), flex: 3, minWidth: 300, valueGetter: (params) => (params.data ? sentenceOf(params.data) : ''), cellRenderer: RequestCell },
      { colId: 'record', headerName: t('col.record'), flex: 1, minWidth: 140, valueGetter: (params) => (params.data ? recordOf(params.data).label : ''), cellRenderer: RecordCell },
      { colId: 'askedBy', headerName: t('col.askedBy'), flex: 1, minWidth: 130, valueGetter: (params) => (params.data ? askedBy(params.data) : '') },
      ...(decidedView ? ([{ colId: 'approver', headerName: t('col.approver'), flex: 1, minWidth: 130, valueGetter: (params) => (params.data?.task ? (params.data.task.approver.me ? t('you') : params.data.task.approver.name) : params.data?.quote?.decidedBy ? (params.data.quote.decidedBy.you ? t('you') : (params.data.quote.decidedBy.name ?? t('colleague'))) : '') }] satisfies ColDef<InboxRow>[]) : []),
      { colId: 'rule', headerName: t('col.rule'), flex: 1.4, minWidth: 170, valueGetter: (params) => params.data?.task?.rule?.name ?? '', cellRenderer: RuleCell },
      { colId: 'size', headerName: t('col.size'), flex: 1, minWidth: 110, valueGetter: (params) => (params.data?.task ? (locale === 'it' ? params.data.task.changeSize.it : params.data.task.changeSize.en) : '') },
      ...(model.grains.price ? ([{ colId: 'amount', headerName: t('col.amount'), flex: 1, minWidth: 120, type: 'rightAligned', valueGetter: (params) => amount(params.data) }] satisfies ColDef<InboxRow>[]) : []),
      { colId: 'waiting', headerName: t('col.waiting'), flex: 1.2, minWidth: 170, valueGetter: (params) => params.data?.since ?? '', cellRenderer: DueCell },
      ...(decidedView ? ([{ colId: 'state', headerName: t('col.state'), flex: 1, minWidth: 120, valueGetter: (params) => params.data?.task?.status ?? params.data?.quote?.status ?? '', cellRenderer: StateCell }] satisfies ColDef<InboxRow>[]) : []),
      ...(multiCompany ? ([{ colId: 'company', headerName: t('col.company'), flex: 1, minWidth: 130, valueGetter: (params) => (params.data?.companyId ? (model.companies[params.data.companyId] ?? '') : '') }] satisfies ColDef<InboxRow>[]) : []),
    ]
    // The cells read the words, the language, the view and the grains through the closure: a change rebuilds them.
  }, [t, w1, sales, home, locale, model.prefix, controls.view, model.grains.price, model.can.rules, multiCompany, model.companies])

  // ---- the tiles -----------------------------------------------------------------------------------------------------------
  const metrics: Metric[] = INBOX_VIEWS.map((view) => {
    const count = model.counts[view]
    return {
      label: t(`tile.${view}`),
      value: count === null ? '—' : model.capped && count >= 200 ? t('tileMore', { count }) : String(count),
      onClick: () => actions?.onControls?.({ view, open: null, changed: false }),
      active: controls.view === view,
    }
  })
  const waiting = model.counts.waiting

  const filtered = controls.kind !== null || controls.q.trim() !== '' || controls.changed
  const emptyState: ReactNode = model.rows.problem ? (
    <EmptyState title={t('failed')} description={words(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
  ) : shown && shown.length === 0 ? (
    <EmptyState
      icon={<Inbox size={24} aria-hidden />}
      title={t(filtered ? 'empty.filtered.title' : `empty.${controls.view}.title`)}
      description={t(filtered ? 'empty.filtered.body' : `empty.${controls.view}.body`)}
      action={
        filtered ? (
          <Button size="sm" onClick={() => actions?.onControls?.({ kind: null, q: '', changed: false })}>
            {t('empty.clear')}
          </Button>
        ) : controls.view === 'waiting' && (model.counts.mine ?? 0) > 0 ? (
          <Button size="sm" onClick={() => actions?.onControls?.({ view: 'mine', open: null })}>
            {t('empty.showMine', { count: model.counts.mine ?? 0 })}
          </Button>
        ) : undefined
      }
    />
  ) : undefined

  const tools = (
    <span className="fw-apv-tools">
      <Select size="sm" value={controls.kind ?? ''} aria-label={t('filter.kind')} onChange={(event) => actions?.onControls?.({ kind: event.target.value || null })}>
        <option value="">{t('filter.anyKind')}</option>
        {kinds.map((entry) => {
          const row = (all ?? []).find((item) => item.kind === entry.kind)!
          return (
            <option key={entry.kind} value={entry.kind}>
              {t('filter.kindCount', { kind: kindWords(row), count: entry.count })}
            </option>
          )
        })}
      </Select>
      {controls.changed && (
        <Button size="sm" variant="quiet" onClick={() => actions?.onControls?.({ changed: false })} aria-label={t('filter.changedOff')}>
          {t('filter.changedChip')} ×
        </Button>
      )}
    </span>
  )

  const quoteModel: ApprovalsViewModel = {
    prefix: model.prefix,
    me: model.me,
    grains: model.grains,
    can: model.can.quotes,
    view: controls.view === 'overdue' ? 'waiting' : controls.view,
    rows: { items: (all ?? []).flatMap((row) => (row.quote ? [row.quote] : [])), problem: null },
    counts: { waiting: null, mine: null, decided: null, capped: false },
    asOf: model.asOf,
    open: model.quoteReview,
    rejecting: model.quoteRejecting,
    busy: model.busy,
    notice: null,
  }

  return (
    <div className="fw-apv">
      <div className="fw-apv-head">
        <div className="fw-apv-status">
          {model.asOf ? <AsOf at={model.asOf} /> : <span className="fw-apv-hint">{t('notYet')}</span>}
          {waiting !== null && waiting > 0 && <Tag tone="info">{t('waitingForYou', { count: waiting })}</Tag>}
          {model.offline && <Tag tone="warning">{t('offline')}</Tag>}
        </div>
        <div className="fw-apv-actions">
          {mailSwitch}
          <Button size="sm" heldReason={t('later.W3')}>
            {t('band.outOfOffice')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              ...(model.can.rules ? [{ id: 'rules', label: t('band.rules'), href: `${model.prefix}/admin/automation?view=approvals` }] : [{ id: 'rules', label: t('band.rules'), disabled: true, description: t('held.noRules') }]),
              { id: 'keys', label: t('band.keys'), onSelect: () => setOwnHelp(true) },
            ]}
          />
        </div>
      </div>
      <p className="fw-apv-hint">{t('intro')}</p>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={words(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      <MetricStrip metrics={metrics} minTileWidth={170} />
      {model.changedSinceAsked > 0 && !controls.changed && (
        <Banner
          tone="warning"
          title={t('notice.changed', { count: model.changedSinceAsked })}
          action={
            <Button size="sm" onClick={() => actions?.onControls?.({ changed: true })}>
              {t('notice.show')}
            </Button>
          }
        />
      )}
      <ListFrame<InboxRow>
        label={t(`table.${controls.view}`)}
        title={t('table.title')}
        rows={shown}
        rowId={(row) => row.key}
        columns={columns}
        count={shown ? (model.capped ? t('countAtLeast', { count: shown.length }) : t('count', { count: shown.length })) : '—'}
        search={<Input type="search" size="sm" value={controls.q} onChange={(event) => actions?.onControls?.({ q: event.target.value })} placeholder={t('search')} aria-label={t('search')} />}
        tools={tools}
        selection={
          selecting
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" variant="primary" aria-label={t('bulk.approve', { count: picked.length, kind: pickedKind })} heldReason={pickedHeld ? t(pickedHeld) : null} onClick={() => actions?.onBulk?.(picked.map((row) => row.key))}>
                    <Check size={13} aria-hidden /> <SelectionLabel>{t('bulk.approve', { count: picked.length, kind: pickedKind })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={selecting ? (row) => {
          const held = selectHeld(row, state)
          return held ? t(held) : null
        } : undefined}
        keys={[]}
        onHelp={() => setOwnHelp(true)}
        onOpen={(row) => {
          const id = openIdOf(row)
          if (id) actions?.onOpen?.(id)
          else if (row.href) window.location.assign(row.href)
        }}
        state={emptyState}
        focusRow={model.focusRow}
      />
      {help && (
        <Modal open onClose={() => setOwnHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-apv-list">
            {[...listKeys([], selecting), { keys: ['Enter'], does: t('keys.open') }, { keys: ['A'], does: t('keys.approve') }, { keys: ['R'], does: t('keys.reject') }, { keys: ['J', 'K'], does: t('keys.walk') }, { keys: ['⌘', 'Enter'], does: t('keys.confirm') }].map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {model.dialog?.kind === 'bulk' && <BulkApproveDialog model={model} rows={(all ?? []).filter((row) => model.dialog?.kind === 'bulk' && model.dialog.keys.includes(row.key))} actions={actions} kindWords={kindWords} />}
      {model.quoteReview && (
        <QuoteReview
          model={quoteModel}
          actions={{
            ...actions?.quote,
            onOpen: (id) => actions?.onOpen?.(id),
          }}
        />
      )}
      {model.taskReview && <TaskReview model={model} actions={actions} conversation={conversation} kindWords={kindWords} />}
      {/* The rules link for a phone: the band's ⋯ holds it too. */}
      {model.can.rules && controls.view === 'waiting' && shown && shown.length === 0 && !filtered && (
        <Button size="sm" variant="quiet" asChild>
          <Link href={`${model.prefix}/admin/automation?view=approvals`}>
            <Settings2 size={14} aria-hidden /> {t('band.rules')} <ExternalLink size={12} aria-hidden />
          </Link>
        </Button>
      )}
    </div>
  )
}

/** Why the person may not decide the row now, in words (the review's held buttons). */
export function useHeldWords() {
  const t = useT(DEPTH_NS)
  return (row: InboxRow, state: { offline: boolean; busy: boolean }): string | null => {
    const held = heldOf(row, state)
    return held ? t(held) : null
  }
}
