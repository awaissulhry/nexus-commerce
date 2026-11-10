'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { BookOpen, CheckCheck, ExternalLink, Plus } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { Change, Entry } from '../api'
import { CHANGE_TONE, ENTRY_TONE, markKey, REGULATION_KINDS, REGULATION_STATUSES, TRANSITION_TONE, valueOf, type EntryCell, type Mark } from '../model'
import type { RegsState, RulesMarketsActions, RulesMarketsModel } from '../view-model'
import { ChangeWindow, EntryWindow, NewEntryDialog } from './RegsDialogs'
import { PAGE_KEYS, SaveMark, SectionFailed, SectionHead, SectionLoading, useDay, useWords } from './parts'

/** A text cell that edits in the grid (autosave per cell at the row's version): any printable key starts editing. */
const typing = () => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key.length === 1 && event.key !== ' '
}

/**
 * Regulations & standards (design rm-regs; PRD-273, PRD-274; B-W2b-249's register and watch): the laws and standards in use —
 * the law or standard and its edition, the Official Journal citation, the status (in force, superseded by, withdrawn), the link
 * and how many registered certificates cite it — autosaved per cell (title, citation, link) at the row's version; New entry; the
 * entry's window (the certificates citing it, Mark superseded or withdrawn — which raises a change —, Record a change, Delete a
 * row typed by mistake). Below, the change watch: each change with its transition, the certificates and styles it touches,
 * Assess (impact; REVIEW or RETEST opens the type-change review per certificate named), Open impact task and Close.
 */
