'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { isStepUpCancelled, useLive, useStepUp } from '../../quality/_shared/hooks'
import { addUse, approveClaim, createClaim, editClaim, endUse, evidenceAddress, listClaims, readChoices, readClaim, readCounts, uploadEvidence, withdrawClaim, type Choices, type Claim, type CountsAnswer, type ListAnswer } from './api'
import {
  addressOf,
  addressText,
  bodyOf,
  draftOf,
  EMPTY_DRAFT,
  EMPTY_USE,
  isClaimsChange,
  problemOf,
  readProblemOf,
  replacementOf,
  sourcingCan,
  withAddress,
  type ClaimDraft,
  type SourcingAddress,
} from './model'
import type { NewState, OpenState, PageNotice, Read, WithdrawManyState } from './view-model'
import { SourcingPageView } from './view/SourcingPageView'

type Section = 'counts' | 'claims'

/** Today in the factory's zone (Europe/Rome), the guards' "today". */
const todayInRome = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * `/w/<company>/compliance/sourcing` (SCR-215; B-W2b-264; design compliance.sourcing): two reads — the tiles (GET
 * /compliance/claims/counts) and the claims (GET /compliance/claims, the address's filters) — each loading and failing on its
 * own. Every dialog lives in the address (`model.ts` addressOf): New claim (`?new=1`, a replacement `&replaces=<id>`) and the
 * claim's window (`?open=<id>&tab=…&do=edit|approve|withdraw|use`). Files chosen on this device stay in this container (a File is
 * no address) and are uploaded onto the claim when it is saved. Approving asks a fresh code (the DS step-up dialog on the API's
 * 403 `stepUp`). Live: claim.changed, claim.use_changed and claim.evidence_expired read the list, the tiles and an open claim
 * again (coalesced).
 */
