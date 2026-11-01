'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus, RotateCcw, Search, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, NumberStepper, Pill, Select, SWATCHES, TagGlyph, Toggle } from '@nexus/ui/primitives'
import { CALL_KINDS, type CallKind } from '@nexus/factory-domain/production/calls/rules'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { FLOOR_RULES_NAMESPACES } from '../model'
import type { HelpCode, OffCode, Route, SiteTeam } from '../w2b-api'
import { freeHelpCodes, kindOfCode, LIMITS, markKey, routeDraftHeld, type Mark, type RouteDraft } from '../w2b-model'
import { cellKeys, SaveMark } from './cells'
import { KeysDialog } from './OffStandardView'

export type RouteDialog = { kind: 'new'; draft: RouteDraft; problem: string | null } | { kind: 'keys' }

/** The ONE view model of Help-call routing (fetches nothing). */
export interface RoutingModel {
  site: { code: string; name: string } | null
  load: { status: 'loading' } | { status: 'ready' } | { status: 'error'; problem: string }
  routes: readonly Route[] | null
  canManage: boolean
  /** The site's active teams (people.view); null: not read (the role does not see people) — the group shows as text. */
  teams: readonly SiteTeam[] | null
  /** The company's active off-standard codes the waiting may book to (production.offstandard.view); null: not read. */
  codes: readonly OffCode[] | null
  /** The help-call reason codes (a new type is one of them); null: not read. */
  helpCodes: readonly HelpCode[] | null
  marks: Readonly<Record<string, Mark>>
  notice: { tone: 'success' | 'danger' | 'info'; key: string; params?: Record<string, string | number> } | null
  busy: boolean
  dialog: RouteDialog | null
  changedElsewhere: boolean
  selected?: readonly string[]
  focusRow?: number
}

export interface RoutingActions {
  onRetry?: () => void
  onReload?: () => void
  onTeam?: (row: Route, teamId: string | null) => void
  onEscalate?: (row: Route, value: unknown) => void
  onWaiting?: (row: Route, codeId: string | null) => void
  onActive?: (row: Route, next: boolean) => void
  onActiveMany?: (ids: readonly string[], active: boolean) => void
  onDialog?: (dialog: RouteDialog | null) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}

const KIND_SWATCH: Readonly<Record<CallKind, string>> = { MACHINE: 'Red', MATERIAL: 'Amber', QUALITY: 'Purple', SUPERVISOR: 'Blue', MAINTENANCE: 'Teal', OTHER: 'Grey' }
const kindColour = (kind: CallKind) => SWATCHES.find((swatch) => swatch.name === KIND_SWATCH[kind])?.hex ?? null
const LEADERS = ''
const NOT_BOOKED = ''

/**
 * Floor rules & codes › Help-call routing (design production.settings fr-calls, MES-144, MES-148): ONE list frame of the
 * site's help-call types — type (its help-call reason's icon, colour and words, its code) · kind · the group called (a team
 * of the site, or the site's team leaders) and how many people it holds · escalate after minutes (kept for the timed
 * escalation of a later wave) · the off-standard code the station's waiting books to · active · calls so far / open —
 * saved per cell with the DS save mark. New type (`c`, a code of the help-call reason list not yet a type here); Switch N
 * off / on. A type keeps its kind. Teams are named, never who is in them. Keys only in the footer's icon.
 */
export function RoutingView({ model, actions }: { model: RoutingModel; actions?: RoutingActions }) {
  return (
    <WithMessages namespaces={FLOOR_RULES_NAMESPACES}>
      <Editor model={model} actions={actions} />
    </WithMessages>
  )
}