export function RegsTab({ model, state, actions, onHelp }: { model: RulesMarketsModel; state: RegsState | undefined; actions?: RulesMarketsActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const day = useDay()
  const locale = useLocale()
  const { address } = model
  const answer = state ? valueOf(state.entries) : null
  const canManage = model.can.rulesManage && (answer?.mayManage ?? true)
  const offline = model.live === 'offline'
  const latest = useRef({ marks: state?.marks ?? {}, actions })
  latest.current = { marks: state?.marks ?? {}, actions }

  const columns = useMemo<ColDef<Entry>[]>(() => {
    const mark = (id: string, field: string): Mark | undefined => latest.current.marks[markKey(id, field)]
    const text = (field: EntryCell, header: string, flex: number, render?: (row: Entry) => ReactNode): ColDef<Entry> => ({
      colId: field,
      headerName: header,
      minWidth: 150,
      flex,
      wrapText: true,
      autoHeight: true,
      valueGetter: (params) => (params.data ? (params.data[field] ?? '') : ''),
      ...(canManage && !offline ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: field === 'link' ? 2000 : 300 } } : {}),
      suppressKeyboardEvent: typing(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.regs?.onCell?.(params.data.id, field, String(params.newValue ?? ''))
        return false
      },
      cellRenderer: ({ data }: ICellRendererParams<Entry>) =>
        data ? (
          <span className="fw-rm-cell-row">
            {render ? render(data) : <span className={data[field] ? undefined : 'fw-rm-muted'}>{data[field] || '—'}</span>}
            <SaveMark mark={mark(data.id, field)} />
          </span>
        ) : null,
    })
    const LawCell = ({ data }: ICellRendererParams<Entry>) =>
      data ? (
        <span className="fw-rm-cell">
          <span className="fw-rm-code">{data.label}</span>
          <span className="fw-rm-muted">{t(`regKind.${data.kind}`)}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<Entry>) =>
      data ? (
        <span className="fw-rm-cell">
          <Pill tone={ENTRY_TONE[data.status]} dot>
            {t(`regStatus.${data.status}`)}
          </Pill>
          {data.supersededBy ? <span className="fw-rm-muted">{t('regs.supersededBy', { label: data.supersededBy.label })}</span> : null}
        </span>
      ) : null
    return [
      { colId: 'label', headerName: t('regs.col.law'), minWidth: 170, flex: 1.1, valueGetter: (params) => params.data?.label ?? '', cellRenderer: LawCell, autoHeight: true },
      text('title', t('regs.col.title'), 2),
      text('ojReference', t('regs.col.oj'), 1.3, (row) => (
        <span className="fw-rm-cell">
          <span className={row.ojReference ? undefined : 'fw-rm-muted'}>{row.ojReference ?? t('regs.notCited')}</span>
          {row.ojDate ? <span className="fw-rm-muted">{day(row.ojDate)}</span> : null}
        </span>
      )),
      { colId: 'status', headerName: t('regs.col.status'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? t(`regStatus.${params.data.status}`) : ''), cellRenderer: StatusCell, autoHeight: true },
      text('link', t('regs.col.link'), 0.9, (row) =>
        row.link ? (
          <a className="fw-rm-link" href={row.link} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={12} aria-hidden /> {t('regs.open')}
          </a>
        ) : (
          <span className="fw-rm-muted">—</span>
        ),
      ),
      { colId: 'usedBy', headerName: t('regs.col.usedBy'), minWidth: 130, flex: 0.8, valueGetter: (params) => params.data?.usedBy ?? 0, cellRenderer: ({ data }: ICellRendererParams<Entry>) => (data ? <span className={data.usedBy === 0 ? 'fw-rm-muted' : undefined}>{t('regs.certificates', { count: data.usedBy })}</span> : null) },
      {
        colId: 'openChanges',
        headerName: t('regs.col.changes'),
        minWidth: 130,
        flex: 0.8,
        valueGetter: (params) => params.data?.openChanges ?? 0,
        cellRenderer: ({ data }: ICellRendererParams<Entry>) => (data ? data.openChanges > 0 ? <Pill tone="warning">{t('regs.openChanges', { count: data.openChanges })}</Pill> : <span className="fw-rm-muted">{t('regs.noChanges')}</span> : null),
      },
    ]
  }, [t, day, canManage, offline, locale])

  const search = <Input size="sm" type="search" value={address.q} placeholder={t('regs.search')} aria-label={t('regs.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
  const filters = (
    <span className="fw-rm-row">
      <Select size="sm" value={address.kind ?? ''} aria-label={t('regs.filterKind')} onChange={(event) => actions?.onAddress?.({ kind: event.target.value || null })}>
        <option value="">{t('regs.allKinds')}</option>
        {REGULATION_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`regKind.${kind}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.status ?? ''} aria-label={t('regs.filterStatus')} onChange={(event) => actions?.onAddress?.({ status: (event.target.value || null) as never })}>
        <option value="">{t('regs.allStatuses')}</option>
        {REGULATION_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`regStatus.${status}`)}
          </option>
        ))}
      </Select>
    </span>
  )
  const addHeld = canManage ? (offline ? t('held.offline') : null) : t('held.rulesManage')
  const filtered = !!(address.q || address.kind || address.status)

  return (
    <>
      <section className="fw-rm-section" aria-labelledby="fw-rm-regs">
        <SectionHead id="fw-rm-regs" title={t('regs.title')} note={t('regs.note')}>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('regs.add')}
          </Button>
        </SectionHead>
        {!state || state.entries.status === 'loading' ? (
          <SectionLoading rows={6} />
        ) : state.entries.status === 'error' ? (
          <SectionFailed title={t('regs.failed')} problem={state.entries.problem} onRetry={actions?.regs?.onRetry} />
        ) : (
          <ListFrame<Entry>
            label={t('regs.title')}
            title={t('regs.title')}
            listKey="compliance.settings.regulations"
            rows={state.entries.value.entries}
            rowId={(row) => row.id}
            columns={columns}
            count={t('regs.count', { count: state.entries.value.entries.length })}
            search={search}
            tools={filters}
            keys={PAGE_KEYS(t)}
            onHelp={onHelp}
            onOpen={(row) => actions?.onAddress?.({ open: row.id })}
            state={
              state.entries.value.entries.length === 0 ? (
                filtered ? (
                  <EmptyState
                    icon={<BookOpen size={22} aria-hidden />}
                    title={t('regs.noneFiltered')}
                    action={
                      <Button size="sm" onClick={() => actions?.onAddress?.({ q: '', kind: null, status: null })}>
                        {t('common.clearFilters')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState icon={<BookOpen size={22} aria-hidden />} title={t('regs.emptyTitle')} description={t('regs.empty')} />
                )
              ) : undefined
            }
            cards={{ fields: { label: { role: 'title' }, title: { role: 'subtitle' }, status: { role: 'aside' } } }}
          />
        )}
      </section>
      <WatchSection model={model} state={state} actions={actions} onHelp={onHelp} />
      {state?.add && <NewEntryDialog state={state} actions={actions} />}
      {state?.entry && <EntryWindow model={model} state={state} actions={actions} />}
      {state?.change && <ChangeWindow model={model} state={state} actions={actions} />}
    </>
  )
}

/** The change watch (design: "when a standard used by a certificate is revised or withdrawn, an impact task lists the affected styles"). */
function WatchSection({ model, state, actions, onHelp }: { model: RulesMarketsModel; state: RegsState | undefined; actions?: RulesMarketsActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const day = useDay()
  const selected = state?.selected ?? []
  const rows = state ? valueOf(state.changes) : null
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.regs?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])
  const closable = (rows ?? []).filter((row) => selected.includes(row.id) && row.status === 'ASSESSED')
  const canManage = model.can.rulesManage

  const columns = useMemo<ColDef<Change>[]>(
    () => [
      {
        colId: 'standard',
        headerName: t('watch.col.standard'),
        minWidth: 190,
        flex: 1.3,
        valueGetter: (params) => params.data?.standard.label ?? '',
        autoHeight: true,
        cellRenderer: ({ data }: ICellRendererParams<Change>) =>
          data ? (
            <span className="fw-rm-cell">
              <span className="fw-rm-code">{data.newStandard ? t('watch.toNew', { from: data.standard.label, to: data.newStandard.label }) : data.standard.label}</span>
              <span className="fw-rm-muted">{t(`changeKind.${data.kind}`)}</span>
            </span>
          ) : null,
      },
      { colId: 'whatChanged', headerName: t('watch.col.what'), minWidth: 220, flex: 2, valueGetter: (params) => params.data?.whatChanged ?? '', wrapText: true, autoHeight: true },
      {
        colId: 'transition',
        headerName: t('watch.col.transition'),
        minWidth: 160,
        flex: 1,
        valueGetter: (params) => params.data?.transitionEndsOn ?? '',
        cellRenderer: ({ data }: ICellRendererParams<Change>) =>
          data ? (
            data.transition === 'NONE' ? (
              <span className="fw-rm-muted">{t('watch.noTransition')}</span>
            ) : (
              <Pill tone={TRANSITION_TONE[data.transition]}>{t(`transition.${data.transition}`, { date: day(data.transitionEndsOn) })}</Pill>
            )
          ) : null,
      },
      {
        colId: 'status',
        headerName: t('watch.col.status'),
        minWidth: 150,
        flex: 1,
        valueGetter: (params) => (params.data ? t(`changeStatus.${params.data.status}`) : ''),
        autoHeight: true,
        cellRenderer: ({ data }: ICellRendererParams<Change>) =>
          data ? (
            <span className="fw-rm-cell">
              <Pill tone={CHANGE_TONE[data.status]} dot>
                {t(`changeStatus.${data.status}`)}
              </Pill>
              {data.impact ? <span className="fw-rm-muted">{t(`impact.${data.impact}`)}</span> : null}
            </span>
          ) : null,
      },
      { colId: 'certificates', headerName: t('watch.col.certificates'), minWidth: 120, flex: 0.7, valueGetter: (params) => (params.data ? t('regs.certificates', { count: params.data.certificates.length }) : '') },
      { colId: 'styles', headerName: t('watch.col.styles'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? t('watch.styles', { count: params.data.styles.length }) : '') },
      { colId: 'task', headerName: t('watch.col.task'), minWidth: 140, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.task ? params.data.task.title : t('watch.noTask')) : '') },
    ],
    [t, day],
  )

  return (
    <section className="fw-rm-section" aria-labelledby="fw-rm-watch">
      <SectionHead id="fw-rm-watch" title={t('watch.title')} note={t('watch.note')}>
        <SegmentedControl
          size="sm"
          ariaLabel={t('watch.rows')}
          value={model.address.watch}
          onChange={(value) => actions?.onAddress?.({ watch: value as 'open' | 'all' })}
          options={[
            { value: 'open', label: t('watch.open') },
            { value: 'all', label: t('watch.all') },
          ]}
        />
      </SectionHead>
      {!state || state.changes.status === 'loading' ? (
        <SectionLoading rows={4} />
      ) : state.changes.status === 'error' ? (
        <SectionFailed title={t('watch.failed')} problem={state.changes.problem} onRetry={actions?.regs?.onRetry} />
      ) : (
        <ListFrame<Change>
          label={t('watch.title')}
          title={t('watch.title')}
          listKey="compliance.settings.watch"
          rows={state.changes.value}
          rowId={(row) => row.id}
          columns={columns}
          count={t('watch.count', { count: state.changes.value.length })}
          selection={
            canManage
              ? {
                  selected,
                  onChange: (ids) => actions?.regs?.onSelected?.(ids),
                  actions: (
                    <Button size="sm" variant="primary" aria-label={t('watch.closeMany', { count: closable.length })} heldReason={closable.length === 0 ? t('held.noneAssessed') : null} onClick={() => actions?.regs?.onCloseMany?.(closable.map((row) => row.id))}>
                      <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('watch.closeMany', { count: closable.length })}</SelectionLabel>
                    </Button>
                  ),
                }
              : undefined
          }
          isRowSelectable={canManage ? (row) => (row.status === 'CLOSED' ? t('held.closed') : null) : undefined}
          keys={PAGE_KEYS(t)}
          onHelp={onHelp}
          onOpen={(row) => actions?.onAddress?.({ change: row.id })}
          state={state.changes.value.length === 0 ? <EmptyState title={model.address.watch === 'open' ? t('watch.emptyOpen') : t('watch.empty')} description={t('watch.emptyHint')} /> : undefined}
          cards={{ fields: { standard: { role: 'title' }, whatChanged: { role: 'subtitle' }, status: { role: 'aside' } } }}
        />
      )}
    </section>
  )
}
