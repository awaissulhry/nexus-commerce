'use client'

import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { FileAudience } from '../../../record-panels/model'
import { downloadLink, setFilePriced } from '../../../record-panels/api'
import { storeUrl } from '../../../record-panels/store'
import { pricedRefusalKey, type ThreadFile } from '../../../lib/record-thread/files/model'
import { carriable, offeredTargets, openRefusal, queryReady, targetLabel, useOnRefusal } from '../../../lib/record-thread/files/use-on'
import type { UseOnModel } from '../../../lib/record-thread/files/view/UseOnDialog'
import { actHeld, visibilityTo, type ActItem, type FileActWindow } from '../../../lib/record-thread/files-view/model'
import { officeOnly, readUseOnTargets, shareWithParty, useFileOn } from './api'
import { addVersion, deleteDocument, renameFile, setVisibility } from './file-acts-api'
import { refusalCode } from './state'

/**
 * F-OF-301 (order FILES tab W3; 13-backend §7 rows 2-3 — the extraction): the acts on a record's files, MOVED here from the docked thread
 * as they were — Mark as priced / take the mark off (`markPriced`), the bulk bar (`bulk`: download, share, office only), "Use on another
 * record…" (`openUseOn`, its window's search and copy) — so the Files window on every record and the order's Files tab act the same way
 * (one path per job). The dock calls it for its record; the order's files container calls it for the order's own files.
 *
 * F-OF-303: the new windows — Who can see… (one file or the chosen ones; it also takes a file back), Rename…, Delete… (the WHOLE document,
 * every version, with a reason: D4 — the window's bulk "Delete N" opens it too, on every record), New version…, Mark as priced? — each at
 * the file's version, a refusal said in the window, one notice after, the files read again.
 */

/** A file the acts write to: its version (every act's lock), who sees it, its name, how many versions its document keeps. */
export interface ActFile {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly visibility: readonly FileAudience[]
  readonly versions: number
  readonly versionNo: number
}

/** A file as a download or a copy reads it (the dock: its thread files; the order: its own files). */
export type CarryFile = Pick<ThreadFile, 'id' | 'name' | 'status'> & { readonly locked?: string | undefined }

export type ActNotice = { readonly ns: string; readonly key: string; readonly params?: Readonly<Record<string, string | number>>; readonly tone: 'success' | 'danger' | 'warning' }
export type BulkKind = 'download' | 'share' | 'officeOnly' | 'remove'

/** A refusal of a window's act in words (keys of record-thread-files-view `acts.problem.*`, the API's words when it gives them). */
export function actProblemOf(error: unknown): { readonly key: string; readonly params?: Readonly<Record<string, string>> } {
  if (!isApiError(error)) return { key: 'acts.problem.failed' }
  const detail = error.issues.find((issue) => issue.message)?.message ?? (error.message || null)
  if (error.kind === 'forbidden') return detail ? { key: 'acts.problem.words', params: { detail } } : { key: 'acts.problem.forbidden' }
  if (error.kind === 'not_found') return { key: 'acts.problem.notFound' }
  if ((error.kind === 'conflict' || error.kind === 'invalid') && detail) return { key: 'acts.problem.words', params: { detail } }
  if (error.kind === 'conflict') return { key: 'acts.problem.stale' }
  return { key: 'acts.problem.failed' }
}

