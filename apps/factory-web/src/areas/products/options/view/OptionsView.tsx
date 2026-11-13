'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, Card, Field, Menu, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Skeleton, Tag, TokenChip } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { isPageKey, keepLoaded } from '../../library/model'
import { Freshness, KeysDialog, listState, PageHead, showsState } from '../../library/parts'
import { isFiltered, isKind, moveHeldKey, NO_FILTERS, NOTICE_TONE, noticeKey, noticesOf, OPTION_GROUP_KINDS, OPTION_VIEWS, offeredGroupIds, shownRows, STATUS_TONE, type GroupRow, type OptionListView, type OptionNotice } from '../model'
import type { OptionsActions, OptionsViewModel } from '../view-model'
import { GroupFormDialog } from './GroupFormDialog'
import { ResultBanner } from './parts'
import '../../library/library.css'
import '../options.css'

export type { OptionsViewModel, OptionsActions } from '../view-model'

/** The page's catalogues: its own words, the libraries' shared words (problems, common), the list frame's. */
export function OptionsMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['products-options', 'library', 'lists']}>{children}</WithMessages>
}

const PAGE = 50

/**
 * SCR-114 — Options & rules (Products › Libraries; design products.options, workspace-list): the saved-filter tile
 * (Options that take a garment outside its certificate: its chip in the filter row), the notices (one Banner, the most
 * serious; the rest behind "N more notices"; a dismissal kept by value), the option groups on the shared list frame (Group
 * — a real link to its record —, Kind, Options, Min–max picks, Styles, Rules, Status; select-all, shift range, x; Archive N,
 * Restore N, Export N; ⋯ per row; keys only in the footer's information icon; `c` New option group), and — from a style's
 * studio — the style's options, its option BOM lines and its option routing steps. It fetches nothing.
 */
export function OptionsView({ model, actions }: { model: OptionsViewModel; actions?: OptionsActions }) {
  return (
    <OptionsMessages>
      <Options model={model} actions={actions} />
    </OptionsMessages>
  )
}

