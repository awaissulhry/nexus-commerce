'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, liveMatches, useLive, useStepUp } from '../../_shared/hooks'
import { failedRead, reading, ready, type Notice, type Read } from '../../_shared/model'
import { approveVersion, draftVersion, editPlan, readPlan, readProfiles, readVersion, retireVersion, saveVersion, submitVersion, type PlanRecord as PlanRecordData, type ProfilesAnswer, type VersionRecord } from '../api'
import {
  appliesBody,
  appliesChanges,
  appliesDraftOf,
  appliesProblems,
  plansCan,
  problemOf,
  reasonProblem,
  recordAddressOf,
  recordQuery,
  refusedPaths,
  versionBody,
  versionChanges,
  versionDraftOf,
  versionProblems,
  type AppliesDraft,
  type RecordAddress,
  type VersionDraft,
} from '../model'
import { useChipSearch } from '../use-chip-search'
import { PlanRecordView, type PlanRecordModel } from './view/PlanRecordView'

/** The version the Versions tab compares the one picked with: the version in force, or (for that one) the one before it. */
function compareWith(record: PlanRecordData, versionId: string): string | null {
  const approved = record.versions.find((version) => version.status === 'APPROVED') ?? null
  if (approved && approved.id !== versionId) return approved.id
  const picked = record.versions.find((version) => version.id === versionId)
  const before = record.versions.filter((version) => picked && version.number < picked.number).sort((a, b) => b.number - a.number)[0]
  return before?.id ?? null
}

/**
 * The plan record's container (`/w/<company>/quality/plans/<id>?tab=checks|sampling|applies|versions&version=&approve=1`,
 * SCR-077-plan): reads the record (and the AQL profiles for Sampling), holds the builder's draft (Checks + Sampling, one
 * save) and the Applies-to draft (the plan's save), and writes each as the API's command at the version read; submit,
 * approve (a fresh code through the step-up dialog), start a version, retire one with its reason; listens to the plan's
 * live events (a change elsewhere re-reads, or says so while this page holds unsaved changes).
 */
