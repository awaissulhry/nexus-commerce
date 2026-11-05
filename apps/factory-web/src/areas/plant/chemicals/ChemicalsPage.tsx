'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../_shared/hooks'
import { addChemical, archiveChemical, editChemical, listChemicals, readCabinets, readChemical, readChoices, readCounts, readLibrary, restoreChemical, sheetBytes, uploadSheet, type ChemicalRecord, type CountsAnswer, type LibraryAnswer, type ListAnswer } from './api'
import {
  addressOf,
  addressText,
  bodyOf,
  chemicalsCan,
  draftOf,
  EMPTY_DRAFT,
  factsOf,
  firstSheet,
  isChemicalsChange,
  problemOf,
  readProblemOf,
  sheetDraft,
  withAddress,
  type ChemicalDraft,
  type ChemicalsAddress,
  type SheetDraft,
} from './model'
import type { AddState, ArchiveManyState, OpenState, PageNotice, QrState, Read } from './view-model'
import { ChemicalsPageView } from './view/ChemicalsPageView'

type Section = 'counts' | 'register' | 'library'

/** Today in the factory's zone (Europe/Rome), the guards' "today". */
const todayInRome = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * `/w/<company>/plant/chemicals` (SCR-213; B-W2b-143; design plant.chemicals): three reads — the tiles (GET
 * /safety/chemicals/counts), the register (GET /safety/chemicals, the address's filters) and the SDS library (GET
 * /safety/chemicals/data-sheets) — each loading and failing on its own, all with the top bar's site. Every dialog lives in
 * the address (`model.ts` addressOf): Add chemical (`?new=1`), the chemical's window (`?open=<id>&do=edit|replace|archive`),
 * Print cabinet QR (`?qr=1`). A PDF to send stays in this container (a File is no address); the window reads a sheet's bytes
 * once for the viewer. Live: chemical.changed and sds.replaced read the parts they move again (coalesced).
 */