function Options({ model, actions }: { model: OptionsViewModel; actions?: OptionsActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const locale = useLocale()
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onFilters?.({ ...latest.current.model.filters, q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [dialog, setDialog] = useState<'archive' | 'restore' | 'help' | null>(model.dialog ?? null)
  const [noticesOpen, setNoticesOpen] = useState(model.noticesOpen ?? false)
  const [shown, setShown] = useState(PAGE)
  const rows = useMemo(() => shownRows(model.rows.items, model.style), [model.rows.items, model.style])
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => keepLoaded(current, rows)), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  useEffect(() => setShown(PAGE), [model.filters])

  const newHeld = !model.can.manage ? t('held.noManage') : model.offline ? t('held.offline') : null
  const anyDialog = !!(model.newGroup || dialog)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || anyDialog) return
      if (event.key === 'c' && !newHeld) {
        event.preventDefault()
        actions?.onNewGroup?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const recordHref = useCallback((row: GroupRow) => `${model.prefix}/products/options/${row.id}`, [model.prefix])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]

  const columns = useMemo<ColDef<GroupRow>[]>(() => {
    const GroupCell = ({ data }: ICellRendererParams<GroupRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={recordHref(data)}>
            {data.code}
          </Link>
          <span className="fw-lib-sub">
            {data.name}
            {data.companyId ? '' : ` · ${t('list.everyCompany')}`}
          </span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<GroupRow>) => (data ? <Tag tone="info">{t(`kind.${data.kind}`)}</Tag> : null)
    const OptionsCell = ({ data }: ICellRendererParams<GroupRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <span className={data.values === 0 ? 'fw-lib-warn' : undefined}>{data.values === 0 ? t('list.noOptions') : data.values}</span>
          {data.outsideCertificate > 0 && <span className="fw-lib-sub">{t('list.outside', { count: data.outsideCertificate })}</span>}
        </span>
      ) : null
    const PicksCell = ({ data }: ICellRendererParams<GroupRow>) => (data ? <span className="fw-opt-num">{locale === 'it' ? data.picks.it : data.picks.en}</span> : null)
    const count = (value: number) => (value === 0 ? <span className="fw-lib-hint">0</span> : <span>{value}</span>)
    const StylesCell = ({ data }: ICellRendererParams<GroupRow>) => (data ? count(data.styles) : null)
    const RulesCell = ({ data }: ICellRendererParams<GroupRow>) => (data ? count(data.rules) : null)
    const StatusCell = ({ data }: ICellRendererParams<GroupRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{tl(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<GroupRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': tl('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: tl('list.open'), href: recordHref(data) },
            { id: 'tab', label: tl('list.openNewTab'), href: recordHref(data), target: '_blank' },
            ...(model.can.manage
              ? [
                  data.status === 'ACTIVE'
                    ? { id: 'archive', label: t('list.archive'), onSelect: () => (setSelected([data.id]), setDialog('archive')) }
                    : { id: 'restore', label: t('list.restore'), onSelect: () => (setSelected([data.id]), setDialog('restore')) },
                ]
              : []),
            {
              id: 'copy',
              label: tl('list.copyCode'),
              onSelect: () => {
                void navigator.clipboard?.writeText(data.code).catch(() => undefined)
              },
            },
          ]}
        />
      ) : null
    return [
      { colId: 'group', headerName: t('col.group'), field: 'code', minWidth: 220, flex: 2, cellRenderer: GroupCell },
      { colId: 'kind', headerName: t('col.kind'), field: 'kind', minWidth: 150, flex: 1, cellRenderer: KindCell },
      { colId: 'options', headerName: t('col.options'), field: 'values', minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: OptionsCell },
      { colId: 'picks', headerName: t('col.picks'), minWidth: 140, flex: 0.8, sortable: false, cellRenderer: PicksCell },
      { colId: 'styles', headerName: t('col.styles'), field: 'styles', minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: StylesCell },
      { colId: 'rules', headerName: t('col.rules'), field: 'rules', minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: RulesCell },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 120, flex: 0.7, cellRenderer: StatusCell },
      { colId: 'more', headerName: tl('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, tl, locale, recordHref, model.can.manage])

  const filtered = isFiltered(model.filters)
  const state = showsState(model.rows.problem, rows)
    ? listState({
        problem: model.rows.problem,
        rows,
        filtered,
        forbidden: { title: t('forbidden.title'), body: t('forbidden.body') },
        empty: {
          title: t('empty.title'),
          body: t(model.can.manage ? 'empty.body' : 'empty.bodyView'),
          action: model.can.manage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNewGroup?.(true)}>
              {t('page.new')}
            </Button>
          ) : undefined,
        },
        onRetry: () => actions?.onRetry?.(),
        onClear: () => actions?.onFilters?.(NO_FILTERS),
      })
    : undefined

  const styleUnread = model.style?.problem ? model.style.id : null
  const notices = noticesOf({ ignored: model.rows.ignored, styleUnread, rows: model.rows.items }, new Set(model.dismissed))
  // The tile's number is the list's total under its filter: with a style's link on, counted over the style's groups.
  const outsideCount = model.style?.options
    ? (model.rows.items ?? []).filter((row) => offeredGroupIds(model.style!.options).has(row.id) && row.outsideCertificate > 0).length
    : model.counts?.outsideCertificate
  const archiveHeld = moveHeldKey(picked, model.can, 'archive')
  const restoreHeld = moveHeldKey(picked, model.can, 'restore')
  const ignored = new Set(model.rows.ignored)
  const visible = rows ? rows.slice(0, shown) : null
  const styleCode = model.style?.options?.style.code ?? null

  return (
    <div className="fw-lib fw-opt">
      <PageHead
        intro={t('page.intro')}
        status={<Freshness asOf={model.asOf} />}
        actions={
          <>
            {model.bench /* B-W2b-340: Test a combination (upkeep/TestCombination.tsx) */}
            <Button size="sm" variant="primary" heldReason={newHeld} onClick={() => actions?.onNewGroup?.(true)} aria-keyshortcuts="c">
              <Plus size={14} aria-hidden /> {t('page.new')}
            </Button>
          </>
        }
      />

      {model.offline && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
      <ResultBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />

      {notices.length > 0 && (
        <div className="fw-opt-notices" aria-label={t('notice.label')}>
          {(noticesOpen ? notices : notices.slice(0, 1)).map((notice) => (
            <NoticeView key={noticeKey(notice)} notice={notice} model={model} actions={actions} />
          ))}
          {notices.length > 1 && (
            <Button size="sm" variant="quiet" aria-expanded={noticesOpen} onClick={() => setNoticesOpen((open) => !open)}>
              {noticesOpen ? t('notice.fewer') : t('notice.more', { count: notices.length - 1 })}
            </Button>
          )}
        </div>
      )}

      <MetricStrip
        metrics={[
          {
            label: t('tile.outside'),
            value: model.countsFailed || outsideCount === undefined ? '—' : String(outsideCount),
            hint: model.countsFailed ? t('tile.failed') : t('tile.outsideHint'),
            onClick: () => actions?.onFilters?.({ ...model.filters, outside: !model.filters.outside }),
            active: model.filters.outside,
          },
        ]}
      />

      {filtered && (
        <div className="fw-lib-chips" aria-label={tl('list.activeFilters')}>
          {model.filters.view !== 'active' && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, view: 'active' })}>
              {t(`view.${model.filters.view}`)}
            </TokenChip>
          )}
          {model.filters.outside && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, outside: false })}>
              {t('filter.outside')}
            </TokenChip>
          )}
          {model.filters.kind && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, kind: '' })}>
              {ignored.has(`kind=${model.filters.kind}`) ? t('filter.ignored', { value: model.filters.kind }) : t('filter.kind', { kind: isKind(model.filters.kind) ? t(`kind.${model.filters.kind}`) : model.filters.kind })}
            </TokenChip>
          )}
          {model.filters.style && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, style: '' })}>
              {model.style?.problem ? t('filter.styleUnread') : t('filter.style', { code: styleCode ?? '…' })}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {tl('list.chipSearch', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {tl('list.clearAll')}
          </Button>
        </div>
      )}

      <ListFrame<GroupRow>
        label={t('list.label')}
        title={t('list.title')}
        rows={state ? [] : visible}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? tl('list.count', { count: Math.min(shown, rows.length), total: rows.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('filter.view')} value={model.filters.view} onChange={(event) => actions?.onFilters?.({ ...model.filters, view: event.target.value as OptionListView })}>
              {OPTION_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('filter.kindLabel')} value={isKind(model.filters.kind) ? model.filters.kind : ''} onChange={(event) => actions?.onFilters?.({ ...model.filters, kind: event.target.value })}>
              <option value="">{t('filter.allKinds')}</option>
              {OPTION_GROUP_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          exportSelected: true,
          actions: (
            <>
              <Button size="sm" aria-label={t('bulk.restore', { count: picked.length })} heldReason={restoreHeld ? t(restoreHeld) : null} onClick={() => setDialog('restore')}>
                <ArchiveRestore size={13} aria-hidden /> <SelectionLabel>{t('bulk.restore', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" variant="danger-outline" aria-label={t('bulk.archive', { count: picked.length })} heldReason={archiveHeld ? t(archiveHeld) : null} onClick={() => setDialog('archive')}>
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={rows && rows.length > shown ? { label: tl('list.more'), onMore: () => setShown((current) => current + PAGE) } : null}
        keys={ownKeys}
        onHelp={() => setDialog('help')}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
      />

      {model.style && <StylePanel model={model} />}

      {model.newGroup && <GroupFormDialog form={model.newGroup} onDraft={actions?.onGroupDraft} onSave={actions?.onCreateGroup} onClose={() => actions?.onNewGroup?.(false)} />}
      {(dialog === 'archive' || dialog === 'restore') && <MoveDialog to={dialog} rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />}
      {dialog === 'help' && <KeysDialog keys={listKeys(ownKeys, true)} onClose={() => setDialog(null)} />}
    </div>
  )
}

/** One notice: its words from its kind and value, its action, Dismiss (kept by value) where a fact may be put aside. */
function NoticeView({ notice, model, actions }: { notice: OptionNotice; model: OptionsViewModel; actions?: OptionsActions }) {
  const t = useT('products-options')
  const tl = useT('library')
  const dismiss = (
    <Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.(noticeKey(notice))}>
      {tl('common.dismiss')}
    </Button>
  )
  if (notice.kind === 'IGNORED_FILTER')
    return (
      <Banner
        tone={NOTICE_TONE[notice.kind]}
        title={t('notice.ignored.title', { value: notice.value })}
        action={
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.({ ...model.filters, kind: '' })}>
            {t('notice.ignored.remove')}
          </Button>
        }
      >
        {t('notice.ignored.body')}
      </Banner>
    )
  if (notice.kind === 'STYLE_UNREAD')
    return (
      <Banner
        tone={NOTICE_TONE[notice.kind]}
        title={t('notice.style.title')}
        action={
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.({ ...model.filters, style: '' })}>
            {t('notice.style.remove')}
          </Button>
        }
      >
        {t('notice.style.body')}
      </Banner>
    )
  const more = notice.count > notice.codes.length ? ` ${t('notice.andMore', { count: notice.count - notice.codes.length })}` : ''
  return (
    <Banner tone={NOTICE_TONE[notice.kind]} title={t(notice.kind === 'NO_OPTIONS' ? 'notice.empty.title' : 'notice.unoffered.title', { count: notice.count })} action={dismiss}>
      {t(notice.kind === 'NO_OPTIONS' ? 'notice.empty.body' : 'notice.unoffered.body', { codes: notice.codes.join(', ') })}
      {more}
    </Banner>
  )
}