export function PlanRecord({ planId }: { planId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => plansCan(session.permissions), [session.permissions])
  const address = useMemo(() => recordAddressOf(params), [params])
  const companyId = session.company?.id ?? null
  const prefix = companyPrefix(session.company?.code ?? '')
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const chips = useChipSearch(api)

  const [record, setRecord] = useState<Read<PlanRecordData>>(reading())
  const [draft, setDraft] = useState<VersionDraft | null>(null)
  const [applies, setApplies] = useState<AppliesDraft | null>(null)
  const [shown, setShown] = useState(false)
  const [refused, setRefused] = useState<readonly string[]>([])
  const [openCheck, setOpenCheck] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Read<ProfilesAnswer> | null>(null)
  const [exampleLot, setExampleLot] = useState(500)
  const [version, setVersion] = useState<Read<VersionRecord> | null>(null)
  const [retire, setRetire] = useState<PlanRecordModel['retire']>(null)
  const [approveProblem, setApproveProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<PlanRecordModel['busy']>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [versionTry, setVersionTry] = useState(0)

  const writeAddress = useCallback((next: RecordAddress) => router.replace(`${pathname}${recordQuery(next)}`, { scroll: false }), [pathname, router])

  const take = useCallback((answer: PlanRecordData) => {
    setRecord(ready(answer))
    setDraft(versionDraftOf(answer.current))
    setApplies(appliesDraftOf(answer.plan))
    setShown(false)
    setRefused([])
    setChangedElsewhere(false)
  }, [])

  const load = useCallback(
    async (keep = false) => {
      if (!can.view) return null
      try {
        const answer = await readPlan(api, planId)
        if (keep) setRecord(ready(answer))
        else take(answer)
        return answer
      } catch (error) {
        setRecord(failedRead(problemOf(error)))
        return null
      }
    },
    [api, can.view, planId, take],
  )
  useEffect(() => {
    setRecord(reading())
    void load()
  }, [load])
  useEffect(() => {
    if (!can.aqlView || !companyId) {
      setProfiles(can.aqlView ? null : failedRead('problem.forbidden'))
      return
    }
    readProfiles(api, companyId)
      .then((answer) => setProfiles(ready(answer)))
      .catch((error: unknown) => setProfiles(failedRead(problemOf(error))))
  }, [api, can.aqlView, companyId])

  // ---- Versions: the version picked, compared ----
  const current = record.value
  const pickedVersion = address.tab === 'versions' && current ? (address.version ?? current.current.id) : null
  useEffect(() => {
    if (!pickedVersion || !current) {
      setVersion(null)
      return
    }
    const controller = new AbortController()
    setVersion(reading())
    readVersion(api, planId, pickedVersion, compareWith(current, pickedVersion), controller.signal)
      .then((answer) => setVersion(ready(answer)))
      .catch((error: unknown) => !controller.signal.aborted && setVersion(failedRead(problemOf(error))))
    return () => controller.abort()
    // The record's own version moves with every save; the picked version and Try again decide.
  }, [api, planId, pickedVersion, current?.plan.version, current?.current.version, versionTry])

  // ---- dirty drafts and the live stream ----
  const versionCount = current && draft ? versionChanges(current.current, draft) : 0
  const appliesCount = current && applies ? appliesChanges(current.plan, applies) : 0
  const dirty = useRef(false)
  dirty.current = versionCount + appliesCount > 0
  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['inspection_plan.'])) return
      if (change.fields.planId !== undefined && change.fields.planId !== planId) return
      if (busy) return
      if (!dirty.current) void load()
      else void load(true).then((answer) => answer && current && answer.plan.version + answer.current.version !== current.plan.version + current.current.version && setChangedElsewhere(true))
    },
    () => {
      if (!dirty.current) void load()
    },
  )

  // ---- the approval dialog follows the address (`?approve=1`) ----
  const approveOpen = address.approve

  // ---- writes ----
  const saveBuilder = useCallback(async () => {
    if (!current || !draft) return
    if (versionProblems(draft).length > 0) {
      setShown(true)
      return
    }
    setBusy('save')
    try {
      const answer = await saveVersion(api, planId, current.current.id, versionBody(current.current, draft), newIdempotencyKey())
      setNotice({ key: 'done.saved', params: { number: answer.version.number }, tone: 'success' })
      setSavedAt(new Date().toISOString())
      setOpenCheck(null)
      await load()
    } catch (error) {
      const problem = problemOf(error)
      setShown(true)
      setRefused(refusedPaths(error))
      setNotice({ key: problem, tone: 'danger' })
      if (problem === 'problem.stale') setChangedElsewhere(true)
    } finally {
      setBusy(null)
    }
  }, [api, current, draft, load, planId])

  const saveApplies = useCallback(async () => {
    if (!current || !applies) return
    if (appliesProblems(applies).length > 0) {
      setShown(true)
      return
    }
    setBusy('applies')
    try {
      take(await editPlan(api, planId, appliesBody(current.plan, applies), newIdempotencyKey()))
      setNotice({ key: 'done.applies', tone: 'success' })
      setSavedAt(new Date().toISOString())
      chips.clear()
    } catch (error) {
      setShown(true)
      setNotice({ key: problemOf(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }, [api, applies, chips, current, planId, take])

  const setOwner = useCallback(
    async (ownerId: string | null) => {
      if (!current) return
      setBusy('owner')
      try {
        const answer = await editPlan(api, planId, { version: current.plan.version, ownerId }, newIdempotencyKey())
        setRecord(ready(answer))
        setNotice({ key: ownerId ? 'done.ownerMe' : 'done.ownerCleared', tone: 'success' })
      } catch (error) {
        setNotice({ key: problemOf(error), tone: 'danger' })
      } finally {
        setBusy(null)
      }
    },
    [api, current, planId],
  )

  const submit = useCallback(async () => {
    if (!current || current.current.status !== 'DRAFT') return
    setBusy('submit')
    try {
      await submitVersion(api, planId, current.current.id, { version: current.current.version }, newIdempotencyKey())
      setNotice({ key: 'done.submitted', params: { number: current.current.number }, tone: 'success' })
      await load()
    } catch (error) {
      setNotice({ key: problemOf(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }, [api, current, load, planId])

  const newVersion = useCallback(async () => {
    if (!current) return
    setBusy('newVersion')
    try {
      const answer = await draftVersion(api, planId, { version: current.plan.version }, newIdempotencyKey())
      setNotice({ key: 'done.newVersion', params: { number: answer.version.number }, tone: 'success' })
      await load()
      writeAddress({ ...address, tab: address.tab === 'versions' ? 'checks' : address.tab, version: null })
    } catch (error) {
      setNotice({ key: problemOf(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }, [address, api, current, load, planId, writeAddress])

  const approve = useCallback(async () => {
    if (!current || current.current.status !== 'DRAFT') return
    const target = current.current
    setBusy('approve')
    setApproveProblem(null)
    try {
      const answer = await guard('stepUp.approve', () => approveVersion(api, planId, target.id, { version: target.version }, newIdempotencyKey()))
      setNotice({ key: answer.retired ? 'done.approvedRetired' : 'done.approved', params: { number: answer.version.number, retired: answer.retired?.number ?? 0 }, tone: 'success' })
      writeAddress({ ...address, approve: false })
      await load()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      setApproveProblem(problemOf(error))
    } finally {
      setBusy(null)
    }
  }, [address, api, current, guard, load, planId, writeAddress])

  const retireNow = useCallback(async () => {
    if (!retire) return
    if (reasonProblem(retire.reason)) {
      setRetire({ ...retire, shown: true })
      return
    }
    const target = current?.versions.find((entry) => entry.id === retire.versionId)
    const fresh = current?.current.id === retire.versionId ? current.current.version : null
    setBusy('retire')
    try {
      // The version's own row version: the current one's from the record, another's read first.
      const rowVersion = fresh ?? (await readVersion(api, planId, retire.versionId, null)).version.version
      await retireVersion(api, planId, retire.versionId, { version: rowVersion, reason: retire.reason.trim() }, newIdempotencyKey())
      setNotice({ key: 'done.retired', params: { number: target?.number ?? retire.number }, tone: 'success' })
      setRetire(null)
      await load()
    } catch (error) {
      setRetire({ ...retire, shown: true, problem: problemOf(error) })
    } finally {
      setBusy(null)
    }
  }, [api, current, load, planId, retire])

  const model: PlanRecordModel = {
    prefix,
    me: session.user.id,
    can,
    address,
    record,
    draft,
    applies,
    shown,
    refused,
    openCheck,
    profiles,
    exampleLot,
    version,
    approve: approveOpen ? { problem: approveProblem } : null,
    retire,
    chipSearch: chips.search,
    busy,
    notice,
    stepUp,
    live,
    savedAt,
    changedElsewhere,
  }

  return (
    <PlanRecordView
      model={model}
      actions={{
        onChecks: (checks) => draft && setDraft({ ...draft, checks }),
        onOpenCheck: setOpenCheck,
        onChangeNote: (changeNote) => draft && setDraft({ ...draft, changeNote }),
        onSampling: (sampling) => draft && setDraft({ ...draft, sampling }),
        onExampleLot: setExampleLot,
        onDiscardVersion: () => {
          if (!current) return
          setDraft(versionDraftOf(current.current))
          setShown(false)
          setOpenCheck(null)
        },
        onSaveVersion: () => void saveBuilder(),
        onApplies: setApplies,
        onDiscardApplies: () => current && setApplies(appliesDraftOf(current.plan)),
        onSaveApplies: () => void saveApplies(),
        onChipSearch: chips.onSearch,
        onRetryVersion: () => setVersionTry((n) => n + 1),
        onSubmit: () => void submit(),
        onNewVersion: () => void newVersion(),
        onOwner: (ownerId) => void setOwner(ownerId),
        onApproveOpen: () => {
          setApproveProblem(null)
          writeAddress({ ...address, approve: true })
        },
        onApproveClose: () => writeAddress({ ...address, approve: false }),
        onApprove: () => void approve(),
        onRetireOpen: (versionId, number, status) => setRetire({ versionId, number, status, reason: '', shown: false, problem: null }),
        onRetireReason: (reason) => retire && setRetire({ ...retire, reason, problem: null }),
        onRetireClose: () => setRetire(null),
        onRetire: () => void retireNow(),
        onReload: () => void load(),
        onRetry: () => {
          setRecord(reading())
          void load()
        },
        onDismissNotice: () => setNotice(null),
        onStepUp: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