export function ChemicalsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/plant\/chemicals\/?$/, '')
  const can = useMemo(() => chemicalsCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null
  const [today] = useState(todayInRome)
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])

  const [counts, setCounts] = useState<Read<CountsAnswer>>({ status: 'loading' })
  const [register, setRegister] = useState<Read<ListAnswer>>({ status: 'loading' })
  const [library, setLibrary] = useState<Read<LibraryAnswer>>({ status: 'loading' })
  const [readAt, setReadAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [add, setAdd] = useState<AddState | null>(null)
  const [open, setOpen] = useState<OpenState | null>(null)
  const [archiveMany, setArchiveMany] = useState<ArchiveManyState | null>(null)
  const [qr, setQr] = useState<QrState | null>(null)
  const addFile = useRef<File | null>(null)
  const replaceFile = useRef<File | null>(null)
  const turns = useRef<Record<Section, number>>({ counts: 0, register: 0, library: 0 })

  const settle = useCallback(<T,>(section: Section, set: (read: Read<T>) => void, reading: Promise<T>) => {
    const turn = ++turns.current[section]
    return reading.then(
      (value) => {
        if (turn === turns.current[section]) set({ status: 'ready', value })
      },
      (error: unknown) => {
        if (turn === turns.current[section]) set({ status: 'error', problem: readProblemOf(error) })
      },
    )
  }, [])

  const readCountsNow = useCallback(() => (can.view ? settle('counts', setCounts, readCounts(api, siteId)) : Promise.resolve()), [api, can.view, settle, siteId])
  const { tile, status, use, cabinet, q } = address
  const readRegisterNow = useCallback(
    () =>
      can.view
        ? settle('register', setRegister, listChemicals(api, { siteId, status, tile, use, cabinet, q }).then((answer) => {
            setReadAt(new Date().toISOString())
            return answer
          }))
        : Promise.resolve(),
    [api, can.view, settle, siteId, status, tile, use, cabinet, q],
  )
  const readLibraryNow = useCallback(() => (can.view ? settle('library', setLibrary, readLibrary(api, siteId)) : Promise.resolve()), [api, can.view, settle, siteId])

  useEffect(() => {
    setCounts({ status: 'loading' })
    void readCountsNow()
  }, [readCountsNow])
  useEffect(() => {
    setRegister({ status: 'loading' })
    void readRegisterNow()
  }, [readRegisterNow])
  useEffect(() => {
    setLibrary({ status: 'loading' })
    void readLibraryNow()
  }, [readLibraryNow])

  const go = useCallback((change: Partial<ChemicalsAddress>) => router.replace(`${pathname}${addressText(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  // ---- the chemical's window -------------------------------------------------------------------------------------------------

  const readOpen = useCallback(
    async (id: string) => {
      try {
        const record = await readChemical(api, id)
        setOpen((current) => (current && current.id === id ? { ...current, read: { status: 'ready', value: record } } : current))
        return record
      } catch (error) {
        setOpen((current) => (current && current.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current))
        return null
      }
    },
    [api],
  )

  const showSheet = useCallback(
    async (record: ChemicalRecord, sheetId: string) => {
      setOpen((current) => (current && current.id === record.chemical.id ? { ...current, pdf: { sheetId, read: { status: 'loading' } } } : current))
      try {
        const pdf = await sheetBytes(api, record.chemical.id, sheetId)
        setOpen((current) => (current && current.id === record.chemical.id && current.pdf?.sheetId === sheetId ? { ...current, pdf: { sheetId, read: { status: 'ready', value: pdf } } } : current))
      } catch (error) {
        setOpen((current) => (current && current.id === record.chemical.id && current.pdf?.sheetId === sheetId ? { ...current, pdf: { sheetId, read: { status: 'error', problem: readProblemOf(error) } } } : current))
      }
    },
    [api],
  )

  // The address opens and closes the window; a new id starts afresh and reads it, then its first sheet's PDF.
  useEffect(() => {
    if (!address.open || !can.view) {
      setOpen(null)
      return
    }
    const id = address.open
    setOpen((current) => (current && current.id === id ? current : { id, read: { status: 'loading' }, mode: 'view', draft: null, choices: null, sheet: sheetDraft('it'), reason: '', busy: false, problem: null, pdf: null, saved: null }))
    if (open?.id === id) return
    void readOpen(id).then((record) => {
      if (!record) return
      setOpen((current) => (current && current.id === id ? { ...current, sheet: sheetDraft(record.chemical.language) } : current))
      const sheet = (address.sheet && record.sheets.find((row) => row.id === address.sheet)) || firstSheet(record.chemical)
      if (sheet) void showSheet(record, sheet.id)
    })
  }, [address.open, can.view])

  // The window's mode follows the address: Edit loads its draft and the site's choices; Replace SDS a fresh sheet draft.
  const record = open?.read.status === 'ready' ? open.read.value : null
  useEffect(() => {
    if (!open || !record) return
    const mode = address.mode
    if (mode === open.mode) return
    replaceFile.current = null
    setOpen((current) => (current ? { ...current, mode, problem: null, saved: mode === 'view' ? current.saved : null, reason: '', draft: mode === 'edit' ? draftOf(record.chemical) : null, sheet: sheetDraft(record.chemical.language), choices: mode === 'edit' ? { status: 'loading' } : current.choices } : current))
    if (mode === 'edit' && can.manage) {
      readChoices(api, record.chemical.siteId).then(
        (choices) => setOpen((current) => (current ? { ...current, choices: { status: 'ready', value: choices } } : current)),
        (error) => setOpen((current) => (current ? { ...current, choices: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    }
  }, [address.mode, record, open, api, can.manage])

  // ---- Add chemical ----------------------------------------------------------------------------------------------------------

  const loadAddChoices = useCallback(
    (site: string | null) => {
      if (!site || !can.manage) return
      setAdd((current) => (current ? { ...current, choices: { status: 'loading' } } : current))
      readChoices(api, site).then(
        (choices) => setAdd((current) => (current && current.draft.siteId === site ? { ...current, choices: { status: 'ready', value: choices } } : current)),
        (error) => setAdd((current) => (current && current.draft.siteId === site ? { ...current, choices: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api, can.manage],
  )

  const companyLanguage = register.status === 'ready' ? (register.value.companies.find((company) => company.id === companyId)?.language ?? 'it') : 'it'
  useEffect(() => {
    if (!address.add || !can.manage) {
      setAdd(null)
      addFile.current = null
      return
    }
    setAdd((current) => current ?? { draft: { ...EMPTY_DRAFT, siteId }, sheet: sheetDraft(companyLanguage), choices: null, busy: false, problem: null, addedWithoutSheet: null })
    loadAddChoices(siteId)
  }, [address.add, can.manage])

  // ---- Print cabinet QR ------------------------------------------------------------------------------------------------------

  const readQr = useCallback(() => {
    setQr((current) => ({ cabinets: { status: 'loading' }, chosen: current?.chosen ?? null }))
    readCabinets(api, siteId).then(
      (cabinets) => setQr((current) => ({ cabinets: { status: 'ready', value: cabinets }, chosen: current?.chosen && cabinets.some((row) => `${row.siteId}|${row.code}` === current.chosen) ? current.chosen : cabinets[0] ? `${cabinets[0].siteId}|${cabinets[0].code}` : null })),
      (error) => setQr((current) => ({ cabinets: { status: 'error', problem: readProblemOf(error) }, chosen: current?.chosen ?? null })),
    )
  }, [api, siteId])
  useEffect(() => {
    if (!address.qr || !can.view) return setQr(null)
    readQr()
  }, [address.qr, can.view, readQr])

  // ---- live ------------------------------------------------------------------------------------------------------------------

  const readersRef = useRef({ readCountsNow, readRegisterNow, readLibraryNow })
  readersRef.current = { readCountsNow, readRegisterNow, readLibraryNow }
  const openRef = useRef(open)
  openRef.current = open
  const flush = useCoalesced(() => {
    void readersRef.current.readCountsNow()
    void readersRef.current.readRegisterNow()
    void readersRef.current.readLibraryNow()
  }, 800)
  useLive(
    (change) => {
      if (!isChemicalsChange(change)) return
      flush()
      const current = openRef.current
      if (current && !current.busy && current.mode === 'view' && change.fields.chemicalId === current.id) void readOpen(current.id)
    },
    flush,
    can.view,
  )

  const rereadAll = () => {
    void readCountsNow()
    void readRegisterNow()
    void readLibraryNow()
  }

  // ---- writes ----------------------------------------------------------------------------------------------------------------

  const saveAdd = async () => {
    if (!add || add.busy || !companyId) return
    const site = add.draft.siteId
    if (!site) return
    setAdd({ ...add, busy: true, problem: null })
    const key = newIdempotencyKey()
    let chemical
    try {
      chemical = await addChemical(api, { ...bodyOf(add.draft), companyId, siteId: site }, key)
    } catch (error) {
      setAdd((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
      return
    }
    const file = addFile.current
    if (file && add.sheet.file) {
      try {
        await uploadSheet(api, chemical.id, file, factsOf(add.sheet), `${key}:sds`)
      } catch (error) {
        // The chemical is in the register: its sheet is said refused and offered again on its record (Replace SDS).
        setAdd((current) => (current ? { ...current, busy: false, problem: problemOf(error), addedWithoutSheet: chemical.id } : current))
        rereadAll()
        return
      }
    }
    addFile.current = null
    setNotice({ tone: 'success', key: 'notice.added', params: { name: chemical.name } })
    rereadAll()
    go({ add: false, open: chemical.id })
  }

  const saveEdit = async () => {
    if (!open || !record || !open.draft || open.busy) return
    setOpen({ ...open, busy: true, problem: null })
    try {
      const chemical = await editChemical(api, record.chemical.id, { ...bodyOf(open.draft), version: record.chemical.version }, newIdempotencyKey())
      setOpen((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: { ...record, chemical } }, saved: { key: 'saved.edited' } } : current))
      rereadAll()
      go({ mode: 'view' })
    } catch (error) {
      setOpen((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const replace = async () => {
    const file = replaceFile.current
    if (!open || !record || !file || open.busy) return
    setOpen({ ...open, busy: true, problem: null })
    try {
      const added = await uploadSheet(api, record.chemical.id, file, factsOf(open.sheet), newIdempotencyKey())
      replaceFile.current = null
      const fresh = await readChemical(api, record.chemical.id)
      setOpen((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: fresh }, saved: added.superseded ? { key: 'saved.replaced', params: { version: added.sheet.versionLabel, old: added.superseded.versionLabel } as Record<string, string> } : { key: 'saved.firstSheet', params: { version: added.sheet.versionLabel } as Record<string, string> } } : current))
      void showSheet(fresh, added.sheet.id)
      rereadAll()
      go({ mode: 'view', sheet: added.sheet.id })
    } catch (error) {
      setOpen((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const setStatus = async (to: 'ARCHIVED' | 'ACTIVE') => {
    if (!open || !record || open.busy) return
    setOpen({ ...open, busy: true, problem: null })
    try {
      const chemical = to === 'ARCHIVED' ? await archiveChemical(api, record.chemical.id, { version: record.chemical.version, reason: open.reason.trim() }, newIdempotencyKey()) : await restoreChemical(api, record.chemical.id, { version: record.chemical.version }, newIdempotencyKey())
      setOpen((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: { ...record, chemical } }, saved: { key: to === 'ARCHIVED' ? 'saved.archived' : 'saved.restored' } } : current))
      rereadAll()
      go({ mode: 'view' })
    } catch (error) {
      setOpen((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  /** Archive N: each chosen chemical at the version the register read, one call each; what was refused is said. */
  const applyArchiveMany = async () => {
    if (!archiveMany || archiveMany.busy || register.status !== 'ready') return
    setArchiveMany({ ...archiveMany, busy: true })
    let done = 0
    const refused: { label: string; key: string }[] = []
    for (const id of archiveMany.ids) {
      const row = register.value.chemicals.find((chemical) => chemical.id === id)
      if (!row) continue
      try {
        await archiveChemical(api, row.id, { version: row.version, reason: archiveMany.reason.trim() }, newIdempotencyKey())
        done += 1
      } catch (error) {
        refused.push({ label: row.name, key: problemOf(error).key })
      }
    }
    setArchiveMany(null)
    setSelected([])
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'bulk.archivedResult', params: { count: done }, refused })
    rereadAll()
  }

  return (
    <ChemicalsPageView
      model={{
        prefix,
        can,
        scope,
        companyId,
        address,
        today,
        origin,
        counts: can.view ? counts : { status: 'loading' },
        register: can.view ? register : { status: 'loading' },
        library: can.view ? library : { status: 'loading' },
        readAt,
        notice,
        selected,
        add,
        open,
        archiveMany,
        qr,
      }}
      actions={{
        onAddress: go,
        onRetryCounts: () => {
          setCounts({ status: 'loading' })
          void readCountsNow()
        },
        onRetryRegister: () => {
          setRegister({ status: 'loading' })
          void readRegisterNow()
        },
        onRetryLibrary: () => {
          setLibrary({ status: 'loading' })
          void readLibraryNow()
        },
        onDismissNotice: () => setNotice(null),
        onSelected: setSelected,
        onAddDraft: (draft: ChemicalDraft) => {
          const siteChanged = add?.draft.siteId !== draft.siteId
          setAdd((current) => (current ? { ...current, draft: siteChanged ? { ...draft, roleSheetIds: [] } : draft, problem: null } : current))
          if (siteChanged) loadAddChoices(draft.siteId)
        },
        onAddSheet: (sheet: SheetDraft, file?: File | null) => {
          if (file !== undefined) addFile.current = file
          setAdd((current) => (current ? { ...current, sheet, problem: null } : current))
        },
        onSaveAdd: () => void saveAdd(),
        onEditDraft: (draft: ChemicalDraft) => setOpen((current) => (current ? { ...current, draft, problem: null } : current)),
        onSaveEdit: () => void saveEdit(),
        onReplaceDraft: (sheet: SheetDraft, file?: File | null) => {
          if (file !== undefined) replaceFile.current = file
          setOpen((current) => (current ? { ...current, sheet, problem: null } : current))
        },
        onReplace: () => void replace(),
        onArchiveReason: (reason: string) => setOpen((current) => (current ? { ...current, reason, problem: null } : current)),
        onArchive: () => void setStatus('ARCHIVED'),
        onRestore: () => void setStatus('ACTIVE'),
        onShowSheet: (sheetId: string) => {
          if (record) void showSheet(record, sheetId)
          go({ sheet: sheetId })
        },
        onRetryOpen: () => {
          if (!open) return
          setOpen({ ...open, read: { status: 'loading' } })
          void readOpen(open.id)
        },
        onArchiveMany: (ids) => setArchiveMany(ids ? { ids, reason: '', busy: false } : null),
        onArchiveManyReason: (reason) => setArchiveMany((current) => (current ? { ...current, reason } : current)),
        onApplyArchiveMany: () => void applyArchiveMany(),
        onQrChoose: (key) => setQr((current) => (current ? { ...current, chosen: key } : current)),
        onRetryCabinets: readQr,
      }}
    />
  )
}
