'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../_shared/hooks'
import {
  addCommonItems,
  addItem,
  editItem,
  issueOnPaper,
  newIdempotencyKey,
  readCounts,
  readGaps,
  readIssues,
  readItem,
  readItems,
  readKits,
  readSuppliers,
  setItemStatus,
  uploadScan,
  voidIssue,
  type CountsAnswer,
  type GapsAnswer,
  type IssuesAnswer,
  type ItemsAnswer,
  type KitsAnswer,
} from './api'
import {
  addressOf,
  addressText,
  EMPTY_ISSUE,
  EMPTY_ITEM,
  itemBodyOf,
  itemDraftOf,
  issueBodyOf,
  liveReach,
  ppeCan,
  prefillLines,
  problemOf,
  readProblemOf,
  roleBannerOf,
  TABLET_RECEIPT_READY,
  withAddress,
  type IssueDraft,
  type ItemDraft,
  type PpeAddress,
} from './model'
import type { ArchiveManyState, IssueState, ItemState, PageNotice, Read, RoleBanner, ScanState, VoidState } from './view-model'
import { cardHref, receiptHref } from './view/parts'
import { PpePageView } from './view/PpePageView'

type Section = 'counts' | 'gaps' | 'issues' | 'kits' | 'catalogue'

/**
 * `/w/<company>/plant/ppe` (SCR-211; B-W2b-147 on B-W2b-134's API; design plant.ppe): the tiles (GET /safety/ppe/counts) and
 * the lens on screen — Gaps (GET /safety/ppe/gaps, with the kits' roles for its filter), Issues (GET /safety/ppe/issues), Kits
 * per role (GET /safety/ppe/kits), Catalogue (GET /safety/ppe/items) — each loading and failing on its own, all with the top
 * bar's site. Every dialog lives in the address (`model.ts` addressOf): Issue PPE (`?issue=new|<person>`), PPE item
 * (`?item=new|<id>`), Void an issue (`?void=<line>`), the signed scan (`?scan=<receipt>`). A file to send stays in this
 * container (a File is no address). Live: ppe.issued and ppe_issue.voided read the gaps, the issues and the tiles again;
 * ppe_item.changed the catalogue and the kits; role_sheet.changed the kits and the gaps, then says what the role's change
 * means in a banner. The receipt and the PPE card open in new tabs.
 */