export function useFileActs(
  api: ApiClient,
  input: {
    readonly record: { readonly type: string; readonly id: string }
    /** The files acted on, at their versions (the dock: the record's own; the order: its own files and its lines'). */
    readonly files: readonly ActFile[]
    /** The thread's view of the same files (downloads, what a copy may carry: available, not a sheet locked for this reader). */
    readonly threadFiles: readonly CarryFile[]
    readonly partyId: string | null
    readonly party: { readonly name: string } | null
    readonly canShare: boolean
    readonly notify: (notice: ActNotice) => void
    /** Read the files again after an act. */
    readonly reload: () => void
    /** The choice cleared after a bulk act. */
    readonly onCleared?: () => void
  },
) {
  const { record: key, partyId, party, canShare } = input
  const [busy, setBusy] = useState(false)
  const latest = useRef(input)
  latest.current = input

  // ---- F-CP-144 (B-CP-014): Mark as priced / take the mark off, at the file's version; the list is read again (a reader without prices
  // who marks it sees it locked from now on); a refusal in words (only a price holder takes it off; changed meanwhile). Moved from the dock.
  const markPriced = async (fileId: string, priced: boolean) => {
    const file = latest.current.files.find((one) => one.id === fileId)
    if (!file) return
    setBusy(true)
    try {
      await setFilePriced(api, fileId, { priced, version: file.version })
      latest.current.notify({ ns: 'record-files', key: priced ? 'priced.marked' : 'priced.unmarked', tone: 'success' })
    } catch (error) {
      latest.current.notify({ ns: 'record-files', key: pricedRefusalKey(isApiError(error) ? error.kind : null, refusalCode(error)), tone: 'danger' })
    } finally {
      setBusy(false)
      latest.current.reload()
    }
  }
  // ---- end F-CP-144

  // ---- the bulk bar (moved from the dock): Download N, Share N, Make office only; F-OF-303 (D4): Delete N opens the Delete window ----
  const bulk = async (action: BulkKind, ids: readonly string[]) => {
    const { threadFiles, files, notify } = latest.current
    const chosen = threadFiles.filter((file) => ids.includes(file.id))
    const raw = files.filter((file) => ids.includes(file.id))
    if (action === 'download') {
      for (const file of chosen) {
        try {
          const { download } = await downloadLink(api, file.id)
          const anchor = document.createElement('a')
          anchor.href = storeUrl(download.url)
          anchor.rel = 'noopener'
          anchor.download = file.name
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
        } catch (error) {
          notify({ ns: 'record-thread', key: openRefusal(error), tone: 'danger' })
        }
      }
      return
    }
    if (action === 'remove') return openAct('delete', ids)
    setBusy(true)
    try {
      for (const file of raw) {
        if (action === 'share' && partyId) await shareWithParty(api, file, partyId)
        else if (action === 'officeOnly') await officeOnly(api, file)
      }
      latest.current.onCleared?.()
    } catch {
      notify({ ns: 'record-thread', key: 'notice.failed', tone: 'danger' })
    } finally {
      setBusy(false)
      latest.current.reload()
    }
  }

  // ── B-TH-231: "Use on another record…" (a message's files, a Files view row, the chosen files) — moved from the dock ─────────────
  const emptyUseOn = (files: readonly CarryFile[]): UseOnModel => ({ files: files.map((file) => ({ id: file.id, name: file.name })), party: party ? { name: party.name } : null, query: '', targets: null, searching: false, chosen: null, share: false, canShare, busy: false, problem: null, failed: [], copied: 0 })
  const [useOn, setUseOn] = useState<UseOnModel | null>(null)
  const useOnKeys = useRef(new Map<string, string>())
  const useOnSeq = useRef(0)
  const openUseOn = (ids: readonly string[]) => {
    const files = carriable(latest.current.threadFiles.filter((file) => ids.includes(file.id)))
    if (files.length === 0) return
    useOnKeys.current = new Map()
    setUseOn(emptyUseOn(files))
  }
  const useOnQuery = useOn?.query ?? ''
  const useOnFirst = useOn?.files[0]?.id ?? null
  useEffect(() => {
    if (!useOnFirst) return
    const mine = ++useOnSeq.current
    if (!queryReady(useOnQuery)) {
      setUseOn((now) => (now ? { ...now, targets: null, searching: false } : now))
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setUseOn((now) => (now ? { ...now, searching: true } : now))
      readUseOnTargets(api, useOnFirst, useOnQuery, controller.signal)
        .then((answer) => {
          if (mine !== useOnSeq.current) return
          const targets = answer.tooShort ? null : offeredTargets(answer.targets, { recordType: key.type, recordId: key.id, partyId })
          setUseOn((now) => (now ? { ...now, targets, searching: false, chosen: targets?.some((target) => target.key === now.chosen) ? now.chosen : null } : now))
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || mine !== useOnSeq.current) return
          setUseOn((now) => (now ? { ...now, searching: false, targets: [], problem: useOnRefusal(error) } : now))
        })
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, key.type, key.id, partyId, useOnFirst, useOnQuery])
  const confirmUseOn = async () => {
    const asked = useOn
    const target = asked?.targets?.find((one) => one.key === asked.chosen)
    if (!asked || !target || asked.busy) return
    setUseOn({ ...asked, busy: true, problem: null })
    const failed: { name: string; reason: string }[] = []
    const left: { id: string; name: string }[] = []
    let copied = asked.copied
    for (const file of asked.files) {
      // One key per file and target: "Copy" again after a lost answer never copies twice.
      const keyOf = `${file.id}:${target.key}:${asked.share ? 'shared' : 'office'}`
      const idempotencyKey = useOnKeys.current.get(keyOf) ?? globalThis.crypto.randomUUID()
      useOnKeys.current.set(keyOf, idempotencyKey)
      try {
        await useFileOn(api, file.id, { recordType: target.recordType, recordId: target.recordId, share: asked.share && target.partyId !== null }, idempotencyKey)
        copied += 1
      } catch (error) {
        failed.push({ name: file.name, reason: useOnRefusal(error) })
        left.push(file)
      }
    }
    if (failed.length === 0) {
      setUseOn(null)
      latest.current.notify({ ns: 'record-thread', key: 'notice.copied', params: { target: targetLabel(target) }, tone: 'success' })
      return
    }
    setUseOn((now) => (now ? { ...now, busy: false, files: left, failed, copied, problem: failed.length === asked.files.length && failed.every((one) => one.reason === failed[0]!.reason) ? failed[0]!.reason : null } : now))
  }
  // ── end B-TH-231

  // ---- F-OF-303: the windows of one file or of the chosen files ----
  const [window, setWindow] = useState<FileActWindow | null>(null)
  const [problem, setProblem] = useState<{ readonly key: string; readonly params?: Readonly<Record<string, string>> } | null>(null)
  const versionFile = useRef<File | null>(null)

  const itemsOf = (ids: readonly string[]): ActItem[] => latest.current.files.filter((file) => ids.includes(file.id)).map((file) => ({ id: file.id, name: file.name, version: file.version, visibility: file.visibility, versions: Math.max(1, file.versions), versionNo: file.versionNo }))

  /** Opens a window on these files (a file the read does not hold at a version is left out: no act without its fact). */
  function openAct(kind: FileActWindow['kind'], ids: readonly string[], priced?: boolean): void {
    const items = itemsOf(ids)
    const first = items[0]
    if (!first) return
    setProblem(null)
    versionFile.current = null
    if (kind === 'whoCanSee') return setWindow({ kind, items, to: items.every((item) => item.visibility.includes('PARTNER')) ? 'OFFICE' : 'CUSTOMER' })
    if (kind === 'delete') return setWindow({ kind, items, reason: '' })
    if (kind === 'rename') return setWindow({ kind, items: [first], name: first.name })
    if (kind === 'newVersion') return setWindow({ kind, items: [first], file: null, keepName: true })
    return setWindow({ kind: 'priced', items: [first], priced: priced ?? true })
  }

  const submitAct = async () => {
    const asked = window
    if (!asked || busy || actHeld(asked)) return
    const { notify, partyId: customerId } = latest.current
    setBusy(true)
    setProblem(null)
    try {
      if (asked.kind === 'whoCanSee') {
        for (const item of asked.items) if (asked.to === 'CUSTOMER' ? !item.visibility.includes('PARTNER') : item.visibility.includes('PARTNER')) await setVisibility(api, item, visibilityTo(item.visibility, asked.to), customerId)
        notify({ ns: 'record-thread-files-view', key: 'acts.done.saved', tone: 'success' })
        latest.current.onCleared?.()
      } else if (asked.kind === 'rename') {
        await renameFile(api, asked.items[0].id, { version: asked.items[0].version, name: asked.name.trim() })
        notify({ ns: 'record-thread-files-view', key: 'acts.done.renamed', tone: 'success' })
      } else if (asked.kind === 'delete') {
        for (const item of asked.items) await deleteDocument(api, item.id, { version: item.version, reason: asked.reason.trim() })
        notify({ ns: 'record-thread-files-view', key: 'acts.done.deleted', params: { count: asked.items.length }, tone: 'success' })
        latest.current.onCleared?.()
      } else if (asked.kind === 'newVersion') {
        const file = versionFile.current
        if (!file) return
        const made = await addVersion(api, asked.items[0].id, file, asked.keepName ? asked.items[0].name : file.name)
        notify(made.status === 'AVAILABLE' ? { ns: 'record-thread-files-view', key: 'acts.done.version', tone: 'success' } : { ns: 'record-thread-files-view', key: 'upload.heldTitle', params: { count: 1 }, tone: 'warning' })
      } else {
        setWindow(null)
        await markPriced(asked.items[0].id, asked.priced)
        return
      }
      setWindow(null)
    } catch (error) {
      setProblem(actProblemOf(error))
    } finally {
      setBusy(false)
      latest.current.reload()
    }
  }

  return {
    busy,
    markPriced,
    bulk,
    openUseOn,
    useOn: {
      model: useOn,
      actions: {
        onQuery: (query: string) => setUseOn((now) => (now ? { ...now, query, problem: null } : now)),
        onChoose: (choice: string | null) => setUseOn((now) => (now ? { ...now, chosen: choice, problem: null } : now)),
        onShare: (share: boolean) => setUseOn((now) => (now ? { ...now, share } : now)),
        onConfirm: () => void confirmUseOn(),
        onClose: () => setUseOn(null),
      },
    },
    /** F-OF-303: the window open, whether it is sending, its refusal. */
    acts: { window, busy, problem },
    openAct,
    actActions: {
      onActChange: (next: FileActWindow) => {
        setProblem(null)
        setWindow(next)
      },
      /** New version…: the one file dropped or browsed (kept here: the window shows its name and size). */
      onActFile: (files: readonly File[]) => {
        const file = files[0] ?? null
        versionFile.current = file
        setWindow((now) => (now?.kind === 'newVersion' ? { ...now, file: file ? { name: file.name, sizeBytes: file.size } : null } : now))
      },
      onActSubmit: () => void submitAct(),
      onActClose: () => {
        versionFile.current = null
        setProblem(null)
        setWindow(null)
      },
    },
  }
}
