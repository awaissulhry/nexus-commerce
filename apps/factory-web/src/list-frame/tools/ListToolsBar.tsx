'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Columns3, Download } from 'lucide-react'
import { Menu, useToast, type MenuItemDef } from '@nexus/ui/components'
import type { ExportFormat } from '@nexus/factory-domain/views/exports'
import { formatNumber, formatTime } from '../../lib/i18n/format'
import { useLocale, useT } from '../../lib/i18n/provider'
import type { Translate } from '../../lib/i18n/messages'
import { CustomiseDialog, ExportJobDialog, RemoveViewDialog, SaveViewDialog } from './dialogs'
import { exportColumnsOf, isActiveJob, recentJobs } from './model'
import { problemOf, type ExportJob, type SavedView, type ToolsProblem, type ViewDraft, type ViewsAnswer } from './transport'
import { stateOfScreen, type ListToolsState } from './useListTools'

/**
 * The list toolbar's shared words (B-W2a-23; design shell.lists sec:toolbar "Search · Rows ▾ · Columns ▾ · density ·
 * Export ▾ · ⋯"): Columns ▾ (the person's views and the shared ones, Save view as…, Update, Rename or share, Make it
 * my default / Stop using it as my default (B-W2b-24: my own views only), Copy link, Remove, then Customise columns…) and Export ▾ (this view as CSV or Excel, the full file for re-import when the
 * list has one, then the person's recent exports of the list). The density is chosen in Customise (the one Customise
 * dialog), never a third control in a toolbar that already wraps on a phone. A list without an export has no Export ▾;
 * a person without views.export neither (the section is absent, never a locked box).
 */

type Dialog = { kind: 'save' } | { kind: 'edit'; view: SavedView } | { kind: 'remove'; view: SavedView } | { kind: 'customise' } | { kind: 'job'; job: ExportJob }

/** Who sees a view, in words, for its menu line. */
export function sharingWords(t: Translate, view: SavedView): string {
  const who = view.audience === 'ONLY_ME' ? t('tools.onlyMe') : view.audience === 'EVERYONE' ? t('tools.everyone') : view.roleDefault ? t('tools.defaultFor', { role: view.roleName ?? '' }) : t('tools.forRole', { role: view.roleName ?? '' })
  if (!view.mine) return t('tools.sharedBy', { name: view.ownerName, who })
  return view.personalDefault ? `${who} · ${t('tools.myDefault')}` : who
}

export interface ColumnsMenuInput {
  readonly answer: ViewsAnswer | null
  readonly problem: ToolsProblem | null
  readonly active: SavedView | null
  readonly changed: boolean
  readonly asBuilt: boolean
}

export interface ColumnsMenuActions {
  readonly apply: (view: SavedView | null) => void
  readonly reload: () => void
  readonly save: () => void
  readonly update: (view: SavedView) => void
  readonly edit: (view: SavedView) => void
  readonly copy: (view: SavedView) => void
  readonly remove: (view: SavedView) => void
  /** B-W2b-24: make my own view my default of the list (on) or no longer (off). */
  readonly setDefault: (view: SavedView, on: boolean) => void
  readonly customise: () => void
}