export function SourcingPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/compliance\/sourcing\/?$/, '')
  const can = useMemo(() => sourcingCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const [today] = useState(todayInRome)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const [counts, setCounts] = useState<Read<CountsAnswer>>({ status: 'loading' })
  const [claims, setClaims] = useState<Read<ListAnswer>>({ status: 'loading' })
  const [readAt, setReadAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [add, setAdd] = useState<NewState | null>(null)
  const [open, setOpen] = useState<OpenState | null>(null)
  const [withdrawMany, setWithdrawMany] = useState<WithdrawManyState | null>(null)
  const [choices, setChoices] = useState<Read<Choices> | null>(null)
  const addFiles = useRef<File[]>([])
  const editFiles = useRef<File[]>([])
  const turns = useRef<Record<Section, number>>({ counts: 0, claims: 0 })

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

  const readCountsNow = useCallback(() => (can.view ? settle('counts', setCounts, readCounts(api)) : Promise.resolve()), [api, can.view, settle])
  const { state, kind, scope, q } = address
  const readClaimsNow = useCallback(
    () =>
      can.view
        ? settle('claims', setClaims, listClaims(api, { state, kind, scope, q }).then((answer) => {
            setReadAt(new Date().toISOString())
            return answer
          }))
        : Promise.resolve(),
    [api, can.view, settle, state, kind, scope, q],
  )

  useEffect(() => {
    setCounts({ status: 'loading' })
    void readCountsNow()
  }, [readCountsNow])
  useEffect(() => {
    setClaims({ status: 'loading' })
    void readClaimsNow()
  }, [readClaimsNow])

  const go = useCallback((change: Partial<SourcingAddress>) => router.replace(`${pathname}${addressText(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])
  const rereadAll = () => {
    void readCountsNow()
    void readClaimsNow()
  }

  // ---- the choices (New claim, Edit, Record a use): read once per visit, again on Try again ---------------------------------

  const loadChoices = useCallback(() => {
    if (!can.manage) return
    setChoices({ status: 'loading' })
    readChoices(api).then(
      (value) => setChoices({ status: 'ready', value }),
      (error) => setChoices({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, can.manage])
  const needsChoices = address.add || address.mode === 'edit' || address.mode === 'use'
  useEffect(() => {
    if (needsChoices && choices === null) loadChoices()
  }, [needsChoices, choices, loadChoices])

  // ---- the claim's window ------------------------------------------------------------------------------------------------------

  const readOpen = useCallback(
    async (id: string) => {
      try {
        const record = await readClaim(api, id)
        setOpen((current) => (current && current.id === id ? { ...current, read: { status: 'ready', value: record } } : current))
        return record
      } catch (error) {
        setOpen((current) => (current && current.id === id ? { ...current, read: { status: 'error', problem: readProblemOf(error) } } : current))
        return null
      }
    },
    [api],
  )

  // The address opens and closes the window; a new id starts afresh and reads it.
  useEffect(() => {
    if (!address.open || !can.view) {
      setOpen(null)
      return
    }
    const id = address.open
    setOpen((current) => (current && current.id === id ? current : { id, read: { status: 'loading' }, mode: 'view', tab: address.tab, draft: null, choices: null, use: EMPTY_USE, reason: '', busy: false, problem: null, saved: null }))
    if (open?.id === id) return
    void readOpen(id)
  }, [address.open, can.view])

  // The window's tab and mode follow the address: Edit loads its draft; Record a use a fresh use.
  const record = open?.read.status === 'ready' ? open.read.value : null
  useEffect(() => {
    if (!open || !record) return
    if (address.tab !== open.tab) setOpen((current) => (current ? { ...current, tab: address.tab } : current))
    const mode = address.mode
    if (mode === open.mode) return
    editFiles.current = []
    setOpen((current) => (current ? { ...current, mode, problem: null, saved: mode === 'view' ? current.saved : null, reason: '', use: EMPTY_USE, draft: mode === 'edit' ? draftOf(record.claim) : null } : current))
  }, [address.mode, address.tab, record, open])

  // ---- New claim ---------------------------------------------------------------------------------------------------------------

  useEffect(() => {
    if (!address.add || !can.manage) {
      setAdd(null)
      addFiles.current = []
      return
    }
    setAdd((current) => current ?? { draft: EMPTY_DRAFT, choices: null, busy: false, problem: null, savedWithoutFile: null })
  }, [address.add, can.manage])

  // The code suggested once the choices are read; a replacement starts from the claim it replaces.
  useEffect(() => {
    if (!add || choices?.status !== 'ready') return
    if (add.draft.code !== '' || add.draft.supersedesId) return
    const replaced = address.replaces && claims.status === 'ready' ? claims.value.claims.find((claim) => claim.id === address.replaces) : null
    const fromWindow = address.replaces && record?.claim.id === address.replaces ? record.claim : null
    const source = replaced ?? fromWindow
    setAdd((current) => (current ? { ...current, draft: source ? replacementOf(source, choices.value.nextCode) : { ...current.draft, code: choices.value.nextCode } } : current))
  }, [add, choices, address.replaces, claims, record])

  // ---- live --------------------------------------------------------------------------------------------------------------------

  const readersRef = useRef({ readCountsNow, readClaimsNow })
  readersRef.current = { readCountsNow, readClaimsNow }
  const openRef = useRef(open)
  openRef.current = open
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      void readersRef.current.readCountsNow()
      void readersRef.current.readClaimsNow()
    }, 800)
  }, [])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useLive(
    (change) => {
      if (!can.view || !isClaimsChange(change)) return
      flush()
      const current = openRef.current
      if (current && !current.busy && current.mode === 'view' && change.fields.claimId === current.id) void readOpen(current.id)
    },
    () => {
      if (can.view) flush()
    },
  )

  // ---- writes ------------------------------------------------------------------------------------------------------------------

  /** Uploads files chosen on this device onto a claim; the ids taken, or the problem of the first refused one. */
  const uploadAll = async (claim: Claim, files: readonly File[]) => {
    const ids: string[] = []
    for (const file of files) ids.push(await uploadEvidence(api, { companyId: claim.companyId, claimId: claim.id, file }))
    return ids
  }

  const saveNew = async () => {
    if (!add || add.busy || !companyId) return
    setAdd({ ...add, busy: true, problem: null, savedWithoutFile: null })
    const key = newIdempotencyKey()
    let claim: Claim
    try {
      claim = await createClaim(api, { ...bodyOf(add.draft), companyId, code: add.draft.code.trim(), supersedesId: add.draft.supersedesId }, key)
    } catch (error) {
      setAdd((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
      return
    }
    const files = addFiles.current
    if (files.length > 0) {
      try {
        const ids = await uploadAll(claim, files)
        claim = await editClaim(api, claim.id, { ...bodyOf({ ...add.draft, evidenceFileIds: [...add.draft.evidenceFileIds, ...ids] }), version: claim.version }, `${key}:evidence`)
      } catch (error) {
        // The draft is in the register: its file is said refused and the draft offered to open (Edit adds it again).
        setAdd((current) => (current ? { ...current, busy: false, problem: problemOf(error), savedWithoutFile: claim.id } : current))
        rereadAll()
        return
      }
    }
    addFiles.current = []
    setNotice({ tone: 'success', key: add.draft.supersedesId ? 'notice.replacementDrafted' : 'notice.drafted', params: { code: claim.code } })
    rereadAll()
    go({ add: false, open: claim.id })
  }

  const saveEdit = async () => {
    if (!open || !record || !open.draft || open.busy) return
    setOpen({ ...open, busy: true, problem: null })
    try {
      const ids = await uploadAll(record.claim, editFiles.current)
      editFiles.current = []
      await editClaim(api, record.claim.id, { ...bodyOf({ ...open.draft, evidenceFileIds: [...open.draft.evidenceFileIds, ...ids] }), version: record.claim.version }, newIdempotencyKey())
      const fresh = await readClaim(api, record.claim.id)
      setOpen((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: fresh }, saved: { key: 'saved.edited' } } : current))
      rereadAll()
      go({ mode: 'view' })
    } catch (error) {
      setOpen((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const approve = async () => {
    if (!open || !record || open.busy) return
    setOpen({ ...open, busy: true, problem: null })
    const key = newIdempotencyKey()
    try {
      const answer = await guard('approve.sentence', () => approveClaim(api, record.claim.id, { version: record.claim.version }, key))
      const fresh = await readClaim(api, record.claim.id)
      setOpen((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: fresh }, saved: answer.replaced ? { key: 'saved.approvedReplacing', params: { code: answer.replaced.code, count: answer.replaced.usesMoved } } : { key: 'saved.approved' } } : current))
      rereadAll()
      go({ mode: 'view' })
    } catch (error) {
      setOpen((current) => (current ? { ...current, busy: false, problem: isStepUpCancelled(error) ? null : problemOf(error) } : current))
    }
  }

  const withdraw = async () => {
    if (!open || !record || open.busy) return
    setOpen({ ...open, busy: true, problem: null })
    try {
      const answer = await withdrawClaim(api, record.claim.id, { version: record.claim.version, reason: open.reason.trim() }, newIdempotencyKey())
      const fresh = await readClaim(api, record.claim.id)
      setOpen((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: fresh }, saved: { key: 'saved.withdrawn', params: { count: answer.usesEnded } } } : current))
      rereadAll()
      go({ mode: 'view' })
    } catch (error) {
      setOpen((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const addUseNow = async () => {
    if (!open || !record || open.busy || !open.use.recordId) return
    setOpen({ ...open, busy: true, problem: null })
    try {
      await addUse(api, record.claim.id, { kind: open.use.kind, recordId: open.use.recordId, label: open.use.label.trim() || null, note: open.use.note.trim() || null }, newIdempotencyKey())
      const fresh = await readClaim(api, record.claim.id)
      setOpen((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: fresh }, saved: { key: 'saved.useAdded' } } : current))
      rereadAll()
      go({ mode: 'view', tab: 'where' })
    } catch (error) {
      setOpen((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const endUseNow = async (useId: string) => {
    if (!open || !record || open.busy) return
    const use = record.uses.find((row) => row.id === useId)
    if (!use) return
    setOpen({ ...open, busy: true, problem: null })
    try {
      await endUse(api, record.claim.id, use.id, { version: use.version }, newIdempotencyKey())
      const fresh = await readClaim(api, record.claim.id)
      setOpen((current) => (current ? { ...current, busy: false, read: { status: 'ready', value: fresh }, saved: { key: 'saved.useEnded' } } : current))
      rereadAll()
    } catch (error) {
      setOpen((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const openEvidence = async (fileId: string) => {
    // The tab opens at once (a pop-up blocker allows it, the click is still fresh), then follows the 60-second address.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    try {
      const url = await evidenceAddress(api, fileId)
      if (tab) tab.location.href = url
      else window.location.assign(url)
    } catch (error) {
      tab?.close()
      setOpen((current) => (current ? { ...current, problem: problemOf(error) } : current))
    }
  }

  /** Withdraw N: each chosen claim at the version the list read, one call each; what was refused is said. */
  const applyWithdrawMany = async () => {
    if (!withdrawMany || withdrawMany.busy || claims.status !== 'ready') return
    setWithdrawMany({ ...withdrawMany, busy: true })
    let done = 0
    const refused: { label: string; key: string }[] = []
    for (const id of withdrawMany.ids) {
      const row = claims.value.claims.find((claim) => claim.id === id)
      if (!row) continue
      try {
        await withdrawClaim(api, row.id, { version: row.version, reason: withdrawMany.reason.trim() }, newIdempotencyKey())
        done += 1
      } catch (error) {
        refused.push({ label: row.code, key: problemOf(error).key })
      }
    }
    setWithdrawMany(null)
    setSelected([])
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'bulk.withdrawnResult', params: { count: done }, refused })
    rereadAll()
  }

  const setOpenChoices = (next: Read<Choices> | null) => setOpen((current) => (current ? { ...current, choices: next } : current))
  useEffect(() => {
    if (open && open.choices !== choices) setOpenChoices(choices)
    if (add && add.choices !== choices) setAdd((current) => (current ? { ...current, choices } : current))
  }, [choices, open, add])

  const pendingOf = (files: readonly File[]) => files.map((file) => ({ name: file.name, type: file.type, size: file.size }))

  return (
    <SourcingPageView
      model={{
        prefix,
        can,
        companyId,
        companyName: session.company?.name ?? '',
        address,
        today,
        counts: can.view ? counts : { status: 'loading' },
        claims: can.view ? claims : { status: 'loading' },
        readAt,
        notice,
        selected,
        add,
        open,
        withdrawMany,
        stepUp,
      }}
      actions={{
        onAddress: go,
        onRetryCounts: () => {
          setCounts({ status: 'loading' })
          void readCountsNow()
        },
        onRetryClaims: () => {
          setClaims({ status: 'loading' })
          void readClaimsNow()
        },
        onDismissNotice: () => setNotice(null),
        onSelected: setSelected,
        onNewDraft: (draft: ClaimDraft) => {
          // A file removed from the list leaves the container's bytes too.
          if (add && draft.pending.length < add.draft.pending.length) addFiles.current = addFiles.current.filter((file) => draft.pending.some((kept) => kept.name === file.name && kept.size === file.size))
          setAdd((current) => (current ? { ...current, draft, problem: null } : current))
        },
        onNewFiles: (files) => {
          addFiles.current = [...addFiles.current, ...files]
          setAdd((current) => (current ? { ...current, draft: { ...current.draft, pending: pendingOf(addFiles.current) }, problem: null } : current))
        },
        onSaveNew: () => void saveNew(),
        onRetryChoices: loadChoices,
        onEditDraft: (draft: ClaimDraft) => {
          if (open?.draft && draft.pending.length < open.draft.pending.length) editFiles.current = editFiles.current.filter((file) => draft.pending.some((kept) => kept.name === file.name && kept.size === file.size))
          setOpen((current) => (current ? { ...current, draft, problem: null } : current))
        },
        onEditFiles: (files) => {
          editFiles.current = [...editFiles.current, ...files]
          setOpen((current) => (current && current.draft ? { ...current, draft: { ...current.draft, pending: pendingOf(editFiles.current) }, problem: null } : current))
        },
        onSaveEdit: () => void saveEdit(),
        onApprove: () => void approve(),
        onReason: (reason: string) => setOpen((current) => (current ? { ...current, reason, problem: null } : current)),
        onWithdraw: () => void withdraw(),
        onUseDraft: (use) => setOpen((current) => (current ? { ...current, use, problem: null } : current)),
        onAddUse: () => void addUseNow(),
        onEndUse: (useId) => void endUseNow(useId),
        onOpenEvidence: (fileId) => void openEvidence(fileId),
        onRetryOpen: () => {
          if (!open) return
          setOpen({ ...open, read: { status: 'loading' } })
          void readOpen(open.id)
        },
        onWithdrawMany: (ids) => setWithdrawMany(ids ? { ids, reason: '', busy: false } : null),
        onWithdrawManyReason: (reason) => setWithdrawMany((current) => (current ? { ...current, reason } : current)),
        onApplyWithdrawMany: () => void applyWithdrawMany(),
        onStepUp: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
