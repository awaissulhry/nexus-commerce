'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { CalendarClock, ClipboardCheck, Download, FileText, Hand, MoreHorizontal, Printer, Settings2, UserCheck, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { CR_VI_TONE, LOT_TONE, type Lot } from '../../_shared/lots'
import { countText, type Read } from '../../_shared/model'
import { dash, Freshness, NoAccess, NoticeBanner, PageHead, StepUpDialog } from '../../_shared/parts'
import type { StepUpState } from '../../_shared/hooks'
import type { InspectionRow, Release } from '../api'
// B-W2b-127: incoming and in-line rows in the one list, the kind chips, the report verbs and Print N reports.
import { finalRowsOf, KINDS, kindChipHeld, lotOf, numberOf, otherStatusOf, planOf, printHeld, reportAddress, reportHeld, rowHref, sampleOf, subjectOf, unionRows, viewJoins, type Kind, type ListRow } from '../depth/model'
import { DepthMessages, KindTag, useDepthT, useSay } from '../depth/parts'
import { AssignDialog } from './AssignDialog'
import { DueDialog } from './DueDialog'
import {
  assignedWords,
  assignHeld,
  assigneeValue,
  assignRowHeld,
  dueBulkHeld,
  dueRowHeld,
  dueState,
  fromLocalInput,
  holdOf,
  lastReversal,
  kindHeld,
  MAX,
  NEW_DRAFT,
  NEW_KINDS,
  RETURN_DRAFT,
  releaseLabel,
  reversedOf,
  statusOf,
  TILES,
  toLocalInput,
  VIEWS,
  viewKind,
  whoKey,
  type InspectionsListModel,
  type ListDialog,
  type CellMark,
  type NewDraft,
  type ReturnDraft,
  type ReverseDraft,
  type RuleDraft,
  type View,
} from '../model'
import { NewInspectionModal, ReverseModal, RulesModal, ShortcutsModal } from './dialogs'
import { ReleaseDetailModal } from './ReleaseDetailModal'
import '../inspections.css'

export interface InspectionsListActions {
  onView?: (view: View) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onDialog?: (dialog: ListDialog | null) => void
  onOpenInspection?: (row: InspectionRow) => void
  onOpenRelease?: (releaseId: string | null) => void
  onOpenLot?: (lot: Lot) => void
  onRetryRelease?: () => void
  onExport?: (kind: 'inspections' | 'releases' | 'lots', ids: readonly string[]) => void
  /** B-W2b-127: the kind chips (`?kind=`), Print N reports (a new tab), a part of the list read again. */
  onKind?: (kind: 'all' | Kind) => void
  onPrintReports?: (ids: readonly string[]) => void
  onRetryPart?: (part: 'incoming' | 'inline') => void
  onOpenEntry?: (entry: ListRow) => void
  onNewDraft?: (draft: NewDraft) => void
  onPickWorkOrder?: (workOrderId: string) => void
  onCreate?: () => void
  onRuleDraft?: (draft: RuleDraft) => void
  onFindCustomers?: (q: string) => void
  onSaveRule?: () => void
  onReverseDraft?: (draft: ReverseDraft) => void
  onReverse?: () => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  // W2a (B-W2a-67): Assign inspector (dialog, inline cell), Place hold, Create NCR, New inspection › Return.
  onAssign?: (rows: readonly InspectionRow[]) => void
  onAssignValue?: (value: string) => void
  onAssignSave?: () => void
  onAssignClose?: () => void
  onNeedPeople?: (siteId: string, workOrderIds: readonly string[]) => void
  onAssignCell?: (row: InspectionRow, value: string) => void
  onPlaceHold?: (row: InspectionRow) => void
  onRaiseNcr?: (row: InspectionRow) => void
  onPickReturn?: (returnId: string) => void
  onReturnDraft?: (draft: ReturnDraft) => void
  onGradeReturn?: () => void
  // B-W2b-17: by when inspections are due — Set due date for the selection (its dialog), the inline Due cell.
  onDue?: (rows: readonly InspectionRow[]) => void
  onDueValue?: (value: string) => void
  onDueSave?: () => void
  onDueClose?: () => void
  onDueCell?: (row: InspectionRow, dueAt: string | null) => void
}