/** The style the Style studio's link names: its offers, its BOM lines and routing steps only for an option, per revision. */
function StylePanel({ model }: { model: OptionsViewModel }) {
  const t = useT('products-options')
  const tl = useT('library')
  const locale = useLocale()
  const style = model.style!
  if (style.problem) return null
  const options = style.options
  const say = (words: { it: string; en: string }) => (locale === 'it' ? words.it : words.en)
  const revision = (entry: { revision: number; status: string }) => t('style.revision', { revision: entry.revision, status: t(`revisionStatus.${entry.status}`) })
  const groupHref = (groupId: string) => `${model.prefix}/products/options/${groupId}`
  return (
    <Card padded>
      <section className="fw-opt-style" aria-label={t('style.label')}>
        {!options ? (
          <div className="fw-lib-skeleton" aria-busy="true">
            <Skeleton height={22} width={320} />
            <Skeleton height={22} />
            <Skeleton height={22} />
          </div>
        ) : (
          <>
            <div className="fw-opt-cardhead">
              <h2 className="fw-lib-h3">
                {t('style.title', { code: options.style.code, name: options.style.name })}
              </h2>
              <Link className="fw-lib-link" href={`${model.prefix}/products/styles/${options.style.id}`}>
                {t('style.open')}
              </Link>
            </div>
            <p className="fw-lib-hint">{t('style.intro')}</p>
            {options.offers.length === 0 ? (
              <p className="fw-lib-hint">{t('style.noOffers')}</p>
            ) : (
              <SummaryTable
                label={t('style.offers')}
                columns={[t('col.group'), t('style.col.asks'), t('style.col.options'), t('col.status')]}
                stackOnPhone
                rows={options.offers.map((offer) => ({
                  id: offer.id,
                  cells: [
                    <span key="g" className="fw-lib-cell">
                      <Link className="fw-lib-rowlink" href={groupHref(offer.group.id)}>
                        {offer.group.code}
                      </Link>
                      <span className="nds-summary-sub">{offer.group.name}</span>
                    </span>,
                    say(offer.picks),
                    offer.values.filter((value) => value.status === 'ACTIVE').map((value) => value.code).join(', ') || '—',
                    offer.status === 'ACTIVE' ? tl('status.ACTIVE') : t('style.withdrawn'),
                  ],
                }))}
              />
            )}
            <h3 className="fw-lib-h3">{t('style.lines')}</h3>
            {options.lines.length === 0 ? (
              <p className="fw-lib-hint">{t('style.noLines')}</p>
            ) : (
              <SummaryTable
                label={t('style.lines')}
                columns={[t('style.col.revision'), t('style.col.line'), t('style.col.material'), t('style.col.option')]}
                stackOnPhone
                rows={options.lines.map((line) => ({ id: line.lineId, cells: [revision(line.revision), String(line.seq), `${line.item.code} · ${line.item.name}`, line.option] }))}
              />
            )}
            <h3 className="fw-lib-h3">{t('style.steps')}</h3>
            {options.steps.length === 0 ? (
              <p className="fw-lib-hint">{t('style.noSteps')}</p>
            ) : (
              <SummaryTable
                label={t('style.steps')}
                columns={[t('style.col.revision'), t('style.col.step'), t('style.col.operation'), t('style.col.options')]}
                stackOnPhone
                rows={options.steps.map((step) => ({ id: step.stepId, cells: [revision(step.revision), String(step.seq), `${step.code} · ${step.name}`, step.options.join(', ')] }))}
              />
            )}
          </>
        )}
      </section>
    </Card>
  )
}

