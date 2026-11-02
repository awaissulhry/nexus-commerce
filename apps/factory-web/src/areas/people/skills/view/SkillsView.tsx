'use client'

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Printer, ShieldCheck, Users } from 'lucide-react'
import { Banner, DetailPopover, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { siteColumn } from '../../../../shell/scope/scope-context'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { KeysModal, LiveLine, NoPeopleAccess, PeoplePrivacyNote, useWords, type SightState } from '../../_shared/parts'
import type { Matrix, MatrixRow, SkillLevel } from '../api'
import {
  authorisationOf,
  cellKey,
  className,
  dialogPerson,
  groupOf,
  isNarrowed,
  levelOf,
  levelOfKey,
  matrixColumns,
  placesOf,
  printAddress,
  rowsShown,
  SHOWS,
  skillName,
  SKILL_TILES,
  SKILLS_NAMESPACES,
  SORTS,
  type CellRef,
  type DialogPerson,
  type MatrixColumn,
  type Show,
  type SkillsAddress,
  type SkillsCan,
  type SkillTile,
  type Sort,
} from '../model'
import { CellPopoverBody, type CellPopoverActions, type CellState } from './CellPopover'
import { LevelMark, MachineMark } from './cells'
import { SkillDialogs, useSkillWords, type SkillDialogsModel } from './SkillDialogs'
import type { SkillDialogActions } from '../use-skill-dialogs'
import '../skills.css'

/** What the page tells: `ns` names the catalogue that owns the words. */
export interface SkillNotice {
  tone: 'success' | 'warning' | 'danger'
  ns: 'skills' | 'people'
  key: string
  params?: Record<string, string | number>
}

export type MatrixState = { status: 'loading' } | { status: 'ready'; value: Matrix } | { status: 'error'; problem: string }

export interface SkillsModel {
  prefix: string
  scope: OfficeScope
  can: SkillsCan
  address: SkillsAddress
  sight: SightState
  matrix: MatrixState
  asOf: string | null
  live: 'connecting' | 'live' | 'offline'
  updates: number
  notice: SkillNotice | null
  cell: CellState | null
  /** Cells waiting for the API (1–4). */
  saving: readonly string[]
  dialogs: SkillDialogsModel
}

export interface SkillsActions extends CellPopoverActions {
  onAddress?: (change: Partial<SkillsAddress>) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
  onCell?: (cell: CellRef | null, title?: string) => void
  onSetLevel?: (row: MatrixRow, skillId: string, level: SkillLevel) => void
  onAuthoriseMany?: (people: DialogPerson[]) => void
  onCatalogue?: () => void
  dialog?: SkillDialogActions
}

interface Cells {
  state: CellState | null
  saving: readonly string[]
  actions?: SkillsActions
}

const CellsContext = createContext<Cells>({ state: null, saving: [] })

/** One matrix cell: the DS popover's button around the mark, opened by Enter or a click, Esc back to the cell. */
function MatrixCell({ cell, title, label, grid, children }: { cell: CellRef; title: string; label: string; grid: ICellRendererParams<MatrixRow>; children: ReactNode }) {
  const { state, saving, actions } = useContext(CellsContext)
  const key = cellKey(cell)
  const open = state !== null && cellKey(state.cell) === key
  return (
    <span className="fw-sk-cell">
      <DetailPopover
        trigger={children}
        triggerLabel={label}
        triggerClassName="fw-sk-cell-button"
        label={title}
        hoverDelay={0}
        open={open}
        onOpenChange={(next) => actions?.onCell?.(next ? cell : null, title)}
        returnFocus={() => {
          if (grid.node.rowIndex !== null) grid.api.setFocusedCell(grid.node.rowIndex, grid.column ?? '')
        }}
      >
        {({ close }) => (open && state ? <CellPopoverBody state={state} actions={actions} onClose={() => close()} /> : null)}
      </DetailPopover>
      {saving.includes(key) && <CellSaveMark state="saving" />}
    </span>
  )
}

export function matrixColumnDefs(columns: readonly MatrixColumn[], words: { t: (key: string, params?: Record<string, string | number>) => string; locale: string }, handlers: { current: { onCell: (cell: CellRef, title: string) => void; onLevel: (row: MatrixRow, skillId: string, level: SkillLevel) => void } }): ColDef<MatrixRow>[] {
  const { t, locale } = words
  return columns.map((column): ColDef<MatrixRow> => {
    if (column.kind === 'skill') {
      const title = skillName(column.skill, locale)
      return {
        colId: `skill.${column.id}`,
        headerName: title,
        headerTooltip: `${t(`kind.${column.skill.kind}`)} · ${column.skill.code}`,
        headerClass: 'fw-sk-head',
        minWidth: 188,
        flex: 1,
        sortable: false,
        valueGetter: (params) => {
          const cell = params.data ? levelOf(params.data, column.id) : null
          return cell ? t(`level.${cell.level}`) : ''
        },
        cellRenderer: (params: ICellRendererParams<MatrixRow>) => {
          const row = params.data
          if (!row) return null
          const cell = levelOf(row, column.id)
          return (
            <MatrixCell cell={{ employeeId: row.employeeId, kind: 'skill', skillId: column.id }} title={title} label={t('cell.open', { name: row.name, what: title })} grid={params}>
              <LevelMark level={cell?.level ?? null} trainee={cell?.trainee ?? 'NONE'} compact />
            </MatrixCell>
          )
        },
        suppressKeyboardEvent: (params) => {
          const event = params.event
          const row = params.data
          if (event.type !== 'keydown' || !row || event.metaKey || event.ctrlKey || event.altKey) return false
          if (event.key === 'Enter') {
            handlers.current.onCell({ employeeId: row.employeeId, kind: 'skill', skillId: column.id }, title)
            return true
          }
          const level = levelOfKey(event.key)
          if (!level) return false
          handlers.current.onLevel(row, column.id, level)
          return true
        },
      }
    }
    const title = className(column.entry, locale)
    return {
      colId: `machine.${column.id}`,
      headerName: title,
      headerTooltip: t('column.machine'),
      headerClass: 'fw-sk-head machine',
      minWidth: 200,
      flex: 1,
      sortable: false,
      valueGetter: (params) => {
        const cell = params.data ? authorisationOf(params.data, column.id) : null
        return cell ? t(`machine.${cell.state}`) : ''
      },
      cellRenderer: (params: ICellRendererParams<MatrixRow>) => {
        const row = params.data
        if (!row) return null
        const cell = authorisationOf(row, column.id)
        return (
          <MatrixCell cell={{ employeeId: row.employeeId, kind: 'machine', classId: column.id }} title={title} label={t('cell.open', { name: row.name, what: title })} grid={params}>
            <MachineMark state={cell?.state ?? null} until={cell?.validUntil ?? null} ending={cell?.ending ?? false} />
          </MatrixCell>
        )
      },
      suppressKeyboardEvent: (params) => {
        const row = params.data
        if (params.event.type !== 'keydown' || params.event.key !== 'Enter' || !row) return false
        handlers.current.onCell({ employeeId: row.employeeId, kind: 'machine', classId: column.id }, title)
        return true
      },
    }
  })
}

/**
 * SCR-160 — People › Skills & training (W2b-1: skills and machine authorisations; the safety training columns come in
 * W2b-2): the privacy note before any person is read, the tiles as saved filters, the matrix on the shared list frame
 * (Show, sort, line, team, search in the address; a cell opens its detail; 1–4 set a level), Authorise a machine for one
 * or many, Sign off a trainee, the A3 print. Rows sort by team or name only and nothing adds people up. One model, nothing
 * fetched.
 */
export function SkillsView({ model, actions }: { model: SkillsModel; actions?: SkillsActions }) {
  return (
    <WithMessages namespaces={SKILLS_NAMESPACES}>
      <Page model={model} {...(actions ? { actions } : {})} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: SkillsModel; actions?: SkillsActions }) {
  const t = useSkillWords()
  const people = useWords()
  const locale = useLocale()
  const scope = model.scope
  const [help, setHelp] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const handlers = useRef({ onCell: (_cell: CellRef, _title: string) => undefined as void, onLevel: (_row: MatrixRow, _skill: string, _level: SkillLevel) => undefined as void })
  handlers.current = { onCell: (cell, title) => actions?.onCell?.(cell, title), onLevel: (row, skill, level) => actions?.onSetLevel?.(row, skill, level) }

  const matrix = model.matrix.status === 'ready' ? model.matrix.value : null
  const address = model.address
  const shown = useMemo(() => (matrix ? rowsShown(matrix.rows, address) : []), [matrix, address])
  const places = useMemo(() => placesOf(matrix?.rows ?? []), [matrix])
  const firsts = useMemo(() => new Set(shown.filter((row, index) => index === 0 || groupOf(row) !== groupOf(shown[index - 1]!)).map((row) => row.employeeId)), [shown])
  const firstsRef = useRef(firsts)
  firstsRef.current = firsts
  const skillColumns = useMemo(() => (matrix ? matrixColumns(matrix, address.show) : []), [matrix, address.show])

  const columns = useMemo<ColDef<MatrixRow>[]>(() => {
    const site = siteColumn<MatrixRow>(scope, (row) => row.siteId, t('list.site'))
    return [
      ...(address.sort === 'TEAM'
        ? [
            {
              colId: 'group',
              headerName: t('list.group'),
              pinned: 'left',
              minWidth: 110,
              maxWidth: 170,
              sortable: false,
              valueGetter: (params) => (params.data ? groupOf(params.data) : ''),
              cellRenderer: (params: ICellRendererParams<MatrixRow>) => (params.data && firstsRef.current.has(params.data.employeeId) ? <b>{groupOf(params.data) || t('list.noGroup')}</b> : null),
            } satisfies ColDef<MatrixRow>,
          ]
        : []),
      {
        colId: 'name',
        headerName: t('list.person'),
        pinned: 'left',
        minWidth: 180,
        sortable: false,
        valueGetter: (params) => params.data?.name ?? '',
        cellRenderer: (params: ICellRendererParams<MatrixRow>) => {
          const row = params.data
          if (!row) return null
          return model.can.employees ? <Link href={`${model.prefix}/people/employees/${encodeURIComponent(row.employeeId)}?tab=skills`}>{row.name}</Link> : row.name
        },
      },
      ...(site ? [site] : []),
      ...matrixColumnDefs(skillColumns, { t, locale }, handlers),
    ]
  }, [scope, t, locale, address.sort, skillColumns, model.can.employees, model.prefix])

  if (!model.can.view) return <NoPeopleAccess permission="people.skills.view" />

  const empty = matrix !== null && shown.length === 0
  const noSkills = matrix !== null && matrix.skills.length === 0 && matrix.machineClasses.length === 0
  const state: ReactNode =
    model.matrix.status === 'error' ? (
      <EmptyState
        title={t('list.failed')}
        description={people(model.matrix.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {people('common.retry')}
          </Button>
        }
      />
    ) : empty && isNarrowed(address) ? (
      <EmptyState
        title={t('list.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onAddress?.({ tile: null, lineId: null, teamId: null, q: '' })}>
            {t('list.clear')}
          </Button>
        }
      />
    ) : empty || noSkills ? (
      <EmptyState
        icon={<Users size={22} aria-hidden />}
        title={t(noSkills ? 'list.emptySkills' : 'list.emptyPeople')}
        description={t('list.emptyHint')}
        action={
          noSkills ? (
            <Button size="sm" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onCatalogue?.()}>
              {t('list.addSkills')}
            </Button>
          ) : (
            <Button size="sm" asChild>
              <Link href={`${model.prefix}/people/employees`}>{t('list.addEmployees')}</Link>
            </Button>
          )
        }
      />
    ) : null

  // Phone: one person per card, what they hold in words; a card opens the person's Skills tab.
  const heldOf = (row: MatrixRow): string =>
    skillColumns
      .flatMap((column) => {
        const name = column.kind === 'skill' ? skillName(column.skill, locale) : className(column.entry, locale)
        const cell = column.kind === 'skill' ? levelOf(row, column.id) : authorisationOf(row, column.id)
        if (!cell) return []
        return [`${name}: ${t('level' in cell ? `level.${cell.level}` : `machine.${cell.state}`)}`]
      })
      .join(' · ')
  const [firstColumn, ...restColumns] = skillColumns
  const cardFields = {
    name: { role: 'title' as const },
    ...(address.sort === 'TEAM' ? { group: { role: 'subtitle' as const, draw: (row: MatrixRow) => groupOf(row) } } : {}),
    ...(firstColumn ? { [`${firstColumn.kind === 'skill' ? 'skill' : 'machine'}.${firstColumn.id}`]: { role: 'field' as const, label: t('list.holds'), draw: (row: MatrixRow) => heldOf(row) || '—' } } : {}),
    ...Object.fromEntries(restColumns.map((column) => [`${column.kind === 'skill' ? 'skill' : 'machine'}.${column.id}`, { role: 'hidden' as const }])),
  }

  const picked = shown.filter((row) => selected.includes(row.employeeId))
  const authorisable = picked.filter((row) => row.canAuthorise)
  const ownKeys: readonly ListKey[] = [
    { keys: ['←', '→', '↑', '↓'], does: t('keys.arrows') },
    { keys: ['Enter'], does: t('keys.enter') },
    { keys: ['1', '2', '3', '4'], does: t('keys.levels') },
  ]

  const onSearch = (q: string) => actions?.onAddress?.({ q })

  return (
    <CellsContext.Provider value={{ state: model.cell, saving: model.saving, ...(actions ? { actions } : {}) }}>
      <div className="fw-pp">
        <div className="fw-pp-head">
          <LiveLine asOf={model.asOf} live={model.live} />
          <span className="fw-pp-actions">
            <Button size="sm" heldReason={model.can.authorise ? (matrix ? null : t('common.loading')) : t('held.noAuthorise')} onClick={() => actions?.onAuthoriseMany?.([])}>
              <ShieldCheck size={14} aria-hidden /> {t('band.authorise')}
            </Button>
            <Menu
              label={<MoreHorizontal size={16} aria-hidden />}
              align="right"
              triggerProps={{ 'aria-label': t('band.more') }}
              items={[
                { id: 'print', label: t('band.print'), href: printAddress(model.prefix, address), target: '_blank' },
                ...(model.can.manage ? [{ id: 'catalogue', label: t('band.catalogue'), onSelect: () => actions?.onCatalogue?.() }] : []),
                { id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) },
              ]}
            />
          </span>
        </div>
        <PeoplePrivacyNote sight={model.sight} text={t('privacy.text')} />
        {model.notice && (
          <Banner
            tone={model.notice.tone}
            title={model.notice.ns === 'skills' ? t(model.notice.key, model.notice.params) : people(model.notice.key, model.notice.params)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {people('common.close')}
              </Button>
            }
          />
        )}
        {matrix && !matrix.complete && <Banner tone="info" title={t('list.cut')} />}

        <MetricStrip
          metrics={SKILL_TILES.map((tile: SkillTile) => ({
            label: t(`tile.${tile}`),
            value: matrix ? String(tile === 'TRAINEES' ? matrix.tiles.trainees : matrix.tiles.authorisationsEnding) : '—',
            hint: tile === 'TRAINEES' && matrix && matrix.tiles.traineesOverdue > 0 ? t('tileHint.overdue', { count: matrix.tiles.traineesOverdue }) : t(`tileHint.${tile}`),
            onClick: () => actions?.onAddress?.({ tile: address.tile === tile ? null : tile }),
            active: address.tile === tile,
          }))}
        />

        <ListFrame<MatrixRow>
          label={t('list.tableLabel')}
          title={t('list.title')}
          rows={matrix ? (state ? [] : shown) : model.matrix.status === 'error' ? [] : null}
          rowId={(row) => row.employeeId}
          columns={columns}
          rowKind="text"
          count={matrix ? t('list.count', { count: shown.length }) : '—'}
          search={<Input key={address.q} type="search" size="sm" aria-label={t('list.search')} placeholder={t('list.search')} defaultValue={address.q} onKeyDown={(event) => event.key === 'Enter' && onSearch(event.currentTarget.value)} onBlur={(event) => event.currentTarget.value !== address.q && onSearch(event.currentTarget.value)} />}
          tools={
            <>
              <SegmentedControl ariaLabel={t('list.show')} value={address.show} onChange={(show) => actions?.onAddress?.({ show: show as Show })} options={SHOWS.map((show) => ({ value: show, label: t(`show.${show}`) }))} size="sm" />
              <SegmentedControl ariaLabel={t('list.sort')} value={address.sort} onChange={(sort) => actions?.onAddress?.({ sort: sort as Sort })} options={SORTS.map((sort) => ({ value: sort, label: t(`sort.${sort}`) }))} size="sm" />
              <Select size="sm" aria-label={t('list.line')} value={address.lineId ?? ''} onChange={(event) => actions?.onAddress?.({ lineId: event.target.value || null })}>
                <option value="">{t('list.allLines')}</option>
                {places.lines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.label}
                  </option>
                ))}
              </Select>
              <Select size="sm" aria-label={t('list.team')} value={address.teamId ?? ''} onChange={(event) => actions?.onAddress?.({ teamId: event.target.value || null })}>
                <option value="">{t('list.allTeams')}</option>
                {places.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.label}
                  </option>
                ))}
              </Select>
              <ScopeSiteChip model={scope} />
            </>
          }
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <>
                <Button size="sm" aria-label={t('list.authoriseCount', { count: authorisable.length })} heldReason={authorisable.length === 0 ? t('held.noAuthorise') : null} onClick={() => actions?.onAuthoriseMany?.(authorisable.map(dialogPerson))}>
                  <ShieldCheck size={13} aria-hidden /> <SelectionLabel>{t('list.authoriseCount', { count: authorisable.length })}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('list.printCount', { count: picked.length })} asChild>
                  <a href={printAddress(model.prefix, address, picked.map((row) => row.employeeId))} target="_blank" rel="noopener noreferrer">
                    <Printer size={13} aria-hidden /> <SelectionLabel>{t('list.printCount', { count: picked.length })}</SelectionLabel>
                  </a>
                </Button>
              </>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          state={state}
          cards={{ fields: cardFields, hrefOf: (row) => (model.can.employees ? `${model.prefix}/people/employees/${encodeURIComponent(row.employeeId)}?tab=skills` : null) }}
        />
        <p className="fw-pp-hint">{t('list.foot')}</p>

        <SkillDialogs model={model.dialogs} {...(actions?.dialog ? { actions: actions.dialog } : {})} />
        {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
      </div>
    </CellsContext.Provider>
  )
}