/** The inline cell's mark: the DS CellSaveMark while saving or unknown, "!" with the refusal's words; nothing once saved. */
function Mark({ mark }: { mark: CellMark | undefined }) {
  const t = useT('quality')
  if (!mark || mark.state === 'saved') return null
  if (mark.state === 'refused') {
    const words = [t(mark.problem), ...(mark.lines ?? [])].join(' ')
    return (
      <span className="fw-q-refused" role="img" aria-label={words} title={words}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

/**
 * SCR-075 Inspections (design quality.inspections, 00 §2.1; Owner answer Q3: what is on hold is reached from here before
 * the Holds page of W2a): the head (one sentence, Updated · Live, Quality rules, New inspection), the release rule in force
 * said at rest, the tiles (each a named view: Open, Waiting for release, On hold, Reversed releases, Lots on hold), then
 * the ONE list frame (src/list-frame) with the view's rows — inspections, the reversed releases, or the lots on hold —
 * select-all, shift range, x, Export N while rows are selected, Show more, the keys in the footer icon. A release opens in
 * its DetailModal (`?open=`); "Reverse…" shows the impact first. Fetches nothing: InspectionsPage.tsx reads and writes.
 */
export function InspectionsView({ model, actions, stepUp }: { model: InspectionsListModel; actions?: InspectionsListActions; stepUp?: StepUpState }) {
  return (
    <DepthMessages>
      <Inspections model={model} actions={actions} stepUp={stepUp} />
    </DepthMessages>
  )
}

function Inspections({ model, actions, stepUp }: { model: InspectionsListModel; actions?: InspectionsListActions; stepUp?: StepUpState }) {
  const t = useT('quality')
  const td = useDepthT()
  const say = useSay()
  const lists = useT('lists')
  const locale = useLocale()
  const can = model.can
  const depth = model.depth
  const dialog = model.dialog ?? null
  const kind = viewKind(model.view)
  const kindFilter = model.kind ?? 'all'
  const sees = { inspectionsView: can.inspectionsView, incomingView: depth?.incomingView ?? false, inprocessView: depth?.inprocessView ?? false }
  const open = (next: ListDialog | null) => actions?.onDialog?.(next)
  // W2a: New inspection has kinds (a final one, an incoming lot, a return); it is held only when none is open to this person.
  const kindsOpen = NEW_KINDS.some((newKind) => kindHeld(newKind, can) === null)
  const newHeld = kindsOpen ? null : !can.inspectionsRecord ? t('held.noRecord') : t('held.noWorkOrders')

  // c: New inspection (the frame's keys are / j k x ↵ ?; the same skip of fields, menus and dialogs).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || dialog || model.open || newHeld) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      event.preventDefault()
      open({ kind: 'new' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The cells reach the page's actions through a ref: a new actions object must not rebuild the columns.
  const live = useRef({ actions, people: model.people ?? {}, marks: model.marks ?? {}, rows: model.rows.value ?? [] })
  live.current = { actions, people: model.people ?? {}, marks: model.marks ?? {}, rows: model.rows.value ?? [] }
  // B-W2b-127: the one list — final rows with the incoming and in-line ones the view reads (newest first, at most the page).
  const entries = useMemo(
    () => unionRows({ final: model.rows.value ?? [], incoming: model.incoming?.value ?? [], inline: model.inline?.value ?? [] }, model.limit),
    [model.rows.value, model.incoming?.value, model.inline?.value, model.limit],
  )
  const inspectionHref = (id: string) => `${model.prefix}/quality/inspections/${encodeURIComponent(id)}`
  const releaseHref = (id: string) => `${model.prefix}/quality/inspections?view=reversed&open=${encodeURIComponent(id)}`
  // A lot on hold opens its Warehouse record (SCR-201: stock, trace, the checklist); its decisions link on to Tests & substances.
  const lotHref = (id: string) => `${model.prefix}/warehouse/lots/${encodeURIComponent(id)}`

  const inspectionColumns = useMemo<ColDef<ListRow>[]>(() => {
    // B-W2b-127 (design qi-grid): one frame over final, incoming and in-line rows. A final row keeps its W1/W2a cells (the
    // inline Inspector and Due, the release words); an incoming or in-line row says its own facts, never a person.
    const NameCell = ({ data }: ICellRendererParams<ListRow>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name" href={rowHref(model.prefix, data)} tabIndex={-1}>
            {say(numberOf(data))}
          </Link>
          <span className="fw-q-hint">{t('list.opened', { date: formatDate(data.createdAt, { locale }) })}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<ListRow>) => (data ? <KindTag kind={data.kind} /> : null)
    const SubjectCell = ({ data }: ICellRendererParams<ListRow>) => (data ? <span>{say(subjectOf(data))}</span> : null)
    const SupplierCell = ({ data }: ICellRendererParams<ListRow>) => <span className={data?.kind === 'INCOMING' && data.row.supplier ? undefined : 'fw-q-hint'}>{data?.kind === 'INCOMING' && data.row.supplier ? data.row.supplier.name : '—'}</span>
    const SizeCell = ({ data }: ICellRendererParams<ListRow>) => (data ? <span className="fw-q-num">{say(lotOf(data))}</span> : null)
    const SampleCell = ({ data }: ICellRendererParams<ListRow>) => (data ? <span className="fw-q-num">{say(sampleOf(data))}</span> : null)
    const PlanCell = ({ data }: ICellRendererParams<ListRow>) => (data ? <span className={data.kind === 'FINAL' && !data.row.planVersion ? 'fw-q-hint' : 'fw-q-code'}>{say(planOf(data))}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.kind !== 'FINAL') {
        const status = otherStatusOf(data)
        return (
          <span className="fw-q-cell">
            <span className="fw-q-cell-row">
              <Pill tone={status.tone} dot>
                {td(status.key)}
              </Pill>
              {data.kind === 'INCOMING' && data.row.amended && <Tag tone="info">{td('status.AMENDED')}</Tag>}
            </span>
            {data.kind === 'INCOMING' && data.row.decision && <span className="fw-q-hint">{td('decision.split', { accepted: Number(data.row.decision.accepted), rejected: Number(data.row.decision.rejected), toSort: Number(data.row.decision.toSort) })}</span>}
            {data.kind === 'INLINE' && data.row.dhu && <span className="fw-q-hint">{td('inline.dhu', { dhu: data.row.dhu })}</span>}
          </span>
        )
      }
      const row = data.row
      const status = statusOf(row)
      const hold = holdOf(row)
      return (
        <span className="fw-q-cell">
          <span className="fw-q-cell-row">
            <Pill tone={status.tone} dot>
              {t(status.key)}
            </Pill>
            {row.amended && <Tag tone="info">{td('status.AMENDED')}</Tag>}
          </span>
          {row.undecided ? <span className="fw-q-hint">{t('list.undecided')}</span> : hold && <span className="fw-q-hint">{t(hold.key, hold.params)}</span>}
          {(row.holds > 0 || row.ncrs > 0) && <span className="fw-q-hint">{t('list.decidedIn', { holds: row.holds, ncrs: row.ncrs })}</span>}
        </span>
      )
    }
    const AssignedCell = ({ data: entry }: ICellRendererParams<ListRow>) => {
      if (!entry) return null
      if (entry.kind !== 'FINAL') return <span className="fw-q-hint">{entry.kind === 'INCOMING' ? td(entry.row.inspectorKind === 'FLOOR' ? 'who.bench' : entry.row.inspectorKind === 'OFFICE' ? 'who.office' : 'who.nobody') : '—'}</span>
      const data = entry.row
      const words = assignedWords(data.assigned, model.me)
      const act = live.current.actions
      if (!can.inspectionsRecord || data.status !== 'OPEN') return <span className={data.assigned ? undefined : 'fw-q-hint'}>{data.status === 'OPEN' ? t(words.key, words.params) : '—'}</span>
      const found = live.current.people[data.siteId]
      const current = assigneeValue(data.assigned)
      return (
        <span className="fw-q-cell-row">
          <Select
            size="xs"
            aria-label={t('assign.cellFor', { label: data.label })}
            value={current}
            onFocus={() => found === undefined && act?.onNeedPeople?.(data.siteId, live.current.rows.filter((row) => row.siteId === data.siteId).map((row) => row.workOrderId))}
            onChange={(event) => act?.onAssignCell?.(data, event.target.value)}
          >
            <option value="">{t('assign.nobody')}</option>
            {current && !found?.value?.inspectors.some((person) => `${person.kind}:${person.id}` === current) && <option value={current}>{t(words.key, words.params)}</option>}
            {(found?.value?.inspectors ?? []).map((person) => (
              <option key={`${person.kind}:${person.id}`} value={`${person.kind}:${person.id}`} disabled={person.made.length > 0}>
                {person.me ? t('assign.meNamed', { name: person.name }) : person.kind === 'WORKER' ? t('assign.benchNamed', { name: person.name }) : person.name}
                {person.made.length > 0 ? ` — ${t('assign.made', { orders: person.made.join(', ') })}` : ''}
              </option>
            ))}
          </Select>
          <Mark mark={live.current.marks[data.id]} />
        </span>
      )
    }
    // B-W2b-17 (design qi-grid inline "Due"): by when it is due, autosaved (one call with the row's version); overdue said in
    // words; a decided inspection, or a reader without quality.inspections.record, sees it read only. Incoming: read only.
    const DueCell = ({ data: entry }: ICellRendererParams<ListRow>) => {
      if (!entry) return null
      if (entry.kind !== 'FINAL') {
        const dueAt = entry.kind === 'INCOMING' ? entry.row.dueAt : null
        return <span className={dueAt ? 'fw-q-num' : 'fw-q-hint'}>{dueAt ? formatDateTime(dueAt, { locale }) : '—'}</span>
      }
      const data = entry.row
      const state = dueState(data)
      const words = data.dueAt ? formatDateTime(data.dueAt, { locale }) : t('due.none')
      const held = dueRowHeld(data, can)
      const overdue = state.tone === 'danger' ? <Tag tone="danger">{t('due.overdueTag')}</Tag> : null
      if (held)
        return (
          <span className="fw-q-cell">
            <span className={data.dueAt ? 'fw-q-num' : 'fw-q-hint'}>{data.status === 'OPEN' || data.dueAt ? words : '—'}</span>
            {overdue}
          </span>
        )
      return (
        <span className="fw-q-cell">
          <span className="fw-q-cell-row">
            <Input
              size="sm"
              type="datetime-local"
              aria-label={t('due.cellFor', { label: data.label })}
              defaultValue={toLocalInput(data.dueAt)}
              key={`${data.id}:${data.version}`}
              onBlur={(event) => {
                const next = fromLocalInput(event.target.value)
                if (next !== data.dueAt && !(next && data.dueAt && new Date(next).getTime() === new Date(data.dueAt).getTime())) live.current.actions?.onDueCell?.(data, next)
              }}
            />
            <Mark mark={live.current.marks[`due:${data.id}`]} />
          </span>
          {overdue}
        </span>
      )
    }
    const ReleasedCell = ({ data: entry }: ICellRendererParams<ListRow>) => {
      if (!entry) return null
      if (entry.kind !== 'FINAL') return <span className="fw-q-hint">—</span>
      const data = entry.row
      return (
        <span className="fw-q-cell">
          <span className="fw-q-num">{t('list.released', { released: data.released, lot: data.lotSize })}</span>
          {data.reversed > 0 && <span className="fw-q-hint">{t('list.takenBack', { count: data.reversed })}</span>}
          {data.toRelease > 0 && !data.onHold && <span className="fw-q-hint">{t('list.toRelease', { count: data.toRelease })}</span>}
        </span>
      )
    }
    const InspectorCell = ({ data }: ICellRendererParams<ListRow>) =>
      data ? <span>{data.kind === 'FINAL' ? t(whoKey(data.row.inspector, model.me).key) : data.kind === 'INCOMING' && data.row.status === 'DECIDED' ? td(data.row.inspectorKind === 'FLOOR' ? 'who.bench' : 'who.office') : '—'}</span> : null
    const DecidedCell = ({ data }: ICellRendererParams<ListRow>) => {
      const at = data?.kind === 'FINAL' ? data.row.decidedAt : data?.kind === 'INLINE' ? data.row.decidedAt : null
      return data ? <span>{dash(at ? formatDateTime(at, { locale }) : null)}</span> : null
    }
    const ActionsCell = ({ data: entry }: ICellRendererParams<ListRow>) => {
      if (!entry) return null
      const href = rowHref(model.prefix, entry)
      const name = say(numberOf(entry))
      if (entry.kind !== 'FINAL')
        return (
          <Menu
            align="right"
            label={<MoreHorizontal size={16} aria-hidden />}
            triggerProps={{ 'aria-label': t('row.menu', { name }) }}
            items={[
              { id: 'open', label: t('row.open'), href },
              { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
              { id: 'sep-copy', separator: true },
              { id: 'copy', label: t('row.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(name) },
            ]}
          />
        )
      const data = entry.row
      const reportReason = reportHeld(entry)
      return (
        <Menu
          align="right"
          label={<MoreHorizontal size={16} aria-hidden />}
          triggerProps={{ 'aria-label': t('row.menu', { name: data.label }) }}
          items={[
            { id: 'open', label: t('row.open'), href },
            { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
            ...(data.toRelease > 0 && !data.onHold ? [{ id: 'release', label: t('row.release'), href: `${href}?tab=decision` }] : []),
            { id: 'sep-w2a', separator: true },
            {
              id: 'assign',
              label: t('assign.menu'),
              onSelect: () => live.current.actions?.onAssign?.([data]),
              disabled: !can.inspectionsRecord || assignRowHeld(data) !== null,
              description: !can.inspectionsRecord ? t('assign.held.noRight') : assignRowHeld(data) ? t(assignRowHeld(data)!) : undefined,
            },
            { id: 'hold', label: t('row.placeHold'), onSelect: () => live.current.actions?.onPlaceHold?.(data), disabled: !can.holdsPlace, description: can.holdsPlace ? undefined : t('held.noHoldPlace') },
            { id: 'ncr', label: t('row.createNcr'), onSelect: () => live.current.actions?.onRaiseNcr?.(data), disabled: !can.ncrRaise, description: can.ncrRaise ? undefined : t('raiseNcr.held.noRight') },
            // B-W2b-127 (design qi-grid row verbs): Report PDF and Share report link, each in the report window (a new tab).
            { id: 'sep-report', separator: true },
            reportReason
              ? { id: 'report', label: td('row.report'), disabled: true, description: td(reportReason), icon: <FileText size={14} aria-hidden /> }
              : { id: 'report', label: td('row.report'), href: reportAddress(model.prefix, data.id), target: '_blank' as const, icon: <FileText size={14} aria-hidden /> },
            reportReason
              ? { id: 'share', label: td('row.share'), disabled: true, description: td(reportReason) }
              : { id: 'share', label: td('row.share'), href: reportAddress(model.prefix, data.id, { share: true }), target: '_blank' as const },
            { id: 'sep-copy', separator: true },
            { id: 'copy', label: t('row.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(data.label) },
          ]}
        />
      )
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<ListRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<ListRow> => ({
      colId,
      headerName: header,
      cellRenderer,
      sortable: false,
      ...size,
    })
    return [
      column('inspection', td('col.number'), NameCell, { flex: 1.5, minWidth: 180 }),
      column('kind', td('col.kind'), KindCell, { flex: 0.8, minWidth: 110 }),
      column('workOrder', td('col.subject'), SubjectCell, { flex: 1.5, minWidth: 170 }),
      column('supplier', td('col.supplier'), SupplierCell, { flex: 1.1, minWidth: 140 }),
      column('lot', td('col.lot'), SizeCell, { flex: 1, minWidth: 130 }),
      column('sample', td('col.sample'), SampleCell, { flex: 0.9, minWidth: 110 }),
      column('plan', td('col.plan'), PlanCell, { flex: 1, minWidth: 130 }),
      column('status', t('col.status'), StatusCell, { flex: 1.8, minWidth: 210 }),
      column('assigned', t('col.assigned'), AssignedCell, { flex: 1.3, minWidth: can.inspectionsRecord ? 190 : 140 }),
      column('due', t('col.due'), DueCell, { flex: 1.2, minWidth: can.inspectionsRecord ? 200 : 150 }),
      column('released', t('col.released'), ReleasedCell, { flex: 1.2, minWidth: 150 }),
      column('inspector', t('col.signedBy'), InspectorCell, { flex: 1, minWidth: 120 }),
      column('decided', t('col.decided'), DecidedCell, { flex: 1.1, minWidth: 140 }),
      { ...column('actions', t('col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
    // The cells close over the words, the person and their rights: a change of language rebuilds them.
  }, [t, td, say, locale, model.prefix, model.me, can.inspectionsRecord, can.holdsPlace, can.ncrRaise, model.people, model.marks])

  const releaseColumns = useMemo<ColDef<Release>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<Release>) => {
      if (!data) return null
      const label = releaseLabel(data)
      return (
        <span className="fw-q-cell">
          <Link className="fw-q-name" href={releaseHref(data.id)} tabIndex={-1} onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
            event.preventDefault()
            live.current.actions?.onOpenRelease?.(data.id)
          }}>
            {t(label.key, label.params)}
          </Link>
          <span className="fw-q-hint">{formatDateTime(data.releasedAt, { locale })}</span>
        </span>
      )
    }
    const BackCell = ({ data }: ICellRendererParams<Release>) => {
      if (!data) return null
      const last = lastReversal(data)
      return (
        <span className="fw-q-cell">
          <span className="fw-q-num">{t('list.backOf', { back: reversedOf(data), released: data.quantity })}</span>
          {last && <span className="fw-q-hint">{last.reasonCode ? t(`reason.${last.reasonCode}`) : t('reason.none')}</span>}
        </span>
      )
    }
    const HoldCell = ({ data }: ICellRendererParams<Release>) =>
      data ? data.onHold > 0 ? <Tag tone="warning">{t('list.holdCount', { count: data.onHold })}</Tag> : <span className="fw-q-hint">{t('list.holdCleared')}</span> : null
    const ByCell = ({ data }: ICellRendererParams<Release>) => (data ? <span>{t(whoKey(data.releasedBy, model.me).key)}</span> : null)
    const SecondCell = ({ data }: ICellRendererParams<Release>) =>
      data ? <span className="fw-q-hint">{data.secondPerson.reasons.length === 0 ? t('list.alone') : data.secondPerson.reasons.map((reason) => t(`secondPersonShort.${reason}`)).join(' · ')}</span> : null
    const ActionsCell = ({ data }: ICellRendererParams<Release>) =>
      data ? (
        <Menu
          align="right"
          label={<MoreHorizontal size={16} aria-hidden />}
          triggerProps={{ 'aria-label': t('row.menu', { name: data.releaseNumber ?? data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), onSelect: () => live.current.actions?.onOpenRelease?.(data.id) },
            { id: 'inspection', label: t('row.openInspection'), href: inspectionHref(data.inspectionId) },
            { id: 'copy', label: t('row.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(data.releaseNumber ?? data.number) },
          ]}
        />
      ) : null
    const column = (colId: string, header: string, cellRenderer: ColDef<Release>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<Release> => ({
      colId,
      headerName: header,
      cellRenderer,
      sortable: false,
      ...size,
    })
    return [
      column('release', t('col.release'), NameCell, { flex: 1.6, minWidth: 190 }),
      { colId: 'workOrder', headerName: t('col.workOrder'), sortable: false, flex: 1, minWidth: 130, valueGetter: (params) => params.data?.number ?? '' },
      column('back', t('col.takenBack'), BackCell, { flex: 1.6, minWidth: 190 }),
      column('hold', t('col.onHold'), HoldCell, { flex: 1, minWidth: 130 }),
      column('by', t('col.releasedBy'), ByCell, { flex: 1, minWidth: 120 }),
      column('second', t('col.secondPerson'), SecondCell, { flex: 1.4, minWidth: 170 }),
      { ...column('actions', t('col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
  }, [t, locale, model.prefix, model.me])

  const lotColumns = useMemo<ColDef<Lot>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<Lot>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name" href={lotHref(data.id)} tabIndex={-1}>
            {data.code}
          </Link>
          <span className="fw-q-hint">{data.receivedAt ? t('list.receivedOn', { date: formatDate(data.receivedAt, { locale }) }) : t('list.openingStock')}</span>
        </span>
      ) : null
    const ItemCell = ({ data }: ICellRendererParams<Lot>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{data.item.name}</span>
          <span className="fw-q-hint fw-q-code">{data.item.code}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<Lot>) =>
      data ? (
        <Pill tone={LOT_TONE[data.qualityStatus]} dot>
          {t(`lotStatus.${data.qualityStatus}`)}
        </Pill>
      ) : null
    const CrViCell = ({ data }: ICellRendererParams<Lot>) =>
      data ? <Tag tone={CR_VI_TONE[data.crVi.status]}>{t(`crVi.${data.crVi.status}`)}</Tag> : null
    const HoldCell = ({ data }: ICellRendererParams<Lot>) => <span className="fw-q-hint">{dash(data?.hold ?? data?.qualityNote ?? null)}</span>
    const column = (colId: string, header: string, cellRenderer: ColDef<Lot>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<Lot> => ({
      colId,
      headerName: header,
      cellRenderer,
      sortable: false,
      ...size,
    })
    return [
      column('lot', t('col.lotCode'), NameCell, { flex: 1.4, minWidth: 170 }),
      column('item', t('col.material'), ItemCell, { flex: 1.8, minWidth: 200 }),
      column('status', t('col.lotStatus'), StatusCell, { flex: 1, minWidth: 130 }),
      column('crvi', t('col.crVi'), CrViCell, { flex: 1, minWidth: 130 }),
      column('hold', t('col.why'), HoldCell, { flex: 2, minWidth: 200 }),
    ]
  }, [t, locale, model.prefix])

  if (!can.inspectionsView) return <NoAccess title={t('list.noAccess.title')} body={t('list.noAccess.body')} />

  // ---- tiles: each a named view ----
  const tiles = TILES.map((id) => {
    const count = model.tiles[id]
    const active = model.view === id
    const lotsHeld = id === 'lots' && !can.lotsView
    return {
      label: t(`tile.${id}`),
      value: lotsHeld ? '—' : count === undefined ? <Skeleton width={36} height={22} /> : count.count === null ? '—' : count.capped ? t('tile.atLeast', { count: count.count }) : countText(count.count),
      hint: lotsHeld ? t('held.noLots') : count?.count === null ? t('tile.unknown') : t(`tile.${id}Hint`),
      active,
      onClick: () => actions?.onView?.(active ? 'all' : id),
    }
  })

  // ---- the toolbar: the view menu and its chip ----
  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.rowsHeading') },
    ...VIEWS.map((view) => ({
      id: view,
      label: view === 'amended' ? td('view.amended') : t(`view.${view}`),
      checked: model.view === view,
      disabled: view === 'lots' && !can.lotsView,
      description: view === 'lots' && !can.lotsView ? t('held.noLots') : undefined,
      onSelect: () => actions?.onView?.(view),
    })),
  ]
  // B-W2b-127 (design qi-grid filter row "Kind (Incoming · In-line · Final · Return) first"): the kinds this person sees, in the
  // views that read them; elsewhere one line says why only final inspections are listed. Returns are graded on the return.
  const kindsShown = KINDS.filter((entry) => kindChipHeld(entry, 'all', sees) === null)
  const kindChips =
    kind !== 'inspections' || kindsShown.length < 2 ? null : viewJoins(model.view) ? (
      <span className="fw-q-chips" role="group" aria-label={td('kind.label')}>
        {kindsShown.map((entry) => (
          <FilterChip key={entry} pressed={kindFilter === entry} onClick={() => actions?.onKind?.(kindFilter === entry ? 'all' : entry)}>
            {td(`kind.${entry}`)}
          </FilterChip>
        ))}
      </span>
    ) : (
      <span className="fw-q-hint">{td('kind.held.view')}</span>
    )
  const tools = (
    <>
      <Menu label={t('list.rows', { view: model.view === 'amended' ? td('view.amended') : t(`view.${model.view}`) })} items={viewItems} />
      {model.view !== 'all' && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          <FilterChip pressed onClick={() => actions?.onView?.('all')} aria-label={t('list.removeFilter', { name: model.view === 'amended' ? td('view.amended') : t(`view.${model.view}`) })}>
            {model.view === 'amended' ? td('view.amended') : t(`view.${model.view}`)} <X size={12} aria-hidden />
          </FilterChip>
        </span>
      )}
      {kindChips}
    </>
  )
  const moreItems: MenuItemDef[] = [
    { id: 'rules', label: t('list.rulesMenu'), onSelect: () => open({ kind: 'rules' }) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => open({ kind: 'shortcuts' }) },
  ]

  // B-W2b-127: the final read decides the frame's state (a failed incoming or in-line read is its own banner, never an empty list).
  const finalRead = model.rows
  const otherReading = (model.incoming !== null && model.incoming !== undefined && model.incoming.value === null && !model.incoming.problem) || (model.inline !== null && model.inline !== undefined && model.inline.value === null && !model.inline.problem)
  const read: Read<readonly unknown[]> = kind === 'inspections' ? (finalRead.problem ? finalRead : finalRead.value === null || otherReading ? { value: null, problem: null } : { value: entries, problem: null }) : kind === 'releases' ? model.releases : model.lots
  const rows = read.value ?? []
  const count = rows.length
  const selectedCount = model.selected.length
  const pickedEntries = kind === 'inspections' ? entries.filter((entry) => model.selected.includes(entry.key)) : []
  const pickedRows = finalRowsOf(pickedEntries)
  const mixed = pickedEntries.length !== pickedRows.length
  const bulkAssignHeld = kind === 'inspections' ? (mixed ? 'assign.held.kind' : assignHeld(pickedRows, can)) : null
  const bulkDueHeld = kind === 'inspections' ? (mixed ? 'assign.held.kind' : dueBulkHeld(pickedRows, can)) : null
  const bulkPrintHeld = kind === 'inspections' ? printHeld(pickedEntries) : null
  const heldWords = (key: string | null) => (key === null ? null : key === 'assign.held.kind' ? td('bulk.finalOnly') : t(key))
  const bulk = (
    <>
      {kind === 'inspections' && (
        <Button size="sm" onClick={() => actions?.onPrintReports?.(pickedRows.map((row) => row.id))} heldReason={bulkPrintHeld ? td(bulkPrintHeld) : null} aria-label={td('bulk.print', { count: selectedCount })}>
          <Printer size={13} aria-hidden /> <SelectionLabel>{td('bulk.print', { count: selectedCount })}</SelectionLabel>
        </Button>
      )}
      {kind === 'inspections' && (
        <Button size="sm" onClick={() => actions?.onAssign?.(pickedRows)} heldReason={heldWords(bulkAssignHeld)} aria-label={t('assign.bulk', { count: selectedCount })}>
          <UserCheck size={13} aria-hidden /> <SelectionLabel>{t('assign.bulk', { count: selectedCount })}</SelectionLabel>
        </Button>
      )}
      {kind === 'inspections' && (
        <Button size="sm" onClick={() => actions?.onDue?.(pickedRows)} heldReason={heldWords(bulkDueHeld)} aria-label={t('due.bulk', { count: selectedCount })}>
          <CalendarClock size={13} aria-hidden /> <SelectionLabel>{t('due.bulk', { count: selectedCount })}</SelectionLabel>
        </Button>
      )}
      <Button size="sm" onClick={() => actions?.onExport?.(kind, model.selected)} aria-label={t('list.bulkExport', { count: selectedCount })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: selectedCount })}</SelectionLabel>
      </Button>
    </>
  )
  const state: ReactNode = read.problem ? (
    <EmptyState
      title={t(`list.failed.${kind}`)}
      description={t(read.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : read.value !== null && rows.length === 0 ? (
    model.view === 'all' ? (
      <EmptyState
        icon={<ClipboardCheck size={24} aria-hidden />}
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          <Button variant="primary" onClick={() => open({ kind: 'new' })} heldReason={newHeld}>
            {t('list.new')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={model.view === 'amended' ? td('view.amendedNone') : kindFilter !== 'all' ? td('kind.none', { kind: td(`kind.${kindFilter}`) }) : t(`list.none.${model.view}`)}
        action={
          <Button size="sm" onClick={() => actions?.onView?.('all')}>
            {t('list.showAll')}
          </Button>
        }
      />
    )
  ) : undefined
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const frameCommon = {
    count: read.value === null ? t('list.countReading') : count >= model.limit || model.inlineCapped ? t('list.countAtLeast', { count }) : t('list.count', { count }),
    tools,
    right: <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />,
    selection: { selected: model.selected, onChange: (ids: string[]) => actions?.onSelect?.(ids), actions: bulk },
    updates: model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null,
    more:
      read.value !== null && count >= model.limit
        ? { label: t('list.showMore'), onMore: () => actions?.onMore?.(), held: model.limit >= MAX ? t('list.maxReached', { max: MAX }) : null }
        : null,
    keys: ownKeys,
    onHelp: () => open({ kind: 'shortcuts' }),
    state,
    focusRow: model.focusRow,
  }

  const ruleValue = model.rule.value
  const openRelease = model.open ?? null
  const reverseOpen = dialog?.kind === 'reverse'
  const releaseIds = (model.releases.value ?? []).map((release) => release.id)

  return (
    <div className="fw-q">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            {can.holdsView && (
              <Button size="sm" asChild>
                <Link href={`${model.prefix}/quality/holds`}>
                  <Hand size={14} aria-hidden /> {t('list.holds')}
                </Link>
              </Button>
            )}
            <Button size="sm" onClick={() => open({ kind: 'rules' })}>
              <Settings2 size={14} aria-hidden /> {t('list.rules')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => open({ kind: 'new' })} heldReason={newHeld}>
              {t('list.new')}
            </Button>
          </>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {model.reverseAnswer && (
        <Banner tone="success" title={t('reverse.done', { count: model.reverseAnswer.quantity })} onDismiss={actions?.onDismissNotice}>
          {model.reverseAnswer.register.opened && model.reverseAnswer.register.entryId ? (
            <Link className="fw-q-link" href={`${model.prefix}/compliance/register/${encodeURIComponent(model.reverseAnswer.register.entryId)}`}>
              {t('reverse.registerOpened', { reference: model.reverseAnswer.register.reference ?? '' })}
            </Link>
          ) : (
            <span>{t('reverse.registerNone')}</span>
          )}
        </Banner>
      )}
      {ruleValue ? (
        <Banner tone="info" title={t('list.ruleTitle', { rule: t(`rules.rule.${ruleValue.inForce.rule}`) })}>
          {ruleValue.customers.length > 0 ? t('list.ruleCustomers', { count: ruleValue.customers.length }) : t('list.ruleNoCustomers')}
        </Banner>
      ) : model.rule.problem ? (
        <Banner tone="warning" title={t('list.ruleFailed')}>
          {t(model.rule.problem)}
        </Banner>
      ) : null}
      <MetricStrip metrics={tiles} />

      {kind === 'inspections' &&
        (['incoming', 'inline'] as const).map((part) => {
          const partRead = part === 'incoming' ? model.incoming : model.inline
          return partRead?.problem ? (
            <Banner
              key={part}
              tone="warning"
              title={td(`failed.${part}`)}
              action={
                <Button size="sm" onClick={() => actions?.onRetryPart?.(part)}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t(partRead.problem)}
            </Banner>
          ) : null
        })}
      {kind === 'inspections' && model.inlineCapped && <p className="fw-q-hint">{td('capped.inline')}</p>}
      {kind === 'inspections' && (
        <ListFrame<ListRow>
          key="inspections"
          label={t('list.table.inspections')}
          rows={read.value === null ? null : (read.value as readonly ListRow[])}
          rowId={(row) => row.key}
          columns={inspectionColumns}
          onOpen={(row) => (row.kind === 'FINAL' ? actions?.onOpenInspection?.(row.row) : actions?.onOpenEntry?.(row))}
          {...frameCommon}
        />
      )}
      {kind === 'releases' && (
        <ListFrame<Release>
          key="releases"
          label={t('list.table.releases')}
          rows={model.releases.problem ? [] : model.releases.value}
          rowId={(row) => row.id}
          columns={releaseColumns}
          onOpen={(row) => actions?.onOpenRelease?.(row.id)}
          {...frameCommon}
        />
      )}
      {kind === 'lots' && (
        <ListFrame<Lot>
          key="lots"
          label={t('list.table.lots')}
          rows={model.lots.problem ? [] : model.lots.value}
          rowId={(row) => row.id}
          columns={lotColumns}
          onOpen={(row) => actions?.onOpenLot?.(row)}
          {...frameCommon}
        />
      )}

      {openRelease && (
        <ReleaseDetailModal
          open={!reverseOpen}
          detail={openRelease.detail}
          prefix={model.prefix}
          me={model.me}
          can={can}
          nav={kind === 'releases' && releaseIds.includes(openRelease.id) ? { ids: releaseIds, current: openRelease.id, onGo: (id) => actions?.onOpenRelease?.(id) } : null}
          onClose={() => actions?.onOpenRelease?.(null)}
          onReverse={() => open({ kind: 'reverse', releaseId: openRelease.id })}
          onRetry={actions?.onRetryRelease}
          initialTab={openRelease.tab}
        />
      )}
      <NewInspectionModal
        open={dialog?.kind === 'new'}
        draft={model.newDraft ?? NEW_DRAFT}
        can={can}
        prefix={model.prefix}
        people={model.newPeople ?? null}
        returns={model.returns ?? null}
        returnRecord={model.returnRecord ?? null}
        returnDraft={model.returnDraft ?? RETURN_DRAFT}
        onPickReturn={(id) => actions?.onPickReturn?.(id)}
        onReturnDraft={(draft) => actions?.onReturnDraft?.(draft)}
        onGradeReturn={() => actions?.onGradeReturn?.()}
        workOrders={model.pick?.workOrders ?? { value: null, problem: null }}
        cells={model.pick?.cells ?? null}
        busy={model.busy}
        problem={dialog?.kind === 'new' ? model.dialogProblem : null}
        lines={dialog?.kind === 'new' ? model.dialogLines : undefined}
        onDraft={(draft) => actions?.onNewDraft?.(draft)}
        onPick={(id) => actions?.onPickWorkOrder?.(id)}
        onCreate={() => actions?.onCreate?.()}
        onClose={() => open(null)}
        depth={depth}
        plans={model.plans ?? null}
      />
      <RulesModal
        open={dialog?.kind === 'rules'}
        rule={model.rule}
        draft={model.ruleDraft ?? null}
        canManage={can.settingsManage}
        canFindCustomers={can.partiesView}
        search={model.customerSearch ?? null}
        busy={model.busy}
        problem={dialog?.kind === 'rules' ? model.dialogProblem : null}
        companyName={model.companyName}
        onDraft={(draft) => actions?.onRuleDraft?.(draft)}
        onSearch={(q) => actions?.onFindCustomers?.(q)}
        onSave={() => actions?.onSaveRule?.()}
        onClose={() => open(null)}
      />
      <ReverseModal
        open={reverseOpen}
        detail={openRelease?.detail.value ?? null}
        draft={model.reverseDraft ?? { quantity: '', serialIds: [], serialsTo: null, reasonCode: null, reason: '' }}
        busy={model.busy}
        problem={reverseOpen ? model.dialogProblem : null}
        lines={model.dialogLines}
        onDraft={(draft) => actions?.onReverseDraft?.(draft)}
        onReverse={() => actions?.onReverse?.()}
        onClose={() => open(null)}
      />
      <DueDialog state={model.due ?? null} onValue={(value) => actions?.onDueValue?.(value)} onSave={() => actions?.onDueSave?.()} onClose={() => actions?.onDueClose?.()} />
      <AssignDialog state={model.assign ?? null} onValue={(value) => actions?.onAssignValue?.(value)} onSave={() => actions?.onAssignSave?.()} onClose={() => actions?.onAssignClose?.()} />
      <ShortcutsModal open={dialog?.kind === 'shortcuts'} onClose={() => open(null)} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: lists(entry.does) === entry.does ? entry.does : lists(entry.does) }))} />
      {stepUp && <StepUpDialog state={stepUp} onSubmit={(code) => actions?.onStepUpSubmit?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />}
    </div>
  )
}
