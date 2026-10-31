import { normaliseState } from '@nexus/factory-domain/views/state'
import { missingRow, previewRow, type BulkResult, type BulkRowFacts } from '@nexus/factory-domain/views/bulk/rules'
import { ToolsError, type ExportJob, type ListToolsTransport, type SavedView, type ToolsDesignState, type ViewsAnswer, type WorkingLayout } from '../../../list-frame/tools/transport'

/**
 * The list tools in memory (B-W2a-23): the same seam as the Office's ListToolsProvider, over made-up views and exports
 * that live as long as the page. The design gallery (SCR-232) uses it, so every menu and dialog works for real in the
 * browser (save, update, share, remove, export with its progress); nothing leaves the page.
 */

export interface MemoryToolsModel {
  readonly pageKey: string | null
  readonly locale: 'it' | 'en'
  /** The views the API would answer; `loading`: it never answers; `failed`: it refuses. */
  readonly answer: ViewsAnswer | 'loading' | 'failed'
  readonly jobs: readonly ExportJob[]
  readonly layout?: WorkingLayout | null
  readonly linked?: { readonly view: string | null; readonly export: string | null }
  readonly design?: ToolsDesignState
  /** The rows a made-up export writes (its progress counts to them). */
  readonly exportRows?: number
  /**
   * B-W2b-13: the rows a bulk edit (or a cell) reads and writes, as the API's bulk target holds them (made-up; the
   * store changes them as the gallery edits). Absent: a bulk edit is refused as offline.
   */
  readonly bulk?: readonly BulkRowFacts[]
  /** B-W2b-13: every bulk write is refused (a design case of a failed save). */
  readonly bulkFails?: boolean
}

export interface MemoryStore {
  answer: ViewsAnswer | 'loading' | 'failed'
  jobs: ExportJob[]
  layouts: Map<string, WorkingLayout>
  linked: { view: string | null; export: string | null }
  next: number
  bulk: Map<string, BulkRowFacts>
}

export function memoryStore(model: MemoryToolsModel): MemoryStore {
  return {
    answer: model.answer,
    jobs: [...model.jobs],
    layouts: new Map(model.layout && model.pageKey ? [[model.pageKey, model.layout]] : []),
    linked: { view: model.linked?.view ?? null, export: model.linked?.export ?? null },
    next: 1,
    bulk: new Map((model.bulk ?? []).map((row) => [row.id, row])),
  }
}

const NEVER = new Promise<never>(() => undefined)
/** A made-up answer takes a moment, as the API does (the save marks and the review's reading state show). */
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 350))

