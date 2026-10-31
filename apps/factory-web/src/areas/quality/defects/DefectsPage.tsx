'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { createScopedTranslator, messagesFor } from '../../../lib/i18n/messages'
import { useLocale } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { csvLine, downloadText, liveMatches, useLive } from '../_shared/hooks'
import {
  addStandardDispositions,
  addStarter,
  createDefect,
  createDisposition,
  deleteDefect,
  editDefect,
  editDisposition,
  pictureAddress,
  readDispositions,
  readLibrary,
  uploadPicture,
  type DefectCode,
  type Disposition,
  type Dispositions,
  type Library,
} from './api'
import {
  addressOf,
  allCodes,
  defectChange,
  DISPOSITION_CSV_HEAD,
  dispositionChange,
  dispositionCsvRow,
  EMPTY_PICTURE,
  fieldOfDefectEdit,
  fieldProblemsOf,
  findCode,
  LIBRARY_CSV_HEAD,
  libraryCsvRow,
  libraryRows,
  LIVE_EVENTS,
  markKey,
  NEW_DEFECT,
  NEW_DISPOSITION,
  newDefectBody,
  newDefectProblems,
  newDispositionBody,
  newDispositionProblems,
  problemOf,
  queryOf,
  readProblemOf,
  withCode,
  withNewCode,
  withoutCode,
  type Address,
  type DefectField,
  type DefectsDialog,
  type DefectsModel,
  type DispositionField,
  type Mark,
  type Notice,
  type PictureState,
  type ReadOf,
} from './model'
import { DefectsView } from './view/DefectsView'
import { zoneWords } from './zones/zones'

const reading = <T,>(): ReadOf<T> => ({ value: null, problem: null })
const ready = <T,>(value: T): ReadOf<T> => ({ value, problem: null })
const failed = <T,>(problem: string): ReadOf<T> => ({ value: null, problem })

/** At most this many pictures are read for the list's thumbnails (each a presigned address). */
const THUMBS = 60

/**
 * The Defects & dispositions container (`/w/<company>/quality/defects`, SCR-079): reads the library and the disposition
 * codes, keeps the address (`?tab=` `?view=` `?q=` `?open=` `?new=1`), saves each cell or drawer field on its own with the
 * version read (the mark says saving, saved, refused with why, or unknown), retires after the confirm, deletes an unused
 * code, adds a defect, a category, a disposition, the starter set and the standard codes, uploads a code's picture (a file
 * or a photo with markup), exports CSV, and listens to the live stream (changes wait behind "N updates · Show").
 */