/** Archive or restore the chosen groups: what it does (styles keep their offers), one reason for all. */
function MoveDialog({ to, rows, busy, actions, onDone, onClose }: { to: 'archive' | 'restore'; rows: readonly GroupRow[]; busy: boolean; actions?: OptionsActions; onDone: () => void; onClose: () => void }) {
  const t = useT('products-options')
  const tl = useT('library')
  const [reason, setReason] = useState('')
  const chosen = rows.filter((row) => row.status === (to === 'archive' ? 'ACTIVE' : 'ARCHIVED'))
  const offered = chosen.filter((row) => row.styles > 0).length
  const held = chosen.length === 0 ? t(to === 'archive' ? 'held.noneActive' : 'held.noneArchived') : busy ? tl('held.busy') : null
  const go = () => {
    if (held) return
    void actions?.onMove?.(chosen.map((row) => row.id), to, reason.trim()).then((done) => {
      if (done) {
        onDone()
        onClose()
      }
    })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t(to === 'archive' ? 'archive.title' : 'restore.title', { count: chosen.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{tl('common.back')}</Button>
          <Button variant={to === 'archive' ? 'danger' : 'primary'} heldReason={held} onClick={go}>
            {t(to === 'archive' ? 'bulk.archive' : 'bulk.restore', { count: chosen.length })}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          {to === 'archive' ? (
            <>
              <li>{t('archive.reach')}</li>
              {offered > 0 && <li>{t('archive.offered', { count: offered })}</li>}
              <li>{t('archive.back')}</li>
            </>
          ) : (
            <li>{t('restore.reach')}</li>
          )}
        </ul>
        <ul className="fw-lib-list">
          {chosen.map((row) => (
            <li key={row.id}>
              <span className="fw-lib-mono">{row.code}</span> · {row.name}
            </li>
          ))}
        </ul>
        <Field label={tl('dialog.reason')} hint={tl('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
