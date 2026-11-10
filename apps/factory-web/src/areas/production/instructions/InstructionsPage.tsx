'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useLiveChanges } from '../../../record-panels/live'
import { bringTypedSteps, createInstruction, getInstruction, listInstructions, listOperations, listStyles, setStatus, styleRevisions, typedSteps, type InstructionList } from './api'
import { EMPTY_NEW, instructionsCan, listAddressOf, listCsv, listQueryText, NAMESPACES, NS, readProblem, rowsOfView, statusOfView, tileCounts, writeProblem, type ListAddress, type NewDraft, type Notice } from './model'
import { InstructionsListView, type InstructionsListModel, type NewInstructionModel, type TypedModel } from './view/InstructionsListView'

function downloadCsv(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * `/w/<company>/production/instructions?view=&q=&new=1&typed=1` (SCR-141): the company's work instructions (the ACTIVE list,
 * or the ARCHIVED one for that view; the API sends each whole, at most 500), the tiles from the same read, live
 * `production.instruction_*` changes behind "N updates · Show", New instruction (`c`, `?new=1`: makes the instruction and
 * its version 1 as a draft, then opens it), Bring in typed steps (`?typed=1`: the dry run, then once), Export N (CSV of the
 * rows), Archive N / Restore N one by one (each record read for its version first).
 */