/** The transport over a store; `query` is the page's address terms, `onAddress` changes them. */
export function memoryTransport(model: MemoryToolsModel, store: MemoryStore, query: string, onAddress: (query: string) => void): ListToolsTransport {
  const views = (): ViewsAnswer => {
    if (store.answer === 'loading' || store.answer === 'failed') throw new ToolsError('failed')
    return store.answer
  }
  const id = (prefix: string) => `0190f0e2-${prefix}-7000-8000-${String(store.next++).padStart(12, '0')}`
  const replace = (view: SavedView) => {
    const answer = views()
    store.answer = { ...answer, views: [...answer.views.filter((entry) => entry.id !== view.id), view] }
    return view
  }
  return {
    pageKey: model.pageKey,
    query,
    linked: store.linked,
    goTo: (next) => {
      store.linked = { view: null, export: null }
      onAddress(next)
    },
    clearLinked: () => {
      store.linked = { view: null, export: null }
      onAddress(query)
    },
    viewLink: (viewId) => `https://factory.example.com/w/DEMO/sales/orders?savedView=${viewId}`,
    locale: model.locale,
    listViews: () => (store.answer === 'loading' ? NEVER : store.answer === 'failed' ? Promise.reject(new ToolsError('offline')) : Promise.resolve(store.answer)),
    createView: async (listKey, draft) => {
      const answer = views()
      if (answer.views.some((view) => view.mine && view.name.toLowerCase() === draft.name.toLowerCase())) throw new ToolsError('nameTaken')
      const role = draft.roleId ? (answer.allRoles.find((entry) => entry.id === draft.roleId) ?? answer.roles.find((entry) => entry.id === draft.roleId)) : null
      const view: SavedView = { id: id('aaaa'), listKey, name: draft.name, ownerId: 'me', ownerName: 'Demo', mine: true, audience: draft.audience, roleId: draft.roleId, roleName: role?.name ?? null, roleDefault: draft.roleDefault, personalDefault: false, state: normaliseState(draft.state), changeHeld: null, version: 1 }
      return replace(view)
    },
    updateView: async (view, change) => {
      const role = change.roleId ? (views().allRoles.find((entry) => entry.id === change.roleId) ?? views().roles.find((entry) => entry.id === change.roleId)) : null
      return replace({ ...view, ...change, ...(change.roleId !== undefined ? { roleName: role?.name ?? null } : {}), ...(change.state ? { state: normaliseState(change.state) } : {}), version: view.version + 1 })
    },
    removeView: async (view) => {
      const answer = views()
      store.answer = { ...answer, views: answer.views.filter((entry) => entry.id !== view.id), personalDefaultId: answer.personalDefaultId === view.id ? null : answer.personalDefaultId }
    },
    // B-W2b-24: my default view (only my own; the old default loses its mark, as the API does).
    setPersonalDefault: async (view, on) => {
      const answer = views()
      if (!view.mine) throw new ToolsError('forbidden')
      const next = { ...view, personalDefault: on, version: view.version + 1 }
      const others = answer.views.map((entry) => (entry.id === view.id ? next : on && entry.personalDefault ? { ...entry, personalDefault: false, version: entry.version + 1 } : entry))
      store.answer = { ...answer, views: others, personalDefaultId: on ? view.id : null }
      return { view: next, personalDefaultId: on ? view.id : null }
    },
    startExport: async (ask) => {
      if (store.jobs.filter((job) => job.status === 'QUEUED' || job.status === 'RUNNING').length >= 3) throw new ToolsError('busy')
      const job: ExportJob = {
        id: id('bbbb'),
        listKey: ask.listKey,
        format: ask.format,
        status: 'QUEUED',
        title: ask.title,
        viewName: ask.viewName ?? null,
        columns: ask.columns,
        omitted: [],
        rowsDone: 0,
        rowCount: null,
        failureReason: null,
        file: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        expiresAt: null,
        selected: ask.ids ? ask.ids.length : null,
      }
      store.jobs = [job, ...store.jobs]
      return job
    },
    readExport: async (jobId) => {
      const job = store.jobs.find((entry) => entry.id === jobId)
      if (!job) throw new ToolsError('notFound')
      if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return job
      const total = job.selected ?? model.exportRows ?? 1240
      const done = Math.min(total, job.rowsDone + 400)
      const next: ExportJob =
        done >= total && job.status === 'RUNNING'
          ? { ...job, status: 'DONE', rowsDone: total, rowCount: total, file: { id: id('cccc'), name: `ordini-di-vendita-demo.${job.format === 'CSV' ? 'csv' : 'xlsx'}`, sizeBytes: total * 86 }, finishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }
          : { ...job, status: 'RUNNING', rowsDone: job.status === 'QUEUED' ? 0 : done, startedAt: job.startedAt ?? new Date().toISOString() }
      store.jobs = store.jobs.map((entry) => (entry.id === jobId ? next : entry))
      return next
    },
    listExports: async (listKey) => store.jobs.filter((job) => job.listKey === listKey),
    download: async () => undefined,
    copy: async () => true,
    readLayout: (listKey) => store.layouts.get(listKey) ?? null,
    writeLayout: (listKey, layout) => {
      if (layout) store.layouts.set(listKey, layout)
      else store.layouts.delete(listKey)
    },
    newKey: () => id('dddd'),
    ...(model.design ? { design: model.design } : {}),
    bulkPreview: async (ask) => {
      if (!model.bulk) throw new ToolsError('offline')
      await pause()
      return ask.ids.map((rowId) => {
        const row = store.bulk.get(rowId)
        return row ? previewRow(row, ask.changes) : missingRow(rowId)
      })
    },
    bulkApply: async (ask) => {
      if (!model.bulk) throw new ToolsError('offline')
      await pause()
      return ask.rows.map((asked): BulkResult => {
        const row = store.bulk.get(asked.id)
        if (!row) return { id: asked.id, label: '', ok: false, refusal: { code: 'missing' }, before: {}, after: {}, version: 0 }
        const before = Object.fromEntries(Object.keys(asked.changes).map((field) => [field, row.values[field] ?? null]))
        const refusal = model.bulkFails ? { code: 'failed' as const } : row.version !== asked.version ? { code: 'stale' as const } : (previewRow(row, asked.changes).refusal ?? null)
        if (refusal) return { id: row.id, label: row.label, ok: false, refusal, before, after: before, version: row.version }
        const next: BulkRowFacts = { ...row, version: row.version + 1, values: { ...row.values, ...asked.changes } }
        store.bulk.set(row.id, next)
        return { id: row.id, label: row.label, ok: true, refusal: null, before, after: { ...asked.changes }, version: next.version }
      })
    },
  }
}