/** Columns ▾: views, then the active view's verbs, then Customise (pure, for the tests). */
export function columnsMenuItems(t: Translate, input: ColumnsMenuInput, act: ColumnsMenuActions): MenuItemDef[] {
  const { answer, problem, active, changed } = input
  const items: MenuItemDef[] = [{ id: 'h-views', heading: true, label: t('tools.views') }]
  items.push({ id: 'built', label: t('tools.standard'), checked: active === null && input.asBuilt, description: t('tools.standardHint'), onSelect: () => act.apply(null) })
  if (answer) {
    const mine = answer.views.filter((view) => view.mine)
    const shared = answer.views.filter((view) => !view.mine)
    for (const view of mine) items.push({ id: `v-${view.id}`, label: view.name, checked: active?.id === view.id, description: sharingWords(t, view), onSelect: () => act.apply(view) })
    if (shared.length > 0) items.push({ id: 'h-shared', heading: true, label: t('tools.shared') })
    for (const view of shared) items.push({ id: `v-${view.id}`, label: view.name, checked: active?.id === view.id, description: sharingWords(t, view), onSelect: () => act.apply(view) })
    if (answer.views.length === 0) items.push({ id: 'none', label: t('tools.noViews'), disabled: true, description: t('tools.noViewsHint') })
  } else if (problem) {
    items.push({ id: 'retry', label: t('tools.failed'), description: t(`tools.problem.${problem}`), onSelect: act.reload })
  } else {
    items.push({ id: 'loading', label: t('tools.loadingViews'), disabled: true, description: t('tools.loadingViewsHint') })
  }
  items.push({ id: 's-views', separator: true })
  const canSave = answer?.can.save ?? false
  items.push({ id: 'save', label: t('tools.saveAs'), onSelect: act.save, ...(canSave ? {} : { disabled: true, description: answer ? t('tools.held.save') : t('tools.loadingViewsHint') }) })
  if (active) {
    if (active.changeHeld === null) {
      if (changed) items.push({ id: 'update', label: t('tools.update', { name: active.name }), description: t('tools.updateHint'), onSelect: () => act.update(active) })
      items.push({ id: 'edit', label: t('tools.edit', { name: active.name }), onSelect: () => act.edit(active) })
    } else {
      items.push({ id: 'edit', label: t('tools.edit', { name: active.name }), disabled: true, description: active.mine ? t('tools.held.manage') : t('tools.held.change') })
    }
    // B-W2b-24: my default view of the list (only a view of my own: the mark is its owner's).
    if (!active.mine) items.push({ id: 'default', label: t('tools.makeDefault', { name: active.name }), disabled: true, description: t('tools.held.defaultNotOwn') })
    else if (active.personalDefault) items.push({ id: 'default', label: t('tools.stopDefault', { name: active.name }), description: t('tools.stopDefaultHint'), onSelect: () => act.setDefault(active, false) })
    else if (canSave) items.push({ id: 'default', label: t('tools.makeDefault', { name: active.name }), description: t('tools.makeDefaultHint'), onSelect: () => act.setDefault(active, true) })
    else items.push({ id: 'default', label: t('tools.makeDefault', { name: active.name }), disabled: true, description: t('tools.held.save') })
    items.push({ id: 'link', label: t('tools.copyLink', { name: active.name }), onSelect: () => act.copy(active) })
    if (active.changeHeld === null) items.push({ id: 'remove', label: t('tools.remove', { name: active.name }), tone: 'danger', onSelect: () => act.remove(active) })
  }
  items.push({ id: 's-customise', separator: true })
  items.push({ id: 'customise', label: t('tools.customiseItem'), onSelect: act.customise })
  return items
}

/** Export ▾: the formats the list exports to, then the person's recent exports (pure, for the tests). */
export function exportMenuItems(t: Translate, formats: readonly ExportFormat[], jobs: readonly ExportJob[], time: (iso: string) => string, act: { start: (format: ExportFormat) => void; open: (job: ExportJob) => void }, number: (value: number) => string = String): MenuItemDef[] {
  const items: MenuItemDef[] = formats.map((format) => ({ id: `f-${format}`, label: t(`tools.exportAs.${format}`), onSelect: () => act.start(format) }))
  const recent = recentJobs(jobs)
  if (recent.length > 0) {
    items.push({ id: 's-recent', separator: true }, { id: 'h-recent', heading: true, label: t('tools.recent') })
    for (const job of recent) {
      const status =
        job.status === 'DONE'
          ? t('tools.status.DONE', { count: job.rowCount ?? 0, rows: number(job.rowCount ?? 0) })
          : job.status === 'RUNNING'
            ? t('tools.status.RUNNING', { count: job.rowsDone, rows: number(job.rowsDone) })
            : t(`tools.status.${job.status}`)
      items.push({ id: `j-${job.id}`, label: t('tools.recentItem', { format: t(`tools.format.${job.format}`), time: time(job.createdAt) }), description: status, onSelect: () => act.open(job) })
    }
  }
  return items
}

/** The DS toast, or nothing when no provider is mounted (the grid card mounts one). */
function useReceipt(): (message: string, tone?: 'success' | 'danger') => void {
  let api: ReturnType<typeof useToast> | null = null
  try {
    api = useToast()
  } catch {
    api = null
  }
  return (message, tone = 'success') => api?.toast(message, tone)
}