export function InstructionsPage() {
  return (
    <WithMessages namespaces={[...NAMESPACES]}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT(NS)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const address = useMemo(() => listAddressOf(params), [params])
  const can = useMemo(() => instructionsCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/production\/instructions\/?$/, '')
  const companyId = session.company?.id ?? null
  const status = statusOfView(address.view)

  const [list, setList] = useState<InstructionList | null>(null)
  const [active, setActive] = useState<InstructionList | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [creating, setCreating] = useState<NewInstructionModel | null>(null)
  const [typed, setTyped] = useState<TypedModel | null>(null)
  const readSeq = useRef(0)
  const createKey = useRef<string | null>(null)
  const typedKey = useRef<string | null>(null)

  const go = useCallback((next: ListAddress) => router.replace(`${pathname}${listQueryText(next)}`), [pathname, router])

  const load = useCallback(async () => {
    if (!can.view) return
    const mine = ++readSeq.current
    setList(null)
    setProblem(null)
    try {
      const answer = await listInstructions(api, { companyId, status, q: address.q })
      if (mine !== readSeq.current) return
      setList(answer)
      // The tiles count the whole ACTIVE list (a search or the archived view narrows only the rows).
      if (status === 'ACTIVE' && !address.q.trim()) setActive(answer)
      else {
        listInstructions(api, { companyId, status: 'ACTIVE' })
          .then((whole) => mine === readSeq.current && setActive(whole))
          .catch(() => undefined)
      }
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (mine === readSeq.current) setProblem(readProblem(error))
    }
  }, [api, can.view, companyId, status, address.q])

  useEffect(() => {
    void load()
  }, [load])

  useLiveChanges({
    onChange: (change) => {
      if (change.type.startsWith('production.instruction_')) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  // ---- New instruction: the pickers are read when it opens ----
  const openNew = useCallback(
    (open: boolean) => {
      if (!open) {
        setCreating(null)
        createKey.current = null
        if (address.creating) go({ ...address, creating: false })
        return
      }
      if (!can.manage) return
      setCreating({ draft: EMPTY_NEW, operations: { items: null, problem: null }, styles: null, revisions: null, copies: [], busy: false, problem: null })
      if (can.pickOperation) {
        listOperations(api, companyId)
          .then((items) => setCreating((current) => (current ? { ...current, operations: { items, problem: null } } : current)))
          .catch((error: unknown) => setCreating((current) => (current ? { ...current, operations: { items: null, problem: readProblem(error) } } : current)))
      } else setCreating((current) => (current ? { ...current, operations: { items: null, problem: 'problem.forbidden' } } : current))
    },
    [address, api, can.manage, can.pickOperation, companyId, go],
  )
  useEffect(() => {
    if (address.creating && can.manage && !creating) openNew(true)
    // The address opens it once; closing writes the address.
  }, [address.creating])

  useEffect(() => {
    const rows = active?.instructions ?? list?.instructions ?? []
    setCreating((current) => (current ? { ...current, copies: rows.filter((row) => row.current !== null) } : current))
  }, [active, list, creating !== null])

  const setNewDraft = (draft: NewDraft) => {
    const before = creating?.draft
    setCreating((current) => (current ? { ...current, draft, problem: null } : current))
    createKey.current = null
    if (draft.scope === 'revision' && before?.scope !== 'revision' && can.pickStyle && !creating?.styles) {
      setCreating((current) => (current ? { ...current, styles: { items: null, problem: null } } : current))
      listStyles(api)
        .then((items) => setCreating((current) => (current ? { ...current, styles: { items, problem: null } } : current)))
        .catch((error: unknown) => setCreating((current) => (current ? { ...current, styles: { items: null, problem: readProblem(error) } } : current)))
    }
    if (draft.styleId && draft.styleId !== before?.styleId) {
      setCreating((current) => (current ? { ...current, revisions: { items: null, problem: null } } : current))
      styleRevisions(api, draft.styleId)
        .then((items) => setCreating((current) => (current && current.draft.styleId === draft.styleId ? { ...current, revisions: { items, problem: null } } : current)))
        .catch((error: unknown) => setCreating((current) => (current ? { ...current, revisions: { items: null, problem: readProblem(error) } } : current)))
    }
  }

  const create = async () => {
    const model = creating
    if (!model || !companyId) return
    setCreating({ ...model, busy: true, problem: null })
    createKey.current ??= newIdempotencyKey()
    try {
      const record = await createInstruction(
        api,
        {
          companyId,
          operationId: model.draft.operationId,
          styleRevisionId: model.draft.scope === 'revision' ? model.draft.revisionId : null,
          copyVersionId: model.draft.copyFrom || null,
        },
        createKey.current,
      )
      createKey.current = null
      router.push(`${prefix}/production/instructions/${encodeURIComponent(record.instruction.id)}`)
    } catch (error) {
      const refused = writeProblem(error)
      if (!refused.stale) createKey.current = null
      setCreating((current) => (current ? { ...current, busy: false, problem: refused.key } : current))
    }
  }

  // ---- Bring in typed steps ----
  const readTyped = useCallback(
    (language: string) => {
      if (!companyId) return
      setTyped((current) => ({ language, answer: null, problem: null, busy: false, made: current?.made ?? null }))
      typedSteps(api, companyId, language)
        .then((answer) => setTyped((current) => (current ? { ...current, answer } : current)))
        .catch((error: unknown) => setTyped((current) => (current ? { ...current, problem: readProblem(error) } : current)))
    },
    [api, companyId],
  )
  const openTyped = (open: boolean) => {
    if (!open) {
      setTyped(null)
      typedKey.current = null
      if (address.typed) go({ ...address, typed: false })
      return
    }
    if (!can.manage) return
    readTyped(locale === 'en' ? 'en' : 'it')
  }
  useEffect(() => {
    if (address.typed && can.manage && !typed) openTyped(true)
  }, [address.typed])

  const bringTyped = async () => {
    if (!typed || !companyId) return
    setTyped({ ...typed, busy: true, problem: null })
    typedKey.current ??= newIdempotencyKey()
    try {
      const made = await bringTypedSteps(api, { companyId, language: typed.language }, typedKey.current)
      typedKey.current = null
      setTyped((current) => (current ? { ...current, busy: false, made: made.length } : current))
      readTyped(typed.language)
      void load()
    } catch (error) {
      typedKey.current = null
      setTyped((current) => (current ? { ...current, busy: false, problem: writeProblem(error).key } : current))
    }
  }

  // ---- bulk ----
  const exportCsv = (ids: string[]) => {
    const picked = (list?.instructions ?? []).filter((row) => ids.includes(row.id))
    const csv = listCsv(picked, {
      header: ['number', 'operation', 'operationName', 'scope', 'inForce', 'draft', 'languages', 'missing', 'steps', 'media', 'seen', 'usedIn', 'status', 'changed'].map((key) => t(`csv.${key}`)),
      everyStyle: t('list.everyStyle'),
      status: (value) => t(`list.status.${value === 'ARCHIVED' ? 'ARCHIVED' : 'IN_FORCE'}`),
      none: t('list.noneInForce'),
    })
    downloadCsv(`${t('csv.file')}-${new Date().toISOString().slice(0, 10)}.csv`, csv)
  }

  const statusMany = async (ids: string[], to: 'ARCHIVED' | 'ACTIVE', reason: string): Promise<boolean> => {
    setBusy(true)
    let done = 0
    try {
      for (const id of ids) {
        const record = await getInstruction(api, id)
        if (record.instruction.status === to) continue
        await setStatus(api, id, to, { version: record.instruction.version, reason: reason || null }, newIdempotencyKey())
        done++
      }
      setNotice({ key: to === 'ARCHIVED' ? 'notice.archivedMany' : 'notice.restoredMany', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger', params: { count: done } })
      return false
    } finally {
      setBusy(false)
      void load()
    }
  }

  const items = list ? rowsOfView(list.instructions, address.view) : null
  const model: InstructionsListModel = {
    prefix,
    can,
    address,
    rows: { items: problem ? null : items, truncated: list?.truncated ?? false, problem },
    tiles: tileCounts(active ?? (status === 'ACTIVE' ? list : null)),
    asOf,
    updates,
    busy,
    notice,
    creating,
    typed,
  }
  return (
    <InstructionsListView
      model={model}
      actions={{
        onAddress: go,
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/production/instructions/${encodeURIComponent(id)}`),
        onExport: exportCsv,
        onStatusMany: statusMany,
        onNew: openNew,
        onNewDraft: setNewDraft,
        onCreate: () => void create(),
        onTyped: openTyped,
        onTypedLanguage: (language) => readTyped(language),
        onBringTyped: () => void bringTyped(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
