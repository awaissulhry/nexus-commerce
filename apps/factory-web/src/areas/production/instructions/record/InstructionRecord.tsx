'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLiveChanges } from '../../../../record-panels/live'
import { putToStore, sha256Hex, storeUrl } from '../../../../record-panels/store'
import {
  announceMedia,
  completeMedia,
  discardVersion,
  draftVersion,
  getAcknowledgements,
  getInstruction,
  getVersion,
  mediaDownload,
  publishVersion,
  recordPaper,
  saveVersion,
  setStatus,
  type Acknowledgements,
  type InstructionRecord as RecordData,
  type VersionAnswer,
} from '../api'
import {
  changesOf,
  defaultPair,
  draftOf,
  editHeld,
  failed,
  instructionsCan,
  mediaKindOf,
  NAMESPACES,
  problemsOf,
  readProblem,
  reading,
  ready,
  recordAddressOf,
  recordQuery,
  saveBodyOf,
  shownVersionId,
  valueOf,
  writeProblem,
  type Notice,
  type Read,
  type RecordAddress,
  type Upload,
  type VersionDraft,
} from '../model'
import { InstructionRecordView, type RecordModel } from './view/InstructionRecordView'
import type { RecordDialog } from './view/dialogs'

const todayIso = () => new Date().toISOString().slice(0, 10)

/**
 * `/w/<company>/production/instructions/<id>?tab=steps|media|versions|acks&version=&compare=&approve=1` (SCR-285): reads the
 * record, the version shown (the draft, else the one in force, else `?version=`), holds the editor's document (steps,
 * photos and videos, the change note, the ask to look again: ONE save, the version read), uploads a photo or video to a
 * step (announce, PUT straight to the store, confirm; it joins the draft), approves (publish, by a second person), starts,
 * discards, archives and restores; reads two versions to compare and the acknowledgements when their tab opens; records a
 * paper acknowledgement (HR). Live `production.instruction_*` of this instruction: a change by someone else shows a Banner
 * with Reload (design: no live feed).
 */
export function InstructionRecord({ instructionId }: { instructionId: string }) {
  return (
    <WithMessages namespaces={[...NAMESPACES, 'shell']}>
      <Container instructionId={instructionId} />
    </WithMessages>
  )
}