export function DefectsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const permissions = useMemo(() => new Set(session.permissions), [session.permissions])
  const canView = permissions.has('quality.defects.view')
  const canUpload = permissions.has('files.upload')
  const seesCost = permissions.has('money.cost')
  const prefix = companyPrefix(session.company?.code ?? '')
  const address = addressOf(params)
  const t = useMemo(() => createScopedTranslator(locale, messagesFor(locale, ['defects']), 'defects'), [locale])

  const [library, setLibrary] = useState<ReadOf<Library>>(reading())
  const [dispositions, setDispositions] = useState<ReadOf<Dispositions>>(reading())
  const [marks, setMarks] = useState<Readonly<Record<string, Mark>>>({})
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<DefectsDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [updates, setUpdates] = useState(0)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [picture, setPicture] = useState<PictureState>(EMPTY_PICTURE)
  const [thumbs, setThumbs] = useState<Readonly<Record<string, string>>>({})
  const asked = useRef<Set<string>>(new Set())
  const createKey = useRef<string | null>(null)

  const writeAddress = useCallback(
    (change: Partial<Address>) => {
      const next = { ...address, ...change, isNew: false }
      router.replace(`${pathname}${queryOf(next)}`, { scroll: false })
    },
    [address, pathname, router],
  )

  // ---- reads ----
  const loadLibrary = useCallback(async () => {
    if (!canView) return
    try {
      setLibrary(ready(await readLibrary(api)))
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      setLibrary(failed(readProblemOf(error)))
    }
  }, [api, canView])
  const loadDispositions = useCallback(async () => {
    if (!canView) return
    try {
      setDispositions(ready(await readDispositions(api)))
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      setDispositions(failed(readProblemOf(error)))
    }
  }, [api, canView])
  useEffect(() => {
    void loadLibrary()
    void loadDispositions()
  }, [loadLibrary, loadDispositions])

  // The pictures' addresses (thumbnails and the drawer), each asked once.
  useEffect(() => {
    const ids = allCodes(library.value)
      .map((code) => code.pictureFileId)
      .filter((id): id is string => !!id && !asked.current.has(id))
      .slice(0, THUMBS)
    for (const id of ids) {
      asked.current.add(id)
      pictureAddress(api, id)
        .then((src) => setThumbs((current) => ({ ...current, [id]: src })))
        .catch(() => undefined)
    }
  }, [api, library.value])

  const live = useLive(
    (change) => {
      if (liveMatches(change, LIVE_EVENTS)) setUpdates((count) => count + 1)
    },
    () => {
      void loadLibrary()
      void loadDispositions()
    },
  )

  // `?new=1`: the tab's Add dialog, once the read is in.
  useEffect(() => {
    if (!address.isNew || dialog) return
    if (address.tab === 'defects' && library.value?.canManage) openNewDefect(null)
    if (address.tab === 'dispositions' && dispositions.value?.canManage) openNewDisposition()
    // Only the address and the reads open it.
  }, [address.isNew, address.tab, library.value, dispositions.value])

  // A tab change clears the selection (each list has its own).
  useEffect(() => setSelected([]), [address.tab])

  const setMark = (id: string, field: string, mark: Mark | null) =>
    setMarks((current) => {
      const next = { ...current }
      if (mark) next[markKey(id, field)] = mark
      else delete next[markKey(id, field)]
      return next
    })

  // ---- the library's writes ----
  const saveDefect = useCallback(
    async (code: DefectCode, field: DefectField, value: unknown) => {
      const change = defectChange(code, field, value)
      if (!change) return
      if ('problem' in change) {
        setMark(code.id, field, { state: 'refused', problem: change.problem })
        return
      }
      const markField = fieldOfDefectEdit(change.edit)
      setMark(code.id, markField, { state: 'saving' })
      try {
        const answer = await editDefect(api, code.id, code.version, change.edit, newIdempotencyKey())
        setLibrary((current) => (current.value ? ready(withCode(current.value, answer.defect)) : current))
        setMark(code.id, markField, { state: 'saved' })
      } catch (error) {
        const problem = problemOf(error)
        setMark(code.id, markField, { state: problem.unknown ? 'unknown' : 'refused', problem: problem.key })
        if (problem.key === 'problem.stale' || problem.key === 'problem.gone') void loadLibrary()
      }
    },
    [api, loadLibrary],
  )

  /** Retire or restore codes one after the other; each refusal is named in the notice. */
  const setActive = useCallback(
    async (ids: readonly string[], active: boolean) => {
      const codes = ids.map((id) => findCode(library.value, id)?.code).filter((code): code is DefectCode => !!code && code.active !== active)
      if (codes.length === 0) return
      setBusy(true)
      const refused: { code: string; key: string }[] = []
      let done = 0
      for (const code of codes) {
        setMark(code.id, 'active', { state: 'saving' })
        try {
          const answer = await editDefect(api, code.id, code.version, { active }, newIdempotencyKey())
          setLibrary((current) => (current.value ? ready(withCode(current.value, answer.defect)) : current))
          setMark(code.id, 'active', { state: 'saved' })
          done += 1
        } catch (error) {
          const problem = problemOf(error)
          setMark(code.id, 'active', { state: problem.unknown ? 'unknown' : 'refused', problem: problem.key })
          refused.push({ code: code.code, key: problem.key })
        }
      }
      setBusy(false)
      setDialog(null)
      setNotice({ key: active ? 'done.restored' : 'done.retired', params: { count: done }, tone: refused.length > 0 ? 'warning' : 'success', ...(refused.length > 0 ? { refused } : {}) })
      if (refused.some((entry) => entry.key === 'problem.stale')) void loadLibrary()
    },
    [api, library.value, loadLibrary],
  )

  const confirmDelete = useCallback(async () => {
    if (dialog?.kind !== 'delete') return
    const found = findCode(library.value, dialog.id)
    if (!found) return
    setBusy(true)
    try {
      await deleteDefect(api, found.code.id, found.code.version, newIdempotencyKey())
      setLibrary((current) => (current.value ? ready(withoutCode(current.value, found.code.id)) : current))
      setSelected((current) => current.filter((id) => id !== found.code.id))
      setNotice({ key: 'done.deleted', params: { code: found.code.code }, tone: 'success' })
      if (address.open === found.code.id) writeAddress({ open: null })
      setDialog(null)
    } catch (error) {
      setNotice({ key: problemOf(error).key, tone: 'danger' })
      setDialog(null)
      void loadLibrary()
    } finally {
      setBusy(false)
    }
  }, [address.open, api, dialog, library.value, loadLibrary, writeAddress])

  function openNewDefect(parentId: string | null) {
    createKey.current = null
    const draft = { ...NEW_DEFECT, parentId }
    setDialog({ kind: 'new-defect', draft, problems: newDefectProblems(draft, library.value), problem: null, shown: false })
  }
  function openNewDisposition() {
    createKey.current = null
    setDialog({ kind: 'new-disposition', draft: NEW_DISPOSITION, problems: newDispositionProblems(NEW_DISPOSITION, (dispositions.value?.dispositions ?? []).map((row) => row.code), seesCost), problem: null, shown: false })
  }

  const createDefectNow = useCallback(async () => {
    if (dialog?.kind !== 'new-defect') return
    const problems = newDefectProblems(dialog.draft, library.value)
    if (Object.keys(problems).length > 0) {
      setDialog({ ...dialog, problems, shown: true })
      return
    }
    setBusy(true)
    createKey.current ??= newIdempotencyKey()
    try {
      const answer = await createDefect(api, newDefectBody(dialog.draft), createKey.current)
      createKey.current = null
      setLibrary((current) => (current.value ? ready(withNewCode(current.value, answer.defect)) : current))
      setDialog(null)
      setNotice({ key: answer.defect.parentId ? 'done.added' : 'done.addedCategory', params: { code: answer.defect.code }, tone: 'success' })
      writeAddress({ open: answer.defect.id })
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'unavailable') createKey.current = null
      const fields = fieldProblemsOf(error)
      setDialog({ ...dialog, problems: { ...problems, ...fields }, problem: Object.keys(fields).length > 0 ? null : problemOf(error).key, shown: true })
    } finally {
      setBusy(false)
    }
  }, [api, dialog, library.value, writeAddress])

  const starter = useCallback(async () => {
    setBusy(true)
    try {
      const answer = await addStarter(api, newIdempotencyKey())
      setNotice({ key: 'done.starter', params: { count: answer.added.length }, tone: 'success' })
      await loadLibrary()
    } catch (error) {
      setNotice({ key: problemOf(error).key, tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [api, loadLibrary])

  const upload = useCallback(
    async (code: DefectCode, file: Blob, name: string) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type || 'image/jpeg')) {
        setPicture({ uploading: false, problem: 'picture.wrongType' })
        return
      }
      setPicture({ uploading: true, problem: null })
      setDialog(null)
      try {
        const answer = await uploadPicture(api, { companyId: session.company?.id ?? null, defectId: code.id, version: code.version, file, name })
        setLibrary((current) => (current.value ? ready(withCode(current.value, answer.defect)) : current))
        const fileId = answer.defect.pictureFileId
        if (fileId) {
          asked.current.add(fileId)
          pictureAddress(api, fileId)
            .then((src) => setThumbs((current) => ({ ...current, [fileId]: src })))
            .catch(() => undefined)
        }
        setPicture(EMPTY_PICTURE)
        setMark(code.id, 'picture', { state: 'saved' })
      } catch (error) {
        setPicture({ uploading: false, problem: problemOf(error).key === 'problem.stale' ? 'problem.stale' : 'picture.failed' })
        if (problemOf(error).key === 'problem.stale') void loadLibrary()
      }
    },
    [api, loadLibrary, session.company?.id],
  )

  // ---- the disposition codes' writes ----
  const saveDisposition = useCallback(
    async (code: Disposition, field: DispositionField, value: unknown) => {
      const change = dispositionChange(code, field, value, seesCost)
      if (!change) return
      if ('problem' in change) {
        setMark(code.id, field, { state: 'refused', problem: change.problem })
        return
      }
      setMark(code.id, field, { state: 'saving' })
      try {
        const answer = await editDisposition(api, code.id, code.version, change.edit, newIdempotencyKey())
        setDispositions((current) => (current.value ? ready({ ...current.value, dispositions: current.value.dispositions.map((row) => (row.id === code.id ? answer.disposition : row)) }) : current))
        setMark(code.id, field, { state: 'saved' })
      } catch (error) {
        const problem = problemOf(error)
        setMark(code.id, field, { state: problem.unknown ? 'unknown' : 'refused', problem: problem.key })
        if (problem.key === 'problem.stale') void loadDispositions()
      }
    },
    [api, loadDispositions, seesCost],
  )

  const bulkDispositions = useCallback(
    async (active: boolean) => {
      const codes = (dispositions.value?.dispositions ?? []).filter((row) => selected.includes(row.id) && row.active !== active)
      if (codes.length === 0) return
      setBusy(true)
      const refused: { code: string; key: string }[] = []
      for (const code of codes) {
        try {
          const answer = await editDisposition(api, code.id, code.version, { active }, newIdempotencyKey())
          setDispositions((current) => (current.value ? ready({ ...current.value, dispositions: current.value.dispositions.map((row) => (row.id === code.id ? answer.disposition : row)) }) : current))
        } catch (error) {
          refused.push({ code: code.code, key: problemOf(error).key })
        }
      }
      setBusy(false)
      setNotice({ key: active ? 'done.activated' : 'done.deactivated', params: { count: codes.length - refused.length }, tone: refused.length > 0 ? 'warning' : 'success', ...(refused.length > 0 ? { refused } : {}) })
    },
    [api, dispositions.value, selected],
  )

  const createDispositionNow = useCallback(async () => {
    if (dialog?.kind !== 'new-disposition') return
    const codes = (dispositions.value?.dispositions ?? []).map((row) => row.code)
    const problems = newDispositionProblems(dialog.draft, codes, seesCost)
    if (Object.keys(problems).length > 0) {
      setDialog({ ...dialog, problems, shown: true })
      return
    }
    setBusy(true)
    createKey.current ??= newIdempotencyKey()
    try {
      const answer = await createDisposition(api, newDispositionBody(dialog.draft, seesCost), createKey.current)
      createKey.current = null
      setDispositions((current) => (current.value ? ready({ ...current.value, dispositions: [...current.value.dispositions, answer.disposition] }) : current))
      setDialog(null)
      setNotice({ key: 'done.addedDisposition', params: { code: answer.disposition.code }, tone: 'success' })
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'unavailable') createKey.current = null
      const fields = fieldProblemsOf(error)
      const problem = problemOf(error)
      setDialog({ ...dialog, problems: { ...problems, ...fields, ...(problem.key === 'problem.codeTaken' || problem.key === 'problem.codeTakenRetired' ? { code: 'problem.codeTaken' } : {}) }, problem: Object.keys(fields).length > 0 ? null : problem.key, shown: true })
    } finally {
      setBusy(false)
    }
  }, [api, dialog, dispositions.value, seesCost])

  const standard = useCallback(async () => {
    setBusy(true)
    try {
      const answer = await addStandardDispositions(api, newIdempotencyKey())
      setNotice({ key: 'done.standard', params: { count: answer.added.length }, tone: 'success' })
      await loadDispositions()
    } catch (error) {
      setNotice({ key: problemOf(error).key, tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [api, loadDispositions])

  // ---- export ----
  const exportLibrary = (ids: readonly string[] | null) => {
    const rows = libraryRows(library.value, ids ? 'all' : address.view, ids ? '' : address.q).filter((row) => !ids || ids.includes(row.id))
    const lines = [csvLine(LIBRARY_CSV_HEAD.map((key) => t(key))), ...rows.map((row) => csvLine(libraryCsvRow(row, t, (zone) => zoneWords(zone, locale))))]
    downloadText(`defect-library-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'))
  }
  const exportDispositions = (ids: readonly string[]) => {
    const rows = (dispositions.value?.dispositions ?? []).filter((row) => ids.includes(row.id))
    const lines = [csvLine(DISPOSITION_CSV_HEAD.map((key) => t(key))), ...rows.map((row) => csvLine(dispositionCsvRow(row, t)))]
    downloadText(`disposition-codes-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'))
  }

  const model: DefectsModel = {
    prefix,
    canView,
    canUpload,
    seesCost,
    address,
    library,
    dispositions,
    selected,
    marks,
    asOf,
    live,
    updates,
    busy,
    notice,
    dialog,
    picture,
    thumbs,
  }

  return (
    <DefectsView
      model={model}
      actions={{
        onAddress: (change) => {
          if (change.open !== undefined) setPicture(EMPTY_PICTURE)
          writeAddress(change)
        },
        onSelect: (ids) => setSelected([...ids]),
        onShowUpdates: () => {
          void loadLibrary()
          void loadDispositions()
        },
        onRetry: () => {
          void loadLibrary()
          void loadDispositions()
        },
        onDialog: (next) => {
          setDialog(next)
          if (!next && address.isNew) writeAddress({})
        },
        onNewDefect: (parentId) => openNewDefect(parentId ?? null),
        onNewDisposition: openNewDisposition,
        onDefectDraft: (draft) => dialog?.kind === 'new-defect' && setDialog({ ...dialog, draft, problems: newDefectProblems(draft, library.value), problem: null }),
        onDispositionDraft: (draft) =>
          dialog?.kind === 'new-disposition' && setDialog({ ...dialog, draft, problems: newDispositionProblems(draft, (dispositions.value?.dispositions ?? []).map((row) => row.code), seesCost), problem: null }),
        onCreateDefect: () => void createDefectNow(),
        onCreateDisposition: () => void createDispositionNow(),
        onDefectCell: (code, field, value) => void saveDefect(code, field, value),
        onDispositionCell: (code, field, value) => void saveDisposition(code, field, value),
        onRetire: (ids) => {
          const codes = ids.map((id) => findCode(library.value, id)?.code).filter((code) => code && code.active)
          if (codes.length > 0) setDialog({ kind: 'retire', ids: codes.map((code) => code!.id) })
        },
        onConfirmRetire: () => dialog?.kind === 'retire' && void setActive(dialog.ids, false),
        onBulkActive: (active) => void setActive(selected, active),
        onBulkDispositions: (active) => void bulkDispositions(active),
        onDelete: (id) => setDialog({ kind: 'delete', id }),
        onConfirmDelete: () => void confirmDelete(),
        onPicture: (code, file, name) => void upload(code, file, name),
        onPhoto: (code, photo: CapturedPhoto) => void upload(code, photo.marked ?? photo.photo, `${code.code}.jpg`),
        onStarter: () => void starter(),
        onStandard: () => void standard(),
        onExportLibrary: exportLibrary,
        onExportDispositions: exportDispositions,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