export function ListToolsBar<T>({ state }: { state: ListToolsState<T> }) {
  const t = useT('lists')
  const locale = useLocale()
  const receipt = useReceipt()
  const transport = state.transport!
  // The address changes the transport (its query); the reads below use the latest without starting again.
  const live = useRef(transport)
  live.current = transport
  const design = transport.design
  const [columnsOpen, setColumnsOpen] = useState(design?.menu === 'columns')
  const [exportOpen, setExportOpen] = useState(design?.menu === 'export')
  const initial: Dialog | null =
    design?.dialog === 'customise'
      ? { kind: 'customise' }
      : design?.dialog === 'save'
        ? { kind: 'save' }
        : design?.dialog === 'job' && design.job
          ? { kind: 'job', job: design.job }
          : null
  const [dialog, setDialog] = useState<Dialog | null>(initial)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<ToolsProblem | null>(null)
  const [jobs, setJobs] = useState<readonly ExportJob[]>([])
  const listKey = state.listKey!
  const exportsOn = !!state.answer?.exports && state.answer.can.export

  // The design's edit and remove dialogs open on the active view once the views are read.
  useEffect(() => {
    if (!design?.dialog || !state.active) return
    if (design.dialog === 'edit') setDialog((current) => current ?? { kind: 'edit', view: state.active! })
    if (design.dialog === 'remove') setDialog((current) => current ?? { kind: 'remove', view: state.active! })
  }, [design?.dialog, state.active])

  const readJobs = useCallback(() => {
    if (!exportsOn) return
    live.current
      .listExports(listKey)
      .then(setJobs)
      .catch(() => setJobs([]))
  }, [exportsOn, listKey])
  useEffect(() => readJobs(), [readJobs])

  // The e-mail's (or a reload's) `?export=<id>`: the job's dialog.
  const linkedExport = transport.linked.export
  useEffect(() => {
    if (!linkedExport) return
    transport
      .readExport(linkedExport)
      .then((job) => setDialog({ kind: 'job', job }))
      .catch(() => receipt(t('tools.problem.notFound'), 'danger'))
      .finally(() => transport.clearLinked())
    // Once per link.
  }, [linkedExport])

  // A running job's dialog asks for its state every second (then every two); a closed dialog stops asking.
  const openJob = dialog?.kind === 'job' ? dialog.job : null
  const polls = useRef(0)
  useEffect(() => {
    if (!openJob || !isActiveJob(openJob.status) || design?.dialog === 'job') return
    const timer = setTimeout(
      () => {
        polls.current++
        live.current
          .readExport(openJob.id)
          .then((job) => {
            setDialog((current) => (current?.kind === 'job' && current.job.id === job.id ? { kind: 'job', job } : current))
            if (!isActiveJob(job.status)) readJobs()
          })
          .catch((error: unknown) => setProblem(problemOf(error)))
      },
      polls.current < 10 ? 1000 : 2000,
    )
    return () => clearTimeout(timer)
  }, [openJob, readJobs, design?.dialog])

  const close = () => {
    setDialog(null)
    setProblem(null)
    setBusy(false)
  }

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(problemOf(error))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (link: string) => {
    const done = await transport.copy(link)
    receipt(done ? t('tools.save.copied') : t('tools.save.copyFailed'), done ? 'success' : 'danger')
  }

  const startExport = (format: ExportFormat) => {
    const columns = exportColumnsOf(state.columns as never)
    transport
      .startExport({ listKey, format, query: transport.query, columns, title: state.title, ...(state.active && !state.changed ? { viewName: state.active.name } : {}) }, transport.newKey())
      .then((job) => {
        polls.current = 0
        setDialog({ kind: 'job', job })
        setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)])
      })
      .catch((error: unknown) => receipt(t(`tools.problem.${problemOf(error)}`), 'danger'))
  }

  const columnsItems = columnsMenuItems(
    t,
    { answer: state.answer, problem: state.problem, active: state.active, changed: state.changed, asBuilt: !state.layout.columns && !state.layout.density },
    {
      apply: (view) => state.apply(view),
      reload: state.reload,
      save: () => setDialog({ kind: 'save' }),
      update: (view) =>
        void transport
          .updateView(view, { state: stateOfScreen(state) }, transport.newKey())
          .then((next) => {
            state.saved(next)
            receipt(t('tools.save.updated'))
          })
          .catch((error: unknown) => receipt(t(`tools.problem.${problemOf(error)}`), 'danger')),
      edit: (view) => setDialog({ kind: 'edit', view }),
      copy: (view) => void copy(transport.viewLink(view.id)),
      remove: (view) => setDialog({ kind: 'remove', view }),
      setDefault: (view, on) =>
        void transport
          .setPersonalDefault(view, on, transport.newKey())
          .then((next) => {
            state.defaulted(next.view, next.personalDefaultId)
            receipt(on ? t('tools.save.defaultOn', { name: view.name }) : t('tools.save.defaultOff', { name: view.name }))
          })
          .catch((error: unknown) => receipt(t(`tools.problem.${problemOf(error)}`), 'danger')),
      customise: () => setDialog({ kind: 'customise' }),
    },
  )

  const label = state.active ? (state.changed ? t('tools.activeChanged', { name: state.active.name }) : state.active.name) : t('tools.columns')
  return (
    <>
      <Menu
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        label={
          <>
            <Columns3 size={13} aria-hidden /> <span className="fw-lt-trigger">{label}</span>
          </>
        }
        items={columnsItems}
        triggerProps={{ className: 'nds-btn sm', 'aria-label': t('tools.columnsLabel'), title: t('tools.columnsLabel') }}
      />
      {exportsOn && (
        <Menu
          open={exportOpen}
          onOpenChange={(open) => {
            setExportOpen(open)
            if (open) readJobs()
          }}
          label={
            <>
              <Download size={13} aria-hidden /> {t('tools.export')}
            </>
          }
          items={exportMenuItems(t, state.answer!.exports!.formats, jobs, (iso) => formatTime(iso, { locale }), { start: startExport, open: (job) => setDialog({ kind: 'job', job }) }, (value) => formatNumber(value, locale))}
          triggerProps={{ className: 'nds-btn sm', 'aria-label': t('tools.exportLabel') }}
        />
      )}

      {dialog?.kind === 'customise' && <CustomiseDialog tools={state.tools} layout={state.layout} onApply={(next) => state.setLayout(next)} onClose={close} />}
      {(dialog?.kind === 'save' || dialog?.kind === 'edit') && state.answer && (
        <SaveViewDialog
          view={dialog.kind === 'edit' ? dialog.view : null}
          answer={state.answer}
          state={stateOfScreen(state)}
          busy={busy}
          problem={problem}
          link={dialog.kind === 'edit' ? transport.viewLink(dialog.view.id) : null}
          onCopy={(link) => void copy(link)}
          onSave={(draft: ViewDraft) =>
            void run(async () => {
              const view = dialog.kind === 'edit' ? await transport.updateView(dialog.view, { name: draft.name, audience: draft.audience, roleId: draft.roleId, roleDefault: draft.roleDefault }, transport.newKey()) : await transport.createView(listKey, draft, transport.newKey())
              state.saved(view)
              receipt(dialog.kind === 'edit' ? t('tools.save.updated') : t('tools.save.saved'))
              close()
            })
          }
          onClose={close}
        />
      )}
      {dialog?.kind === 'remove' && (
        <RemoveViewDialog
          view={dialog.view}
          busy={busy}
          problem={problem}
          onRemove={() =>
            void run(async () => {
              await transport.removeView(dialog.view)
              state.removed(dialog.view.id)
              receipt(t('tools.removeDialog.done'))
              close()
            })
          }
          onClose={close}
        />
      )}
      {dialog?.kind === 'job' && (
        <ExportJobDialog
          job={dialog.job}
          problem={problem}
          onDownload={() => void transport.download(dialog.job).catch((error: unknown) => setProblem(problemOf(error)))}
          onAgain={() => {
            close()
            startExport(dialog.job.format)
          }}
          onClose={close}
        />
      )}
    </>
  )
}