export function PpePage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/plant\/ppe\/?$/, '')
  const can = useMemo(() => ppeCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const siteId = scope.siteId
  const companyId = session.company?.id ?? null
  const [now, setNow] = useState(() => new Date().toISOString())

  const [counts, setCounts] = useState<Read<CountsAnswer>>({ status: 'loading' })
  const [gaps, setGaps] = useState<Read<GapsAnswer>>({ status: 'loading' })
  const [issues, setIssues] = useState<Read<IssuesAnswer>>({ status: 'loading' })
  const [kits, setKits] = useState<Read<KitsAnswer>>({ status: 'loading' })
  const [items, setItems] = useState<Read<ItemsAnswer>>({ status: 'loading' })
  const [readAt, setReadAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [roleBanner, setRoleBanner] = useState<RoleBanner | null>(null)
  const [pendingRole, setPendingRole] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [issue, setIssue] = useState<IssueState | null>(null)
  const [item, setItem] = useState<ItemState | null>(null)
  const [voiding, setVoiding] = useState<VoidState | null>(null)
  const [scan, setScan] = useState<ScanState | null>(null)
  const [archiveMany, setArchiveMany] = useState<ArchiveManyState | null>(null)
  const [commonBusy, setCommonBusy] = useState(false)
  const issueScan = useRef<File | null>(null)
  const scanFile = useRef<File | null>(null)
  const turns = useRef<Record<Section, number>>({ counts: 0, gaps: 0, issues: 0, kits: 0, catalogue: 0 })

  const settle = useCallback(<T,>(section: Section, set: (read: Read<T>) => void, reading: Promise<T>) => {
    const turn = ++turns.current[section]
    return reading.then(
      (value) => {
        if (turn !== turns.current[section]) return
        set({ status: 'ready', value })
        setReadAt(new Date().toISOString())
      },
      (error: unknown) => {
        if (turn === turns.current[section]) set({ status: 'error', problem: readProblemOf(error) })
      },
    )
  }, [])

  const { view, show, role, q, signed, person, ppe, from, to, status } = address
  const wantsKits = view === 'gaps' || view === 'kits'
  // One reader per section, each with only the terms it reads: typing in a lens's search never reads the tiles again.
  const readCountsNow = useCallback(() => (can.view ? settle('counts', setCounts, readCounts(api, siteId)) : Promise.resolve()), [api, can.view, settle, siteId])
  const gapsView = view === 'gaps'
  const readGapsNow = useCallback(
    () => (can.view && gapsView ? settle('gaps', setGaps, readGaps(api, { siteId, view: show === 'missing' ? 'missing' : 'all', roleSheetId: role, q })) : Promise.resolve()),
    [api, can.view, settle, siteId, gapsView, show, role, q],
  )
  const issuesView = view === 'issues'
  const readIssuesNow = useCallback(
    () => (can.view && issuesView ? settle('issues', setIssues, readIssues(api, { siteId, view: signed, employeeId: person, ppeItemId: ppe, from, to })) : Promise.resolve()),
    [api, can.view, settle, siteId, issuesView, signed, person, ppe, from, to],
  )
  const readKitsNow = useCallback(() => (can.view && wantsKits ? settle('kits', setKits, readKits(api, siteId)) : Promise.resolve()), [api, can.view, settle, siteId, wantsKits])
  const catalogueView = view === 'catalogue'
  const readItemsNow = useCallback(() => (can.view && catalogueView ? settle('catalogue', setItems, readItems(api, { status, q })) : Promise.resolve()), [api, can.view, settle, catalogueView, status, q])
  const readers = useMemo(() => ({ counts: readCountsNow, gaps: readGapsNow, issues: readIssuesNow, kits: readKitsNow, catalogue: readItemsNow }), [readCountsNow, readGapsNow, readIssuesNow, readKitsNow, readItemsNow])

  useEffect(() => {
    setCounts({ status: 'loading' })
    void readCountsNow()
  }, [readCountsNow])
  useEffect(() => {
    setGaps({ status: 'loading' })
    void readGapsNow()
  }, [readGapsNow])
  useEffect(() => {
    setIssues({ status: 'loading' })
    void readIssuesNow()
  }, [readIssuesNow])
  useEffect(() => {
    setKits({ status: 'loading' })
    void readKitsNow()
  }, [readKitsNow])
  useEffect(() => {
    setItems({ status: 'loading' })
    void readItemsNow()
  }, [readItemsNow])

  const go = useCallback(
    (change: Partial<PpeAddress>) => {
      if (change.view && change.view !== address.view) setSelected([])
      router.replace(`${pathname}${addressText(withAddress(address, change))}`, { scroll: false })
    },
    [router, pathname, address],
  )

  // ---- live ------------------------------------------------------------------------------------------------------------------

  const readersRef = useRef(readers)
  readersRef.current = readers
  const due = useRef(new Set<Section>())
  const flush = useCoalesced(() => {
    const sections = [...due.current]
    due.current.clear()
    for (const section of sections) void readersRef.current[section]()
  }, 800)
  useLive(
    (change) => {
      const reach = liveReach(change.type)
      if (reach.length === 0) return
      for (const section of reach) due.current.add(section)
      if (change.type === 'role_sheet.changed' && typeof change.fields.roleSheetId === 'string') setPendingRole(change.fields.roleSheetId)
      flush()
    },
    () => {
      for (const section of ['counts', 'gaps', 'issues', 'kits', 'catalogue'] as const) due.current.add(section)
      flush()
    },
    can.view,
  )

  // The role sheet's banner, once the gaps and the kits were read again after its change.
  useEffect(() => {
    if (!pendingRole || gaps.status !== 'ready' || kits.status !== 'ready') return
    const banner = roleBannerOf(pendingRole, kits.value, gaps.value.people)
    if (banner) setRoleBanner(banner)
    setPendingRole(null)
  }, [pendingRole, gaps, kits])

  const rereadAfterIssue = () => {
    void readersRef.current.counts()
    void readersRef.current.gaps()
    void readersRef.current.issues()
  }

  // ---- Issue PPE ---------------------------------------------------------------------------------------------------------------

  const readIssueChoices = useCallback(
    (prefillFor: string | null) => {
      setIssue((current) => (current ? { ...current, people: { status: 'loading' }, items: { status: 'loading' } } : current))
      readGaps(api, { siteId, view: 'all' }).then(
        (answer) =>
          setIssue((current) => {
            if (!current) return current
            const row = prefillFor ? answer.people.find((entry) => entry.employee.id === prefillFor) : null
            const draft = row && current.draft.employeeId === null ? { ...current.draft, employeeId: row.employee.id, lines: prefillLines(row) } : current.draft
            return { ...current, people: { status: 'ready', value: answer.people }, draft }
          }),
        (error) => setIssue((current) => (current ? { ...current, people: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
      readItems(api, { status: 'ACTIVE' }).then(
        (answer) => setIssue((current) => (current ? { ...current, items: { status: 'ready', value: answer.items } } : current)),
        (error) => setIssue((current) => (current ? { ...current, items: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api, siteId],
  )

  useEffect(() => {
    if (!address.issue || !can.view) {
      setIssue(null)
      issueScan.current = null
      return
    }
    setNow(new Date().toISOString())
    const prefillFor = address.issue === 'new' ? null : address.issue
    setIssue({ people: { status: 'loading' }, items: { status: 'loading' }, draft: EMPTY_ISSUE, busy: false, problem: null, recorded: null })
    readIssueChoices(prefillFor)
  }, [address.issue, can.view])

  const choosePerson = (employeeId: string | null) =>
    setIssue((current) => {
      if (!current) return current
      const row = current.people.status === 'ready' ? current.people.value.find((entry) => entry.employee.id === employeeId) : null
      return { ...current, problem: null, draft: { ...current.draft, employeeId, lines: row ? prefillLines(row) : [] } }
    })

  const submitIssue = async () => {
    if (!issue || issue.busy || !issue.draft.employeeId) return
    const people = issue.people.status === 'ready' ? issue.people.value : []
    const row = people.find((entry) => entry.employee.id === issue.draft.employeeId)
    if (issue.draft.method === 'tablet') {
      setNotice({ tone: 'info', key: 'notice.tablet', params: { name: row?.employee.name ?? '', site: row?.site.name ?? '' } })
      go({ issue: null })
      return
    }
    setIssue({ ...issue, busy: true, problem: null })
    const key = newIdempotencyKey()
    let answer
    try {
      answer = await issueOnPaper(api, issueBodyOf(issue.draft), key)
    } catch (error) {
      setIssue((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
      return
    }
    rereadAfterIssue()
    const file = issueScan.current
    if (!file) {
      setNotice({ tone: 'success', key: 'notice.issuedNoScan', params: { name: answer.receipt.employee.name, count: answer.receipt.units } })
      go({ issue: null })
      return
    }
    try {
      const stored = await uploadScan(api, answer.scan, file)
      issueScan.current = null
      if (stored.status !== 'AVAILABLE') {
        setIssue((current) => (current ? { ...current, busy: false, recorded: { answer, scanProblem: 'issue.scanQuarantined' } } : current))
        return
      }
      rereadAfterIssue()
      setNotice({ tone: 'success', key: 'notice.issued', params: { name: answer.receipt.employee.name, count: answer.receipt.units } })
      go({ issue: null })
    } catch (error) {
      setIssue((current) => (current ? { ...current, busy: false, recorded: { answer, scanProblem: problemOf(error).key } } : current))
    }
  }

  // ---- PPE item ------------------------------------------------------------------------------------------------------------------

  const loadSuppliers = useCallback(() => {
    const site = siteId ?? scope.sites[0]?.id ?? null
    if (!can.suppliers || !site) return
    setItem((current) => (current ? { ...current, suppliers: { status: 'loading' } } : current))
    readSuppliers(api, site).then(
      (suppliers) => setItem((current) => (current ? { ...current, suppliers: { status: 'ready', value: suppliers } } : current)),
      (error) => setItem((current) => (current ? { ...current, suppliers: { status: 'error', problem: readProblemOf(error) } } : current)),
    )
  }, [api, can.suppliers, siteId, scope.sites])

  const readOneItem = useCallback(
    (id: string) => {
      readItem(api, id).then(
        (record) => setItem((current) => (current && current.id === id ? { ...current, read: { status: 'ready', value: record }, draft: itemDraftOf(record.item) } : current)),
        (error) => setItem((current) => (current && current.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api],
  )

  useEffect(() => {
    if (!address.item || !can.view) {
      setItem(null)
      return
    }
    const id = address.item === 'new' ? null : address.item
    setItem({ id, read: id ? { status: 'loading' } : null, draft: EMPTY_ITEM, suppliers: null, busy: false, problem: null, saved: null })
    if (id) readOneItem(id)
    if (can.manage) loadSuppliers()
  }, [address.item, can.view])

  const saveItem = async () => {
    if (!item || item.busy) return
    const record = item.read?.status === 'ready' ? item.read.value : null
    setItem({ ...item, busy: true, problem: null })
    const body = itemBodyOf(item.draft, can.cost)
    try {
      if (record) {
        const answer = await editItem(api, record.item.id, { ...body, version: record.item.version }, newIdempotencyKey())
        setNotice({ tone: 'success', key: 'notice.itemSaved', params: { code: answer.item.code } })
      } else {
        if (!companyId) return
        const added = await addItem(api, { ...body, companyId, code: item.draft.code.trim().toUpperCase() }, newIdempotencyKey())
        setNotice({ tone: 'success', key: 'notice.itemAdded', params: { code: added.code } })
      }
      void readersRef.current.catalogue()
      void readersRef.current.kits()
      go({ item: null })
    } catch (error) {
      setItem((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const changeItemStatus = async (to: 'archive' | 'restore') => {
    if (!item || item.busy || item.read?.status !== 'ready') return
    const record = item.read.value
    setItem({ ...item, busy: true, problem: null })
    try {
      const changed = await setItemStatus(api, record.item.id, to, record.item.version, newIdempotencyKey())
      setItem((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: { ...record, item: changed } }, draft: itemDraftOf(changed), saved: { key: to === 'archive' ? 'saved.archived' : 'saved.restored' } } : current))
      void readersRef.current.catalogue()
    } catch (error) {
      setItem((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- Void an issue, the signed scan ---------------------------------------------------------------------------------------------

  useEffect(() => {
    if (!address.void || !can.view) return setVoiding(null)
    setVoiding((current) => (current && current.issueId === address.void ? current : { issueId: address.void!, reason: '', busy: false, problem: null }))
  }, [address.void, can.view])

  const applyVoid = async () => {
    if (!voiding || voiding.busy) return
    setVoiding({ ...voiding, busy: true, problem: null })
    try {
      const receipt = await voidIssue(api, voiding.issueId, voiding.reason.trim(), newIdempotencyKey())
      setNotice({ tone: 'success', key: 'notice.voided', params: { name: receipt.employee.name } })
      rereadAfterIssue()
      go({ void: null })
    } catch (error) {
      setVoiding((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  useEffect(() => {
    if (!address.scan || !can.view) {
      scanFile.current = null
      return setScan(null)
    }
    setScan((current) => (current && current.receiptId === address.scan ? current : { receiptId: address.scan!, file: null, busy: false, problem: null }))
  }, [address.scan, can.view])

  const applyScan = async () => {
    const file = scanFile.current
    if (!scan || scan.busy || !file) return
    const line = issues.status === 'ready' ? issues.value.issues.find((row) => row.receiptId === scan.receiptId) : null
    if (!line) return
    setScan({ ...scan, busy: true, problem: null })
    try {
      const stored = await uploadScan(api, { recordId: scan.receiptId, companyId: line.companyId }, file)
      scanFile.current = null
      if (stored.status !== 'AVAILABLE') {
        setScan((current) => (current ? { ...current, busy: false, problem: { key: 'issue.scanQuarantined', field: null, line: null } } : current))
        return
      }
      setNotice({ tone: 'success', key: 'notice.scanned', params: { name: line.employee.name } })
      rereadAfterIssue()
      go({ scan: null })
    } catch (error) {
      setScan((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- the catalogue's bulk and common items ------------------------------------------------------------------------------------

  const applyArchiveMany = async () => {
    if (!archiveMany || archiveMany.busy || items.status !== 'ready') return
    setArchiveMany({ ...archiveMany, busy: true })
    let done = 0
    const refused: { label: string; key: string }[] = []
    for (const id of archiveMany.ids) {
      const row = items.value.items.find((entry) => entry.id === id)
      if (!row) continue
      try {
        await setItemStatus(api, row.id, 'archive', row.version, newIdempotencyKey())
        done += 1
      } catch (error) {
        refused.push({ label: row.code, key: problemOf(error).key })
      }
    }
    setArchiveMany(null)
    setSelected([])
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'bulk.archivedResult', params: { count: done }, refused })
    void readersRef.current.catalogue()
  }

  const startCommon = async () => {
    if (!companyId || commonBusy) return
    setCommonBusy(true)
    try {
      const answer = await addCommonItems(api, companyId, newIdempotencyKey())
      setNotice({ tone: 'success', key: answer.skipped.length > 0 ? 'notice.commonSome' : 'notice.common', params: { count: answer.added, skipped: answer.skipped.join(', ') } })
      void readersRef.current.catalogue()
    } catch (error) {
      setNotice({ tone: 'danger', key: problemOf(error).key })
    } finally {
      setCommonBusy(false)
    }
  }

  const retry = (section: Section) => {
    const set = { counts: setCounts, gaps: setGaps, issues: setIssues, kits: setKits, catalogue: setItems }[section] as (read: Read<never>) => void
    set({ status: 'loading' })
    void readersRef.current[section]()
  }

  return (
    <PpePageView
      model={{
        prefix,
        can,
        scope,
        companyId,
        address,
        tabletReady: TABLET_RECEIPT_READY,
        riskPage: OFFICE_PAGES.has('/plant/risk'),
        counts: can.view ? counts : { status: 'loading' },
        gaps: can.view ? gaps : { status: 'loading' },
        issues: can.view ? issues : { status: 'loading' },
        kits: can.view ? kits : { status: 'loading' },
        items: can.view ? items : { status: 'loading' },
        readAt,
        notice,
        roleBanner,
        selected,
        issue,
        item,
        voiding,
        scan,
        archiveMany,
        commonBusy,
        now,
      }}
      actions={{
        onAddress: go,
        onRetry: retry,
        onDismissNotice: () => setNotice(null),
        onDismissRoleBanner: () => setRoleBanner(null),
        onSelected: setSelected,
        onIssueDraft: (draft: IssueDraft, file?: File | null) => {
          if (file !== undefined) issueScan.current = file
          setIssue((current) => (current ? { ...current, draft, problem: null } : current))
        },
        onIssuePerson: choosePerson,
        onIssue: () => void submitIssue(),
        onRetryIssue: () => readIssueChoices(address.issue && address.issue !== 'new' ? address.issue : null),
        onItemDraft: (draft: ItemDraft) => setItem((current) => (current ? { ...current, draft, problem: null, saved: null } : current)),
        onSaveItem: () => void saveItem(),
        onItemStatus: (to) => void changeItemStatus(to),
        onRetryItem: () => {
          if (!item?.id) return
          setItem({ ...item, read: { status: 'loading' } })
          readOneItem(item.id)
        },
        onVoidReason: (reason) => setVoiding((current) => (current ? { ...current, reason, problem: null } : current)),
        onVoid: () => void applyVoid(),
        onScanFile: (file) => {
          scanFile.current = file
          setScan((current) => (current ? { ...current, file: file ? { name: file.name, type: file.type, size: file.size } : null, problem: null } : current))
        },
        onUploadScan: () => void applyScan(),
        onArchiveMany: (ids) => setArchiveMany(ids ? { ids, busy: false } : null),
        onApplyArchiveMany: () => void applyArchiveMany(),
        onCommon: () => void startCommon(),
        onPrintReceipts: (ids) => {
          if (ids.length > 0) window.open(receiptHref(prefix, ids), '_blank', 'noopener')
        },
        onPrintCards: (ids) => {
          if (ids.length > 0) window.open(cardHref(prefix, ids), '_blank', 'noopener')
        },
      }}
    />
  )
}