function Editor({ model, actions }: { model: RoutingModel; actions?: RoutingActions }) {
  const t = useT('floor-rules')
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const all = model.routes
  const words = (row: Pick<Route, 'code' | 'labelIt' | 'labelEn' | 'labelI18n'>) => (locale === 'it' ? row.labelIt : locale === 'en' ? row.labelEn : (row.labelI18n[locale] ?? row.labelEn)) || row.code
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!all || !needle) return all
    return all.filter((row) => [row.code, row.labelIt, row.labelEn, row.responder.team?.name ?? ''].some((text) => text.toLowerCase().includes(needle)))
  }, [all, query])
  const picked = (all ?? []).filter((row) => selected.includes(row.id))
  const free = freeHelpCodes(model.helpCodes ?? [], all ?? [])
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const newDialog = (): RouteDialog => {
    const first = free[0]
    return { kind: 'new', draft: { code: first?.code ?? '', kind: first ? kindOfCode(first.code) : 'OTHER', teamId: '', escalate: '' }, problem: null }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || latest.current.model.dialog) return
      if (target?.closest?.('input, textarea, select, [role="dialog"], [role="menu"], .ag-cell-inline-editing')) return
      if (event.key === 'c' && latest.current.model.canManage && latest.current.model.load.status === 'ready') {
        event.preventDefault()
        latest.current.actions?.onDialog?.(newDialog())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const marksKey = JSON.stringify(model.marks)
  const teamsKey = (model.teams ?? []).map((team) => team.id).join(',')
  const codesKey = (model.codes ?? []).map((code) => `${code.id}:${code.active}`).join(',')
  const columns = useMemo<ColDef<Route>[]>(() => {
    const can = model.canManage
    const mark = (id: string, field: string) => latest.current.model.marks[markKey(id, field)]
    const TypeCell = ({ data }: ICellRendererParams<Route>) =>
      data ? (
        <span className="fw-fr-cell">
          <TagGlyph icon={data.icon} color={data.colour ?? kindColour(data.kind)} size={16} />
          <span className="fw-fr-cell-col">
            <span className={data.active ? 'fw-fr-ellipsis' : 'fw-fr-ellipsis fw-fr-sub'}>{words(data)}</span>
            <span className="fw-fr-sub fw-fr-code">{data.code}</span>
          </span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<Route>) => (data ? <span title={t('fr.route.kindFixed')}>{t(`fr.route.kind.${data.kind}`)}</span> : null)
    const GroupCell = ({ data }: ICellRendererParams<Route>) => {
      if (!data) return null
      const teams = latest.current.model.teams
      const current = data.responder.team?.id ?? LEADERS
      return (
        <span className="fw-fr-cell">
          {can && teams ? (
            <Select size="sm" aria-label={t('fr.route.groupFor', { type: words(data) })} value={current} onChange={(event) => latest.current.actions?.onTeam?.(data, event.target.value || null)}>
              <option value={LEADERS}>{t('fr.route.leaders')}</option>
              {data.responder.team && !teams.some((team) => team.id === data.responder.team!.id) && <option value={data.responder.team.id}>{t('fr.route.archivedTeam', { name: data.responder.team.name })}</option>}
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.line ? t('fr.route.teamOption', { name: team.name, line: team.line.code }) : team.name}
                </option>
              ))}
            </Select>
          ) : (
            <span className="fw-fr-ellipsis" title={can && !teams ? t('fr.route.noPeople') : undefined}>
              {data.responder.team ? data.responder.team.name : t('fr.route.leaders')}
            </span>
          )}
          {data.responder.team && !data.responder.team.active && <Pill tone="warning">{t('fr.route.archived')}</Pill>}
          <SaveMark mark={mark(data.id, 'team')} />
        </span>
      )
    }
    const MembersCell = ({ data }: ICellRendererParams<Route>) => (data ? <span className="fw-fr-num">{t('fr.route.members', { count: data.responder.members })}</span> : null)
    const EscalateCell = ({ data }: ICellRendererParams<Route>) =>
      data ? (
        <span className="fw-fr-cell">
          <span className="fw-fr-num">{data.escalateAfterMinutes === null ? t('fr.route.never') : t('fr.route.minutes', { count: data.escalateAfterMinutes })}</span>
          <SaveMark mark={mark(data.id, 'escalate')} />
        </span>
      ) : null
    const WaitingCell = ({ data }: ICellRendererParams<Route>) => {
      if (!data) return null
      const codes = latest.current.model.codes
      const current = data.waitingCode?.id ?? NOT_BOOKED
      const label = (code: { code: string; labelIt: string; labelEn: string }) => `${code.code} · ${locale === 'it' ? code.labelIt : code.labelEn}`
      return (
        <span className="fw-fr-cell">
          {can && codes ? (
            <Select size="sm" aria-label={t('fr.route.waitingFor', { type: words(data) })} value={current} onChange={(event) => latest.current.actions?.onWaiting?.(data, event.target.value || null)}>
              <option value={NOT_BOOKED}>{t('fr.route.notBooked')}</option>
              {data.waitingCode && !codes.some((code) => code.id === data.waitingCode!.id) && <option value={data.waitingCode.id}>{label(data.waitingCode)}</option>}
              {codes.map((code) => (
                <option key={code.id} value={code.id}>
                  {label(code)}
                </option>
              ))}
            </Select>
          ) : (
            <span className="fw-fr-ellipsis">{data.waitingCode ? label(data.waitingCode) : t('fr.route.notBooked')}</span>
          )}
          <SaveMark mark={mark(data.id, 'waiting')} />
        </span>
      )
    }
    const ActiveCell = ({ data }: ICellRendererParams<Route>) =>
      data ? (
        <span className="fw-fr-cell">
          {can ? <Toggle size="xs" checked={data.active} aria-label={t('fr.route.activeFor', { type: words(data) })} onChange={(next) => latest.current.actions?.onActive?.(data, next)} /> : null}
          {data.active ? <span>{t('fr.route.on')}</span> : <Pill tone="neutral">{t('fr.route.off')}</Pill>}
          <SaveMark mark={mark(data.id, 'active')} />
        </span>
      ) : null
    const UsedCell = ({ data }: ICellRendererParams<Route>) => (data ? <span className="fw-fr-num">{t('fr.route.used', { count: data.usedCount, open: data.openCount })}</span> : null)
    return [
      { colId: 'type', headerName: t('fr.route.col.type'), minWidth: 190, flex: 1.3, cellRenderer: TypeCell, valueGetter: (params) => (params.data ? words(params.data) : ''), suppressKeyboardEvent: cellKeys() },
      { colId: 'kind', headerName: t('fr.route.col.kind'), field: 'kind', minWidth: 110, flex: 0.6, cellRenderer: KindCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'group', headerName: t('fr.route.col.group'), minWidth: 210, flex: 1.3, cellRenderer: GroupCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'members', headerName: t('fr.route.col.members'), minWidth: 100, flex: 0.5, type: 'rightAligned', cellRenderer: MembersCell, valueGetter: (params) => params.data?.responder.members ?? 0, suppressKeyboardEvent: cellKeys() },
      {
        colId: 'escalate',
        headerName: t('fr.route.col.escalate'),
        minWidth: 140,
        flex: 0.7,
        valueGetter: (params) => (params.data?.escalateAfterMinutes ?? '') as never,
        ...(can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 4 } } : {}),
        cellRenderer: EscalateCell,
        suppressKeyboardEvent: cellKeys(),
        valueSetter: (params) => {
          if (params.data) latest.current.actions?.onEscalate?.(params.data, params.newValue)
          return false
        },
      },
      { colId: 'waiting', headerName: t('fr.route.col.waiting'), minWidth: 220, flex: 1.3, cellRenderer: WaitingCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'active', headerName: t('fr.route.col.active'), field: 'active', minWidth: 120, flex: 0.6, cellRenderer: ActiveCell, suppressKeyboardEvent: can ? (params) => cellKeys(() => params.data && latest.current.actions?.onActive?.(params.data, !params.data.active))(params) : cellKeys() },
      { colId: 'used', headerName: t('fr.route.col.used'), minWidth: 130, flex: 0.7, cellRenderer: UsedCell, valueGetter: (params) => params.data?.usedCount ?? 0, suppressKeyboardEvent: cellKeys() },
    ]
  }, [t, locale, model.canManage, marksKey, teamsKey, codesKey, model.teams === null, model.codes === null])

  const ready = model.load.status === 'ready' && all !== null
  const ownKeys: ListKey[] = model.canManage
    ? [
        { keys: ['c'], does: t('fr.route.keyNew') },
        { keys: ['↵'], does: t('fr.cells.keyEdit') },
        { keys: ['Esc'], does: t('fr.cells.keyCancel') },
      ]
    : []
  let state: ReactNode = undefined
  if (!model.site) state = <EmptyState title={t('fr.route.noSite')} />
  else if (model.load.status === 'error')
    state = <EmptyState icon={<XCircle size={20} aria-hidden />} title={t('fr.cells.failed')} description={t(model.load.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('fr.retry')}</Button>} />
  else if (ready && all.length === 0)
    state = (
      <EmptyState
        title={t('fr.route.empty.title')}
        description={t(model.canManage ? 'fr.route.empty.body' : 'fr.route.empty.bodyView')}
        action={
          model.canManage ? (
            <Button size="sm" variant="primary" heldReason={free.length === 0 ? t('fr.route.held.noCodes') : null} onClick={() => actions?.onDialog?.(newDialog())}>
              <Plus size={14} aria-hidden /> {t('fr.route.new.first')}
            </Button>
          ) : undefined
        }
      />
    )
  else if (ready && rows && rows.length === 0) state = <EmptyState title={t('fr.cells.noMatch')} action={<Button size="sm" onClick={() => setQuery('')}>{t('fr.cells.clearSearch')}</Button>} />

  const newHeld = !ready ? 'fr.cells.loading' : !model.canManage ? 'fr.route.held.manage' : model.helpCodes === null ? 'fr.cells.loading' : free.length === 0 ? 'fr.route.held.noCodes' : null
  const offHeld = picked.length === 0 ? 'fr.cells.pickRows' : picked.every((row) => !row.active) ? 'fr.cells.allOff' : model.busy ? 'fr.busy' : null
  const onHeld = picked.length === 0 ? 'fr.cells.pickRows' : picked.every((row) => row.active) ? 'fr.cells.allOn' : model.busy ? 'fr.busy' : null

  return (
    <section className="fw-fr-stack" aria-label={t('fr.route.title')}>
      <div className="fw-fr-section">
        <h2 className="fw-fr-title">{model.site ? t('fr.route.titleAt', { site: model.site.code }) : t('fr.route.title')}</h2>
        <p className="fw-fr-sub">{t('fr.route.intro')}</p>
      </div>
      {model.changedElsewhere && (
        <Banner tone="info" title={t('fr.elsewhere.title')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('fr.elsewhere.reload')}</Button>}>
          {t('fr.cells.elsewhere')}
        </Banner>
      )}
      {model.notice && (
        <Banner tone={model.notice.tone} onDismiss={actions?.onDismissNotice}>
          {t(model.notice.key, model.notice.params)}
        </Banner>
      )}
      {ready && !model.canManage && (
        <Banner tone="neutral" title={t('fr.route.readOnly.title')}>
          {t('fr.route.readOnly.body')}
        </Banner>
      )}
      {ready && model.canManage && model.teams === null && <Banner tone="info">{t('fr.route.noPeople')}</Banner>}
      <ListFrame<Route>
        label={t('fr.route.table')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={all ? t('fr.cells.countTypes', { active: all.filter((row) => row.active).length, inactive: all.filter((row) => !row.active).length }) : '—'}
        search={<Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('fr.cells.search')} placeholder={t('fr.cells.search')} value={query} onChange={(event) => setQuery(event.target.value)} />}
        right={
          <Button size="sm" variant="primary" heldReason={newHeld ? t(newHeld) : null} onClick={() => actions?.onDialog?.(newDialog())} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('fr.route.new.button')}
          </Button>
        }
        selection={
          model.canManage && ready
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" variant="danger-outline" aria-label={t('fr.route.bulkOff', { count: picked.length })} heldReason={offHeld ? t(offHeld) : null} onClick={() => actions?.onActiveMany?.(selected, false)}>
                      <XCircle size={13} aria-hidden /> <SelectionLabel>{t('fr.route.bulkOff', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('fr.route.bulkOn', { count: picked.length })} heldReason={onHeld ? t(onHeld) : null} onClick={() => actions?.onActiveMany?.(selected, true)}>
                      <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('fr.route.bulkOn', { count: picked.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        keys={ownKeys}
        onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
        state={state}
        focusRow={model.focusRow}
        listKey={null}
      />
      <p className="fw-fr-sub">{t('fr.route.hint')}</p>
      {model.dialog?.kind === 'new' && <NewTypeDialog model={model} dialog={model.dialog} free={free} actions={actions} />}
      {model.dialog?.kind === 'keys' && <KeysDialog own={ownKeys} withSelection={model.canManage} onClose={() => actions?.onDialog?.(null)} />}
    </section>
  )
}

function NewTypeDialog({ model, dialog, free, actions }: { model: RoutingModel; dialog: { draft: RouteDraft; problem: string | null }; free: readonly HelpCode[]; actions?: RoutingActions }) {
  const t = useT('floor-rules')
  const ds = useDsLabels()
  const locale = useLocale()
  const draft = dialog.draft
  const set = (patch: Partial<RouteDraft>) => actions?.onDialog?.({ kind: 'new', draft: { ...draft, ...patch }, problem: null })
  const held = routeDraftHeld(draft, free, model.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('fr.route.new.title')}
      size="lg"
      labels={ds.modal}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('fr.cells.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCreate?.()}>
            {t('fr.route.new.add')}
          </Button>
        </>
      }
    >
      <div className="fw-fr-section">
        <p className="fw-fr-sub">{t('fr.route.new.intro')}</p>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <div className="fw-fr-form-grid">
          <Field label={t('fr.route.new.code')} required hint={t('fr.route.new.codeHint')}>
            <Select value={draft.code} onChange={(event) => set({ code: event.target.value, kind: kindOfCode(event.target.value) })}>
              <option value="" disabled>
                {t('fr.route.new.pickCode')}
              </option>
              {free.map((code) => (
                <option key={code.id} value={code.code}>
                  {`${code.code} · ${locale === 'it' ? code.labelIt : code.labelEn}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('fr.route.col.kind')} required hint={t('fr.route.new.kindHint')}>
            <Select value={draft.kind} onChange={(event) => set({ kind: event.target.value as CallKind })}>
              {CALL_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`fr.route.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('fr.route.col.group')} hint={model.teams ? t('fr.route.new.groupHint') : t('fr.route.noPeople')}>
            <Select value={draft.teamId} disabled={!model.teams} onChange={(event) => set({ teamId: event.target.value })}>
              <option value="">{t('fr.route.leaders')}</option>
              {(model.teams ?? []).map((team) => (
                <option key={team.id} value={team.id}>
                  {team.line ? t('fr.route.teamOption', { name: team.name, line: team.line.code }) : team.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('fr.route.col.escalate')} hint={t('fr.route.new.escalateHint', { min: LIMITS.escalate.min, max: LIMITS.escalate.max })}>
            <NumberStepper value={draft.escalate} min={LIMITS.escalate.min} max={LIMITS.escalate.max} size="sm" suffix={t('fr.route.minutesSuffix')} decrementLabel={t('fr.route.less')} incrementLabel={t('fr.route.more')} onChange={(next) => set({ escalate: next })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