function Container({ instructionId }: { instructionId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pageLocale = useLocale()
  const can = useMemo(() => instructionsCan(session.permissions), [session.permissions])
  const address = useMemo(() => recordAddressOf(params), [params])
  const prefix = pathname.replace(/\/production\/instructions\/[^/]+\/?$/, '')

  const [record, setRecord] = useState<Read<RecordData>>(reading())
  const [shown, setShown] = useState<Read<VersionAnswer> | null>(reading())
  const [draft, setDraft] = useState<VersionDraft | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const [refused, setRefused] = useState<readonly string[]>([])
  const [language, setLanguage] = useState<string>(pageLocale === 'en' ? 'en' : 'it')
  const [openStep, setOpenStep] = useState<string | null>(null)
  const [mediaSrc, setMediaSrc] = useState<Record<string, string | null>>({})
  const [uploads, setUploads] = useState<Upload[]>([])
  const [compareIds, setCompareIds] = useState<{ beforeId: string | null; afterId: string | null } | null>(null)
  const [before, setBefore] = useState<Read<VersionAnswer> | null>(null)
  const [after, setAfter] = useState<Read<VersionAnswer> | null>(null)
  const [compareTry, setCompareTry] = useState(0)
  const [acks, setAcks] = useState<Read<Acknowledgements> | null>(null)
  const [acksTry, setAcksTry] = useState(0)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [busy, setBusy] = useState<RecordModel['busy']>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [offline, setOffline] = useState(false)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const saveKey = useRef<string | null>(null)
  const writeKey = useRef<string | null>(null)
  const busyRef = useRef<RecordModel['busy']>(null)
  busyRef.current = busy

  const writeAddress = useCallback((next: RecordAddress) => router.replace(`${pathname}${recordQuery(next)}`, { scroll: false }), [pathname, router])

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // ---- the record ----
  const loadRecord = useCallback(
    async (quiet = false): Promise<RecordData | null> => {
      if (!can.view) return null
      try {
        const answer = await getInstruction(api, instructionId)
        setRecord(ready(answer))
        return answer
      } catch (error) {
        if (!quiet) setRecord(failed(readProblem(error)))
        return null
      }
    },
    [api, can.view, instructionId],
  )
  useEffect(() => {
    setRecord(reading())
    void loadRecord()
  }, [loadRecord])

  const current = valueOf(record)
  const shownId = current ? shownVersionId(current, address.version) : null
  const shownRow = current?.versions.find((version) => version.id === shownId) ?? null

  // ---- the version shown (compared with the one before it: what changed, for the approval) ----
  const loadShown = useCallback(
    async (versionId: string | null) => {
      if (!versionId) {
        setShown(null)
        setDraft(null)
        return null
      }
      setShown((previous) => (previous && previous.status === 'ready' && previous.value.version.id === versionId ? previous : reading()))
      try {
        const answer = await getVersion(api, instructionId, versionId)
        setShown(ready(answer))
        setDraft(answer.version.status === 'DRAFT' ? draftOf(answer) : null)
        setShowProblems(false)
        setRefused([])
        return answer
      } catch (error) {
        setShown(failed(readProblem(error)))
        setDraft(null)
        return null
      }
    },
    [api, instructionId],
  )
  useEffect(() => {
    if (!current) return
    void loadShown(shownId)
    // The row's own version moves with every save; the version picked decides.
  }, [shownId, shownRow?.version, current !== null])

  // ---- the addresses of the photos and videos shown (files.read; a presigned GET read once per file) ----
  const shownValue = valueOf(shown)
  const fileIds = useMemo(() => {
    const ids = new Set<string>()
    for (const step of draft?.steps ?? []) for (const medium of step.media) if (!medium.file || medium.file.status === 'AVAILABLE') ids.add(medium.fileId)
    for (const step of shownValue?.steps ?? []) for (const medium of step.media) if (medium.file?.status === 'AVAILABLE') ids.add(medium.fileId)
    return [...ids].sort()
  }, [draft, shownValue])
  useEffect(() => {
    if (!can.seeMedia) return
    const missing = fileIds.filter((id) => !(id in mediaSrc))
    if (missing.length === 0) return
    let gone = false
    void (async () => {
      for (const fileId of missing) {
        try {
          const download = await mediaDownload(api, fileId)
          if (!gone) setMediaSrc((known) => ({ ...known, [fileId]: storeUrl(download.url) }))
        } catch {
          if (!gone) setMediaSrc((known) => ({ ...known, [fileId]: null }))
        }
      }
    })()
    return () => {
      gone = true
    }
  }, [api, can.seeMedia, fileIds.join(',')])

  // ---- Versions: two compared ----
  useEffect(() => {
    if (!current || address.tab !== 'versions') return
    if (compareIds) return
    setCompareIds(address.compare ? { beforeId: address.compare, afterId: shownVersionId(current, address.version) } : defaultPair(current))
  }, [address.tab, current !== null])
  useEffect(() => {
    if (!compareIds?.beforeId || !compareIds.afterId) {
      setBefore(null)
      setAfter(null)
      return
    }
    const controller = new AbortController()
    setBefore(reading())
    setAfter(reading())
    getVersion(api, instructionId, compareIds.beforeId, null, controller.signal)
      .then((answer) => setBefore(ready(answer)))
      .catch((error: unknown) => !controller.signal.aborted && setBefore(failed(readProblem(error))))
    getVersion(api, instructionId, compareIds.afterId, compareIds.beforeId, controller.signal)
      .then((answer) => setAfter(ready(answer)))
      .catch((error: unknown) => !controller.signal.aborted && setAfter(failed(readProblem(error))))
    return () => controller.abort()
  }, [api, instructionId, compareIds?.beforeId, compareIds?.afterId, compareTry])

  // ---- Acknowledgements ----
  const loadAcks = useCallback(async () => {
    try {
      const answer = await getAcknowledgements(api, instructionId)
      setAcks(ready(answer))
      return answer
    } catch (error) {
      setAcks(failed(readProblem(error)))
      return null
    }
  }, [api, instructionId])
  useEffect(() => {
    if (address.tab !== 'acks' || !can.view) return
    setAcks((previous) => previous ?? reading())
    void loadAcks()
  }, [address.tab, acksTry, loadAcks, can.view])

  // ---- live: a change by someone else ----
  const changes = shownValue && draft ? changesOf(shownValue, draft) : 0
  const held = useRef({ record: current, changes })
  held.current = { record: current, changes }
  useLiveChanges({
    onChange: (change) => {
      if (!change.type.startsWith('production.instruction_')) return
      if (change.fields.instructionId !== undefined && change.fields.instructionId !== instructionId) return
      if (busyRef.current) return
      const before = held.current.record
      void getInstruction(api, instructionId)
        .then((answer) => {
          if (!before) return
          const moved = answer.instruction.version !== before.instruction.version || answer.versions.length !== before.versions.length || answer.versions.some((version) => version.version !== before.versions.find((entry) => entry.id === version.id)?.version)
          if (moved) setChangedElsewhere(true)
        })
        .catch(() => undefined)
    },
    onReconnect: () => undefined,
  })

  const reloadAll = useCallback(async () => {
    setChangedElsewhere(false)
    const answer = await loadRecord(true)
    if (answer) await loadShown(shownVersionId(answer, address.version))
    if (address.tab === 'acks') void loadAcks()
  }, [address.tab, address.version, loadAcks, loadRecord, loadShown])

  // ---- writes ----
  const save = useCallback(async () => {
    if (!shownValue || !draft || !current) return
    if (problemsOf(draft).length > 0) {
      setShowProblems(true)
      return
    }
    setBusy('save')
    saveKey.current ??= newIdempotencyKey()
    try {
      const answer = await saveVersion(api, instructionId, shownValue.version.id, saveBodyOf(shownValue.version, draft), saveKey.current)
      saveKey.current = null
      setShown(ready(answer))
      setDraft(draftOf(answer))
      setShowProblems(false)
      setRefused([])
      setSavedAt(new Date().toISOString())
      setNotice({ key: 'notice.saved', params: { number: answer.version.number }, tone: 'success' })
      await loadRecord(true)
    } catch (error) {
      const problem = writeProblem(error)
      if (!problem.stale) saveKey.current = null
      setShowProblems(true)
      setRefused(problem.paths)
      setNotice({ key: problem.key, tone: 'danger' })
      if (problem.stale) setChangedElsewhere(true)
    } finally {
      setBusy(null)
    }
  }, [api, current, draft, instructionId, loadRecord, shownValue])

  const approve = useCallback(async () => {
    if (!current) return
    const target = current.versions.find((version) => version.id === current.draftVersionId)
    if (!target) return
    setBusy('approve')
    writeKey.current ??= newIdempotencyKey()
    try {
      const answer = await publishVersion(api, instructionId, target.id, { version: target.version }, writeKey.current)
      writeKey.current = null
      setNotice({ key: answer.superseded ? 'notice.publishedSuperseding' : 'notice.published', params: { number: answer.version.number, old: answer.superseded?.number ?? 0 }, tone: 'success' })
      writeAddress({ ...address, approve: false, version: null })
      const fresh = await loadRecord(true)
      if (fresh) await loadShown(shownVersionId(fresh, null))
    } catch (error) {
      const problem = writeProblem(error)
      if (!problem.stale) writeKey.current = null
      setNotice({ key: problem.key, tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }, [address, api, current, instructionId, loadRecord, loadShown, writeAddress])

  const newVersion = useCallback(async () => {
    if (!current || dialog?.kind !== 'newVersion') return
    setBusy('newVersion')
    writeKey.current ??= newIdempotencyKey()
    try {
      const answer = await draftVersion(api, instructionId, { version: current.instruction.version, changeNote: dialog.changeNote.trim() || null }, writeKey.current)
      writeKey.current = null
      setDialog(null)
      setNotice({ key: 'notice.newVersion', params: { number: answer.version.number }, tone: 'success' })
      writeAddress({ ...address, tab: address.tab === 'versions' || address.tab === 'acks' ? 'steps' : address.tab, version: null, approve: false })
      await loadRecord(true)
    } catch (error) {
      writeKey.current = null
      setDialog({ ...dialog, problem: writeProblem(error).key })
    } finally {
      setBusy(null)
    }
  }, [address, api, current, dialog, instructionId, loadRecord, writeAddress])

  const discard = useCallback(async () => {
    if (!current || dialog?.kind !== 'discard') return
    if (!dialog.reason.trim()) {
      setDialog({ ...dialog, shown: true })
      return
    }
    const target = current.versions.find((version) => version.id === current.draftVersionId)
    if (!target) return
    setBusy('discard')
    writeKey.current ??= newIdempotencyKey()
    try {
      await discardVersion(api, instructionId, target.id, { version: target.version, reason: dialog.reason.trim() }, writeKey.current)
      writeKey.current = null
      setDialog(null)
      setNotice({ key: 'notice.discarded', params: { number: target.number }, tone: 'success' })
      writeAddress({ ...address, version: null, approve: false })
      await loadRecord(true)
    } catch (error) {
      writeKey.current = null
      setDialog({ ...dialog, problem: writeProblem(error).key })
    } finally {
      setBusy(null)
    }
  }, [address, api, current, dialog, instructionId, loadRecord, writeAddress])

  const changeStatus = useCallback(async () => {
    if (!current || dialog?.kind !== 'status') return
    setBusy('status')
    writeKey.current ??= newIdempotencyKey()
    try {
      const answer = await setStatus(api, instructionId, dialog.to, { version: current.instruction.version, reason: dialog.reason.trim() || null }, writeKey.current)
      writeKey.current = null
      setRecord(ready(answer))
      setDialog(null)
      setNotice({ key: dialog.to === 'ARCHIVED' ? 'notice.archived' : 'notice.restored', params: { number: answer.instruction.number }, tone: 'success' })
    } catch (error) {
      writeKey.current = null
      setDialog({ ...dialog, problem: writeProblem(error).key })
    } finally {
      setBusy(null)
    }
  }, [api, current, dialog, instructionId])

  const paper = useCallback(async () => {
    const value = valueOf(acks)
    if (dialog?.kind !== 'paper' || !value?.current || !dialog.workerId) return
    setBusy('paper')
    writeKey.current ??= newIdempotencyKey()
    try {
      const at = dialog.date === todayIso() ? undefined : new Date(`${dialog.date}T12:00:00Z`).toISOString()
      const answer = await recordPaper(api, instructionId, value.current.versionId, { workerId: dialog.workerId, locale: dialog.locale, ...(at ? { acknowledgedAt: at } : {}) }, writeKey.current)
      writeKey.current = null
      setAcks(ready(answer))
      setDialog(null)
      setNotice({ key: 'notice.paper', tone: 'success' })
    } catch (error) {
      writeKey.current = null
      setDialog({ ...dialog, problem: writeProblem(error).key })
    } finally {
      setBusy(null)
    }
  }, [acks, api, dialog, instructionId])

  // ---- uploads: each file announced, sent to the store, confirmed, then put on the step of the draft ----
  const upload = useCallback(
    (stepKey: string, files: File[]) => {
      for (const file of files) {
        const key = `${stepKey}:${file.name}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`
        const kind = mediaKindOf(file)
        if ('problem' in kind) {
          setUploads((list) => [...list, { key, stepKey, name: file.name, state: 'failed', problem: kind.problem }])
          continue
        }
        setUploads((list) => [...list, { key, stepKey, name: file.name, state: 'uploading', problem: null }])
        void (async () => {
          try {
            const bytes = await file.arrayBuffer()
            const sha256 = await sha256Hex(bytes)
            const announced = await announceMedia(api, instructionId, { kind: kind.kind, originalName: file.name, contentType: file.type.toLowerCase(), sizeBytes: file.size, sha256 })
            await putToStore(announced.upload, bytes)
            const done = await completeMedia(api, instructionId, announced.fileId)
            setDraft((current) =>
              current
                ? {
                    ...current,
                    steps: current.steps.map((step) =>
                      step.key === stepKey && !step.media.some((medium) => medium.fileId === done.id)
                        ? { ...step, media: [...step.media, { key: done.id, fileId: done.id, kind: kind.kind, caption: {}, file: { originalName: done.originalName, contentType: done.contentType, sizeBytes: done.sizeBytes, status: done.status } }] }
                        : step,
                    ),
                  }
                : current,
            )
            if (done.status === 'AVAILABLE' && file.type.startsWith('image/')) setMediaSrc((known) => ({ ...known, [done.id]: URL.createObjectURL(file) }))
            setUploads((list) => list.filter((entry) => entry.key !== key))
          } catch (error) {
            setUploads((list) => list.map((entry) => (entry.key === key ? { ...entry, state: 'failed', problem: writeProblem(error).key } : entry)))
          }
        })()
      }
    },
    [api, instructionId],
  )

  const facts = { can, me: session.user.id, offline }
  const editable = current && shownRow ? editHeld(current, shownRow, facts) === null : false

  const model: RecordModel = {
    prefix,
    me: session.user.id,
    can,
    address,
    record,
    shown,
    draft: editable ? draft : null,
    changes: editable ? changes : 0,
    showProblems,
    refused,
    language,
    openStep,
    mediaSrc,
    uploads,
    compare: { beforeId: compareIds?.beforeId ?? null, afterId: compareIds?.afterId ?? null, before, after },
    acks,
    dialog,
    busy,
    notice,
    offline,
    changedElsewhere,
    savedAt,
  }

  return (
    <InstructionRecordView
      model={model}
      actions={{
        onDraft: (next) => setDraft(next),
        onOpenStep: setOpenStep,
        onLanguage: setLanguage,
        onUpload: upload,
        onDismissUpload: (key) => setUploads((list) => list.filter((entry) => entry.key !== key)),
        onCompare: (beforeId, afterId) => setCompareIds({ beforeId, afterId }),
        onRetryCompare: () => setCompareTry((n) => n + 1),
        onRetryAcks: () => setAcksTry((n) => n + 1),
        onPaperOpen: () => setDialog({ kind: 'paper', workerId: '', locale: pageLocale === 'en' ? 'en' : 'it', date: todayIso(), problem: null }),
        onDiscardChanges: () => {
          if (shownValue) setDraft(draftOf(shownValue))
          setShowProblems(false)
          setRefused([])
          setOpenStep(null)
        },
        onSave: () => void save(),
        onReload: () => void reloadAll(),
        onRetry: () => {
          setRecord(reading())
          void loadRecord()
        },
        onDismissNotice: () => setNotice(null),
        onApproveOpen: () => {
          setNotice(null)
          writeAddress({ ...address, approve: true })
        },
        onApproveClose: () => writeAddress({ ...address, approve: false }),
        onApprove: () => void approve(),
        onNewVersionOpen: () => setDialog({ kind: 'newVersion', changeNote: '', problem: null }),
        onDiscardOpen: () => setDialog({ kind: 'discard', reason: '', shown: false, problem: null }),
        onStatusOpen: (to) => setDialog({ kind: 'status', to, reason: '', problem: null }),
        onDialog: setDialog,
        onNewVersion: () => void newVersion(),
        onDiscard: () => void discard(),
        onStatus: () => void changeStatus(),
        onPaper: () => void paper(),
      }}
    />
  )
}
