'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { recordAddress } from '../../../lib/records/record-links'
import { useLiveChanges } from '../../../record-panels/live'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { readProblem, writeProblem, type Notice } from '../library/model'
import {
  activeColours,
  colourCounts,
  createColour,
  createSet,
  findBrands,
  getSet,
  listColours,
  listSets,
  openDocument,
  packagingMaterials,
  setColourStatus,
  setSetStatus,
  updateColour,
  updateSet,
  uploadColourPhoto,
  uploadSetFile,
} from './api'
import {
  colourDraftOf,
  coloursCan,
  createBodyOf,
  DISMISSED_STORE,
  filtersOf,
  searchOf,
  setChangesOf,
  setDraftOf,
  updateBodyOf,
  type ColourFilters,
  type ColourLibraryRow,
} from './model'
import type { ColourFormModel, ColoursViewModel, NewSetModel, SetModalModel } from './view-model'
import { ColoursView } from './view/ColoursView'

const readDismissed = (): string[] => {
  try {
    const value = JSON.parse(window.localStorage.getItem(DISMISSED_STORE) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(-50) : []
  } catch {
    return []
  }
}
const keepDismissed = (keys: string[]) => {
  try {
    window.localStorage.setItem(DISMISSED_STORE, JSON.stringify(keys.slice(-50)))
  } catch {
    // A private window or blocked storage: the notice comes back next time.
  }
}

/**
 * `/w/<company>/products/colours` (SCR-118): reads the colour library (product.styles.view; pages of 50), the tiles and the
 * facts, the branding sets; keeps live colour.* / branding_set.* / file changes behind "N updates · Show"; writes through
 * the API (every write one command at its version) and reads again. `?open=<set>` opens a set's DetailModal, `?new=colour`
 * New colour, `?new=set` New branding set.
 */
export function ColoursPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => coloursCan(session.permissions), [session.permissions])
  const filters = useMemo(() => filtersOf(params), [params])
  const openId = params?.get('open') ?? null
  const asked = params?.get('new') ?? null
  const prefix = pathname.replace(/\/products\/colours\/?$/, '')
  const companyId = session.company?.id ?? null

  const [rows, setRows] = useState<ColoursViewModel['rows']>({ items: null, more: false, count: null, problem: null, ignored: [], families: [] })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<ColoursViewModel['counts']>(null)
  const [countsFailed, setCountsFailed] = useState(false)
  const [sets, setSets] = useState<ColoursViewModel['sets']>({ items: null, problem: null })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [colourForm, setColourForm] = useState<ColourFormModel | null>(null)
  const [setModal, setSetModal] = useState<SetModalModel | null>(null)
  const [newSet, setNewSet] = useState<NewSetModel | null>(null)
  const readSeq = useRef(0)
  useEffect(() => setDismissed(readDismissed()), [])

  const address = useCallback((next: ColourFilters, extra: { open?: string | null; new?: 'colour' | 'set' | null } = {}) => `${pathname}${searchOf(next, extra)}`, [pathname])

  const load = useCallback(async () => {
    const mine = ++readSeq.current
    setRows((current) => ({ ...current, items: null, problem: null }))
    try {
      const page = await listColours(api, { view: filters.view, q: filters.q.trim() || undefined, system: filters.system || undefined, family: filters.family || undefined, limit: 50 })
      if (mine !== readSeq.current) return
      setRows({ items: page.colours, more: page.nextCursor !== null, count: page.count, problem: null, ignored: page.ignored, families: page.families })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (mine === readSeq.current) setRows({ items: null, more: false, count: null, problem: readProblem(error), ignored: [], families: [] })
    }
  }, [api, filters.view, filters.q, filters.system, filters.family])

  const loadCounts = useCallback(() => {
    colourCounts(api)
      .then((value) => {
        setCounts(value)
        setCountsFailed(false)
      })
      .catch(() => setCountsFailed(true))
  }, [api])

  const loadSets = useCallback(() => {
    listSets(api, filters.sets)
      .then((items) => setSets({ items, problem: null }))
      .catch((error: unknown) => setSets({ items: null, problem: readProblem(error) }))
  }, [api, filters.sets])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    loadCounts()
  }, [loadCounts])
  useEffect(() => {
    loadSets()
  }, [loadSets])

  useLiveChanges({
    onChange: (change) => {
      if (change.type.startsWith('colour.') || change.type.startsWith('branding_set.') || change.type === 'file.available') setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const refresh = () => {
    void load()
    loadCounts()
    loadSets()
  }

  const more = async () => {
    if (!cursor) return
    try {
      const page = await listColours(api, { view: filters.view, q: filters.q.trim() || undefined, system: filters.system || undefined, family: filters.family || undefined, cursor, limit: 50 })
      setRows((current) => ({ ...current, items: [...(current.items ?? []), ...page.colours], more: page.nextCursor !== null, count: page.count }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ key: readProblem(error), tone: 'danger' })
    }
  }

  // ---- colours ------------------------------------------------------------------------------------------------------

  const openColourForm = (mode: 'new' | 'edit' | null, row?: ColourLibraryRow) => {
    if (!mode) {
      setColourForm(null)
      if (asked === 'colour') router.replace(address(filters))
      return
    }
    const companies = session.companies.map((company) => ({ id: company.id, name: company.name }))
    setColourForm({
      mode,
      row: row ?? null,
      draft: colourDraftOf(row ?? null, companyId),
      companies,
      // A colour of every company asks a grant over every company: offered when the person works in every company they see.
      everyCompany: session.companies.length > 1 || companyId === null,
      busy: false,
      problem: null,
      refused: [],
      messages: [],
      photo: { busy: false, problem: null },
    })
  }

  useEffect(() => {
    if (asked === 'colour' && can.colours && !colourForm) openColourForm('new')
    if (asked === 'set' && can.branding && !newSet) openNewSet(true)
    // Only when the address asks.
  }, [asked])

  const saveColour = async () => {
    const form = colourForm
    if (!form) return
    setColourForm({ ...form, busy: true, problem: null, refused: [], messages: [] })
    try {
      if (form.mode === 'new') {
        const created = await createColour(api, createBodyOf(form.draft))
        setNotice({ key: 'notice.created', tone: 'success', params: { code: created.code } })
      } else if (form.row) {
        const body = updateBodyOf(form.row, form.draft)
        if (body) await updateColour(api, form.row.id, body)
        setNotice({ key: 'notice.saved', tone: 'success', params: { code: form.row.code } })
      }
      openColourForm(null)
      refresh()
    } catch (error) {
      const problem = writeProblem(error)
      setColourForm((current) => (current ? { ...current, busy: false, problem: problem.key, refused: problem.paths, messages: problem.messages } : current))
    }
  }

  const sendPhoto = async (file: File) => {
    const row = colourForm?.row
    if (!row) return
    setColourForm((current) => (current ? { ...current, photo: { busy: true, problem: null } } : current))
    try {
      await uploadColourPhoto(api, row, file)
      const page = await listColours(api, { view: 'all', q: row.code, limit: 5 })
      const fresh = page.colours.find((entry) => entry.id === row.id) ?? row
      setColourForm((current) => (current ? { ...current, row: fresh, photo: { busy: false, problem: null } } : current))
      refresh()
    } catch (error) {
      setColourForm((current) => (current ? { ...current, photo: { busy: false, problem: writeProblem(error).key } } : current))
    }
  }

  const archiveColours = async (ids: string[], to: 'archive' | 'restore', reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const id of ids) {
        const row = (rows.items ?? []).find((entry) => entry.id === id)
        if (!row) continue
        await setColourStatus(api, row, to, reason || undefined)
        done++
      }
      setNotice({ key: to === 'archive' ? 'notice.archived' : 'notice.restored', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger' })
      return false
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const saved = useCallback((rowId: string, after: Readonly<Record<string, string | number | null>>, version: number) => {
    setRows((current) => ({
      ...current,
      items:
        current.items?.map((row) => {
          if (row.id !== rowId) return row
          const text = (key: string, value: string | null) => (key in after ? ((after[key] as string | null) ?? null) : value)
          return {
            ...row,
            name: typeof after.name === 'string' ? after.name : row.name,
            system: text('system', row.system) as ColourLibraryRow['system'],
            reference: text('reference', row.reference),
            family: text('family', row.family),
            hex: text('hex', row.hex),
            version,
          }
        }) ?? null,
    }))
  }, [])

  // ---- branding sets ------------------------------------------------------------------------------------------------

  const setModalId = setModal?.id ?? null
  useEffect(() => {
    if (!openId) {
      setSetModal(null)
      return
    }
    if (setModalId === openId) return
    const controller = new AbortController()
    const base: SetModalModel = { id: openId, set: null, problem: null, draft: null, colours: null, materials: null, busy: false, saveProblem: null, refused: [], messages: [], uploading: null, uploadProblem: null, confirm: null }
    setSetModal(base)
    getSet(api, openId, controller.signal)
      .then((set) => setSetModal((current) => (current?.id === openId ? { ...current, set, draft: setDraftOf(set) } : current)))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSetModal((current) => (current?.id === openId ? { ...current, problem: readProblem(error) } : current))
      })
    if (can.branding) {
      activeColours(api, controller.signal)
        .then((colours) => setSetModal((current) => (current?.id === openId ? { ...current, colours } : current)))
        .catch(() => undefined)
      if (can.materials)
        packagingMaterials(api, controller.signal)
          .then((materials) => setSetModal((current) => (current?.id === openId ? { ...current, materials } : current)))
          .catch(() => undefined)
    }
    return () => controller.abort()
  }, [openId, api, can.branding, can.materials])

  const openSet = (id: string | null) => router.replace(address(filters, { open: id }))

  const saveSet = async () => {
    const modal = setModal
    if (!modal?.set || !modal.draft) return
    const body = setChangesOf(modal.set, modal.draft)
    if (!body) return
    setSetModal({ ...modal, busy: true, saveProblem: null, refused: [], messages: [] })
    try {
      const set = await updateSet(api, modal.id, body)
      setSetModal((current) => (current?.id === modal.id ? { ...current, set, draft: setDraftOf(set), busy: false } : current))
      setNotice({ key: 'notice.setSaved', tone: 'success', params: { code: set.code } })
      loadSets()
      loadCounts()
    } catch (error) {
      const problem = writeProblem(error)
      setSetModal((current) => (current?.id === modal.id ? { ...current, busy: false, saveProblem: problem.key, refused: problem.paths, messages: problem.messages } : current))
    }
  }

  const sendSetFile = async (file: File, role: 'LOGO' | 'ARTWORK') => {
    const modal = setModal
    if (!modal?.set) return
    setSetModal({ ...modal, uploading: file.name, uploadProblem: null })
    try {
      const before = new Set(modal.set.files.map((entry) => entry.fileId))
      const set = await uploadSetFile(api, modal.set, file, role)
      const added = set.files.filter((entry) => !before.has(entry.fileId)).map((entry) => entry.fileId)
      setSetModal((current) => {
        if (current?.id !== modal.id) return current
        // The draft keeps what the person changed and takes the new file at the end of its list.
        const draft = current.draft ? { ...current.draft, ...(role === 'LOGO' ? { logoIds: [...current.draft.logoIds, ...added] } : { artworkIds: [...current.draft.artworkIds, ...added] }) } : setDraftOf(set)
        return { ...current, set, draft, uploading: null }
      })
      loadSets()
    } catch (error) {
      setSetModal((current) => (current?.id === modal.id ? { ...current, uploading: null, uploadProblem: writeProblem(error).key } : current))
    }
  }

  const changeSetStatus = async (to: 'archive' | 'restore', reason: string) => {
    const modal = setModal
    if (!modal?.set) return
    setSetModal({ ...modal, busy: true, saveProblem: null })
    try {
      const set = await setSetStatus(api, modal.set, to, reason || undefined)
      setSetModal((current) => (current?.id === modal.id ? { ...current, set, draft: setDraftOf(set), busy: false, confirm: null } : current))
      setNotice({ key: to === 'archive' ? 'notice.setArchived' : 'notice.setRestored', tone: 'success', params: { code: set.code } })
      loadSets()
      loadCounts()
    } catch (error) {
      const problem = writeProblem(error)
      setSetModal((current) => (current?.id === modal.id ? { ...current, busy: false, confirm: null, saveProblem: problem.key, messages: problem.messages } : current))
    }
  }

  const archiveSets = async (ids: string[], reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const id of ids) {
        const row = (sets.items ?? []).find((entry) => entry.id === id)
        if (!row || row.status !== 'ACTIVE') continue
        await setSetStatus(api, row, 'archive', reason || undefined)
        done++
      }
      setNotice({ key: 'notice.setsArchived', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger' })
      return false
    } finally {
      setBusy(false)
      loadSets()
      loadCounts()
    }
  }

  function openNewSet(open: boolean) {
    if (!open) {
      setNewSet(null)
      if (asked === 'set') router.replace(address(filters))
      return
    }
    setNewSet({ draft: { brand: null, code: '', name: '', replace: false }, search: { q: '', results: null }, busy: false, problem: null, refused: [], messages: [] })
    searchBrands('')
  }

  function searchBrands(q: string) {
    setNewSet((current) => (current ? { ...current, search: { q, results: null } } : current))
    findBrands(api, q)
      .then((results) => setNewSet((current) => (current && current.search.q === q ? { ...current, search: { q, results } } : current)))
      .catch(() => setNewSet((current) => (current ? { ...current, search: { q, results: [] } } : current)))
  }

  const createNewSet = async () => {
    const form = newSet
    if (!form?.draft.brand || !companyId) return
    setNewSet({ ...form, busy: true, problem: null, refused: [], messages: [] })
    try {
      const set = await createSet(api, { companyId, partyId: form.draft.brand.id, code: form.draft.code.trim(), name: form.draft.name.trim(), ...(form.draft.replace ? { replace: true } : {}) })
      setNewSet(null)
      setNotice({ key: 'notice.setCreated', tone: 'success', params: { code: set.code } })
      loadSets()
      loadCounts()
      router.replace(address(filters, { open: set.id }))
    } catch (error) {
      const problem = writeProblem(error)
      setNewSet((current) => (current ? { ...current, busy: false, problem: problem.key, refused: problem.paths, messages: problem.messages } : current))
    }
  }

  const model: ColoursViewModel = { prefix, companyId, can, filters, rows, counts, countsFailed, sets, asOf, updates, dismissed, notice, busy, colourForm, setModal, newSet }

  return (
    <ColoursView
      model={model}
      actions={{
        onFilters: (next) => router.replace(address(next, { open: openId })),
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: refresh,
        onOpenColour: (row) => router.push(`${prefix}${recordAddress({ type: 'Colour', id: row.id, label: row.code, companyId: row.companyId }, OFFICE_PAGES)}`),
        onSaved: saved,
        onDismissNotice: () => setNotice(null),
        onDismiss: (key) =>
          setDismissed((current) => {
            const next = [...current.filter((entry) => entry !== key), key]
            keepDismissed(next)
            return next
          }),
        onArchiveColours: archiveColours,
        onColourForm: openColourForm,
        onColourDraft: (draft) => setColourForm((current) => (current ? { ...current, draft, refused: [] } : current)),
        onSaveColour: () => void saveColour(),
        onPhoto: (file) => void sendPhoto(file),
        onOpenSet: openSet,
        onSetDraft: (draft) => setSetModal((current) => (current ? { ...current, draft, refused: [] } : current)),
        onDiscardSet: () => setSetModal((current) => (current?.set ? { ...current, draft: setDraftOf(current.set), saveProblem: null, refused: [] } : current)),
        onSaveSet: () => void saveSet(),
        onSetFile: (file, role) => void sendSetFile(file, role),
        onOpenDocument: (fileId) => {
          openDocument(api, fileId)
            .then((url) => window.open(url, '_blank', 'noopener'))
            .catch((error: unknown) => setNotice({ key: readProblem(error), tone: 'danger' }))
        },
        onSetConfirm: (confirm) => setSetModal((current) => (current ? { ...current, confirm } : current)),
        onSetStatus: (to, reason) => void changeSetStatus(to, reason),
        onArchiveSets: archiveSets,
        onRetrySets: loadSets,
        onNewSet: openNewSet,
        onNewSetDraft: (draft) => setNewSet((current) => (current ? { ...current, draft, refused: [] } : current)),
        onBrandSearch: searchBrands,
        onCreateSet: () => void createNewSet(),
      }}
    />
  )
}
