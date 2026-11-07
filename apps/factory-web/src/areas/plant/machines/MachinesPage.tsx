'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { createMachine, findSuppliers, listClasses, listMachines, machineTiles, plantPlaces, retireMachine, updateMachine, type Machine, type MachineClass, type MachineTiles, type PlantSite } from '../_shared/api'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import { costMinorOf, csvText, fieldOf, isMachineEvent, labelOf, machinesAddressOf, machinesAddressText, machinesQuery, minorText, plantCan, problemOf, readProblem, TIME_ZONE, yearOf, type MachinesAddress } from '../_shared/model'
import { useWords, type Loaded, type Notice } from '../_shared/parts'
import { readDepth, readNeeding, readWall, type MachineDepth, type WallAnswer } from './depth/api'
import { depthAddressOf, NEED_TERMS, PAGE_TERMS, withDepthTerms, type DepthAddress, type WallFilter } from './depth/model'
import { tagMachineOf, useTags } from './depth/use-tags'
import { DiesSection } from './dies/DiesSection'
import type { CellState, MachineDraft, MachineRows, MachinesDialog, MachinesListModel } from './view-model'
import { MachinesView } from './view/MachinesView'

/**
 * `/w/<company>/plant/machines` (SCR-150): the saved row (`?view=`), the search (`?q=`), the site (`?site=`), the type
 * (`?class=`), New machine (`?new=1`); pages of 50 with "Show more"; the tiles; live machine changes behind "N updates ·
 * Show". Station and work centre autosave inline with the machine's version; New machine creates through
 * `POST /plant/machines` and offers its tag; Retire N retires one by one with the reason.
 */
export function MachinesPage() {
  return <MachinesContainer />
}

const PAGE = 50

const blankDraft = (siteId: string | null): MachineDraft => ({ siteId, assetNumber: '', classId: null, make: '', modelName: '', serialNumber: '', year: '', stationId: null, workCentreId: null, supplier: null, cost: '', note: '' })

function MachinesContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const t = useWords()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => plantCan(session.permissions), [session.permissions])
  const address = useMemo(() => machinesAddressOf(params), [params])
  const { view, q, siteId, classId } = address
  // B-W2b-136: the section shown and the two tiles that filter; the dies' own `d…` terms are kept as they are.
  const depthAddress = useMemo(() => depthAddressOf(params), [params])
  const { section, need } = depthAddress

  const go = useCallback(
    (next: Partial<MachinesAddress>, nextDepth: Partial<DepthAddress> = {}) => {
      const text = withDepthTerms(machinesAddressText({ ...address, ...next }), { ...depthAddress, ...nextDepth })
      const query = new URLSearchParams(text.startsWith('?') ? text.slice(1) : text)
      params?.forEach((value, key) => {
        if (!(PAGE_TERMS as readonly string[]).includes(key)) query.set(key, value)
      })
      const all = query.toString()
      router.replace(`${pathname}${all ? `?${all}` : ''}`, { scroll: false })
    },
    [router, pathname, address, depthAddress, params],
  )

  const [sites, setSites] = useState<PlantSite[]>([])
  const [classes, setClasses] = useState<MachineClass[]>([])
  useEffect(() => {
    if (!can.view) return
    plantPlaces(api)
      .then(setSites)
      .catch(() => setSites([]))
    listClasses(api)
      .then((found) => setClasses(found.filter((entry) => entry.active)))
      .catch(() => setClasses([]))
  }, [api, can.view])

  const [rows, setRows] = useState<MachineRows>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [tiles, setTiles] = useState<MachineTiles | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [made, setMade] = useState<{ id: string; assetNumber: string } | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => machinesQuery({ view, q, siteId, classId }), [view, q, siteId, classId])
  const [facts, setFacts] = useState<Record<string, MachineDepth>>({})
  const [depthTiles, setDepthTiles] = useState<{ checksOverdue: number; noCe: number } | null>(null)
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10))
  const readFacts = useCallback(
    async (ids: readonly string[]) => {
      try {
        const answer = await readDepth(api, siteId, ids)
        setDepthTiles(answer.tiles)
        setToday(answer.today)
        setFacts((current) => ({ ...current, ...Object.fromEntries(answer.machines.map((row) => [row.id, row])) }))
      } catch {
        setDepthTiles(null)
      }
    },
    [api, siteId],
  )
  const page = useCallback(
    (cursor: string | null) => (need ? readNeeding(api, { siteId, need: NEED_TERMS[need], cursor, limit: PAGE }) : listMachines(api, { ...query, ...(cursor ? { cursor } : {}), limit: PAGE })),
    [api, need, siteId, query],
  )

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const read = await page(null)
      const counted = await machineTiles(api, siteId).catch(() => null)
      if (id !== readId.current) return
      setRows({ items: read.machines, more: read.nextCursor !== null, problem: null })
      setCursor(read.nextCursor)
      setTiles(counted)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      void readFacts(read.machines.map((row) => row.id))
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
      setTiles(null)
    }
  }, [api, can.view, page, siteId, readFacts])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const read = await page(cursor)
      setRows((current) => ({ items: [...(current.items ?? []), ...read.machines.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: read.nextCursor !== null, problem: null }))
      setCursor(read.nextCursor)
      void readFacts(read.machines.map((row) => row.id))
    } catch (error) {
      setNotice({ tone: 'danger', words: problemOf(error) })
    }
  }, [cursor, page, readFacts])

  // The status wall (section `wall`): read when shown, again on a machine's change.
  const [wall, setWall] = useState<Loaded<WallAnswer>>({ status: 'loading' })
  const [wallAt, setWallAt] = useState<string | null>(null)
  const [wallFilter, setWallFilter] = useState<WallFilter>('ALL')
  const wallTurn = useRef(0)
  const loadWall = useCallback(() => {
    if (!can.view || section !== 'wall') return
    const turn = ++wallTurn.current
    readWall(api, siteId)
      .then((value) => {
        if (turn !== wallTurn.current) return
        setWall({ status: 'ready', value })
        setWallAt(value.at)
      })
      .catch((error: unknown) => turn === wallTurn.current && setWall({ status: 'error', problem: readProblem(error) }))
  }, [api, can.view, section, siteId])
  useEffect(() => {
    loadWall()
  }, [loadWall])
  const refreshWall = useCoalesced(loadWall, 1000)

  // Print QR tags (the band, the bulk bar, `t`, a row's ⋯).
  const canPrint = session.permissions.includes('print.labels')
  const { tags, openTags, closeTags, setPrinter, setCopies, printTagsNow, retryTag } = useTags(api, locale, () => void readFacts((rows.items ?? []).map((row) => row.id)))

  const refreshTiles = useCoalesced(() => {
    machineTiles(api, siteId)
      .then(setTiles)
      .catch(() => undefined)
  }, 1000)
  const live = useLive(
    (change) => {
      if (!isMachineEvent(change.type)) return
      if (change.type.startsWith('machine.')) setUpdates((count) => count + 1)
      refreshTiles()
      refreshWall()
    },
    () => {
      void load()
      loadWall()
    },
    can.view,
  )

  // ---- inline place ---------------------------------------------------------------------------------------------------------
  const [cells, setCells] = useState<Record<string, CellState>>({})
  const place = useCallback(
    async (machine: Machine, change: { stationId?: string | null; workCentreId?: string | null }) => {
      const field = 'stationId' in change ? 'stationId' : 'workCentreId'
      const key = `${machine.id}:${field}`
      setCells((current) => ({ ...current, [key]: { state: 'saving' } }))
      try {
        const saved = await updateMachine(api, machine.id, { version: machine.version, ...change })
        setRows((current) => ({ ...current, items: current.items?.map((row) => (row.id === saved.id ? saved : row)) ?? null }))
        setCells((current) => ({ ...current, [key]: { state: 'saved' } }))
      } catch (error) {
        setCells((current) => ({ ...current, [key]: { state: 'failed', words: problemOf(error) } }))
        setNotice({ tone: 'danger', words: { key: 'cell.refusedMachine', params: { machine: machine.assetNumber } }, detail: problemOf(error) })
      }
    },
    [api],
  )

  // ---- dialogs --------------------------------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<MachinesDialog | null>(null)
  const oneSite = sites.length === 1 ? sites[0]!.id : null
  useEffect(() => {
    if (address.isNew && can.view) setDialog((current) => (current?.kind === 'new' ? current : { kind: 'new', draft: blankDraft(siteId ?? oneSite), suppliers: null, busy: false, problem: null, field: null }))
    else setDialog((current) => (current?.kind === 'new' ? null : current))
  }, [address.isNew, can.view, siteId, oneSite])
  // One site only: it is chosen as soon as the sites are known.
  useEffect(() => {
    if (dialog?.kind === 'new' && !dialog.draft.siteId && oneSite) setDialog({ ...dialog, draft: { ...dialog.draft, siteId: oneSite } })
  }, [dialog, oneSite])

  const findSupplier = useCallback(
    (text: string) => {
      if (!can.parties || text.trim().length < 2) {
        setDialog((current) => (current?.kind === 'new' ? { ...current, suppliers: null } : current))
        return
      }
      findSuppliers(api, text)
        .then((found) => setDialog((current) => (current?.kind === 'new' ? { ...current, suppliers: found } : current)))
        .catch(() => setDialog((current) => (current?.kind === 'new' ? { ...current, suppliers: [] } : current)))
    },
    [api, can.parties],
  )

  const submitDialog = useCallback(async () => {
    if (!dialog || dialog.busy) return
    if (dialog.kind === 'new') {
      const draft = dialog.draft
      setDialog({ ...dialog, busy: true, problem: null, field: null })
      try {
        const cost = costMinorOf(draft.cost)
        const machine = await createMachine(api, {
          siteId: draft.siteId!,
          assetNumber: draft.assetNumber.trim().toUpperCase(),
          classId: draft.classId!,
          ...(draft.make.trim() ? { make: draft.make.trim() } : {}),
          ...(draft.modelName.trim() ? { modelName: draft.modelName.trim() } : {}),
          ...(draft.serialNumber.trim() ? { serialNumber: draft.serialNumber.trim() } : {}),
          ...(yearOf(draft.year) ? { year: yearOf(draft.year)! } : {}),
          ...(draft.stationId ? { stationId: draft.stationId } : {}),
          ...(draft.workCentreId ? { workCentreId: draft.workCentreId } : {}),
          ...(draft.supplier ? { supplierId: draft.supplier.id } : {}),
          ...(can.cost && typeof cost === 'number' ? { purchaseCost: cost } : {}),
          ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
        })
        setDialog(null)
        setMade({ id: machine.id, assetNumber: machine.assetNumber })
        go({ isNew: false })
        void load()
      } catch (error) {
        // A create has one conflict: the asset number is taken (every tag carries its own).
        const taken = isApiError(error) && error.kind === 'conflict'
        setDialog((current) => (current?.kind === 'new' ? { ...current, busy: false, problem: taken ? { key: 'problem.assetTaken' } : problemOf(error), field: taken ? 'assetNumber' : fieldOf(error) } : current))
      }
      return
    }
    // Retire, one by one: a machine with open work is refused in words; the others are retired.
    setDialog({ ...dialog, busy: true, problem: null, refused: [] })
    const refused: { assetNumber: string; words: Notice['words'] }[] = []
    let done = 0
    for (const machine of dialog.machines) {
      try {
        await retireMachine(api, machine.id, { version: machine.version, reason: dialog.reason.trim() })
        done += 1
      } catch (error) {
        refused.push({ assetNumber: machine.assetNumber, words: problemOf(error) })
      }
    }
    void load()
    if (refused.length === 0) {
      setDialog(null)
      setNotice({ tone: 'success', words: { key: 'done.retired', params: { count: done } } })
    } else {
      setDialog((current) => (current?.kind === 'retire' ? { ...current, busy: false, refused, machines: current.machines.filter((machine) => refused.some((entry) => entry.assetNumber === machine.assetNumber)) } : current))
      if (done > 0) setNotice({ tone: 'success', words: { key: 'done.retired', params: { count: done } } })
    }
  }, [dialog, api, can.cost, go, load])

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = ['asset', 'site', 'type', 'make', 'model', 'serial', 'year', 'line', 'station', 'workCentre', 'status', 'openJobs', 'openRequests', ...(can.cost ? ['cost'] : [])].map((column) => t(`csvMachine.${column}`))
      const lines = picked.map((row) => [
        row.assetNumber,
        row.siteCode,
        labelOf(row.class, locale),
        row.make ?? '',
        row.modelName ?? '',
        row.serialNumber ?? '',
        row.year ?? '',
        row.line?.code ?? '',
        row.station?.code ?? '',
        row.workCentre?.code ?? '',
        t(`machineStatus.${row.status}`),
        row.openJobs,
        row.openRequests,
        ...(can.cost ? [minorText(row.purchaseCost)] : []),
      ])
      downloadText(`machines-${new Date().toISOString().slice(0, 10)}.csv`, csvText(header, lines))
    },
    [rows.items, can.cost, locale, t],
  )

  const model: MachinesListModel = {
    prefix,
    can,
    address: { view, q, siteId, classId },
    sites,
    classes,
    rows,
    tiles,
    asOf,
    live,
    updates,
    timeZone: TIME_ZONE,
    cells,
    dialog,
    notice,
    made,
    depth: {
      address: depthAddress,
      tiles: depthTiles,
      facts,
      today,
      wall: { loaded: wall, filter: wallFilter, asOf: wallAt },
      tags,
      canPrint,
      dies: section === 'dies' ? <DiesSection prefix={prefix} siteId={siteId} sites={sites} /> : undefined,
    },
  }

  return (
    <MachinesView
      model={model}
      actions={{
        onView: (next) => go({ view: next }, { need: null }),
        onSearch: (next) => go({ q: next }),
        onSite: (next) => go({ siteId: next }),
        onClass: (next) => go({ classId: next }),
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/plant/machines/${encodeURIComponent(id)}`),
        onPlace: (machine, change) => void place(machine, change),
        onNew: () => {
          setMade(null)
          go({ isNew: true })
        },
        onRetire: (machines) => setDialog({ kind: 'retire', machines, reason: '', busy: false, problem: null, refused: [] }),
        onDialogClose: () => {
          if (dialog?.kind === 'new') go({ isNew: false })
          setDialog(null)
        },
        onDraft: (patch) => setDialog((current) => (current?.kind === 'new' ? { ...current, draft: { ...current.draft, ...patch }, field: null } : current)),
        onFindSupplier: findSupplier,
        onRetireReason: (reason) => setDialog((current) => (current?.kind === 'retire' ? { ...current, reason } : current)),
        onSubmitDialog: () => void submitDialog(),
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
        onSection: (next) => go({ isNew: false }, { section: next }),
        onNeed: (next) => go({ view: 'inUse' }, { need: next }),
        onWallFilter: setWallFilter,
        onRetryWall: loadWall,
        onOpenTags: (machines) => openTags(machines.map((machine) => tagMachineOf(machine, locale)), canPrint),
        onTagPrinter: setPrinter,
        onTagCopies: setCopies,
        onTagPrint: () => void printTagsNow(),
        onTagRetry: (job) => void retryTag(job),
        onTagsClose: closeTags,
      }}
    />
  )
}
