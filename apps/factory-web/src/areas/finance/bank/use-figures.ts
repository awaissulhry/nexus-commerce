'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FiguresAnswer } from '@nexus/factory-domain/receivables-figures/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { downloadLink } from '../../../record-panels/api'
import { findCustomers } from '../_shared/api'
import { correctFigures, getFigures, listFigures, recordFigures, uploadFiguresFile, type FiguresRow } from './api'
import { draftOf, emptyFigures, entriesOf, readProblem, writeProblem, type BankAddress, type BankCan, type FiguresDraft, type Phrase } from './model'
import type { FiguresEditor, FiguresModel } from './view/FiguresSection'

const SLOW_MS = 1000

/**
 * Their figures vs ours (B-W2b-406; FIN-135; `modules/receivables/their-figures`): the list (`GET /receivables/their-figures`),
 * the figures open with their comparison (`?figures=<id>`: `GET …/:id`), recording (`POST`, the statement's file announced for
 * the new figures first: its record id becomes theirs) and correcting at the version read (`PATCH`; `&correct=1`).
 */
export function useFigures(api: ApiClient, can: BankCan, companyId: string | null, address: BankAddress, go: (next: Partial<BankAddress>) => void, today: string, locale: string) {
  const view = can.receivables
  const [rows, setRows] = useState<FiguresRow[] | null>(null)
  const [list, setList] = useState<{ problem: string | null; slow: boolean }>({ problem: null, slow: false })
  const [open, setOpen] = useState<{ id: string; answer: FiguresAnswer | null; problem: string | null } | null>(null)
  const [editor, setEditor] = useState<FiguresEditor | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; phrases: Phrase[] } | null>(null)
  const file = useRef<File | null>(null)
  const key = useRef(newIdempotencyKey())

  const loadList = useCallback(async () => {
    if (!view || !companyId) return
    const slow = setTimeout(() => setList((current) => ({ ...current, slow: true })), SLOW_MS)
    try {
      setRows(await listFigures(api, companyId))
      setList({ problem: null, slow: false })
    } catch (error) {
      setRows(null)
      setList({ problem: readProblem(error), slow: false })
    } finally {
      clearTimeout(slow)
    }
  }, [api, view, companyId])
  useEffect(() => {
    void loadList()
  }, [loadList])

  const openId = address.figures && address.figures !== 'new' ? address.figures : null
  const loadOpen = useCallback(async () => {
    if (!openId || !view) return
    try {
      const answer = await getFigures(api, openId)
      setOpen((current) => (current?.id === openId ? { id: openId, answer, problem: null } : current))
    } catch (error) {
      setOpen((current) => (current?.id === openId ? { id: openId, answer: null, problem: readProblem(error) } : current))
    }
  }, [api, openId, view])
  useEffect(() => {
    if (!openId) {
      setOpen(null)
      return
    }
    setOpen((current) => (current?.id === openId ? current : { id: openId, answer: null, problem: null }))
    void loadOpen()
  }, [openId, loadOpen])

  const searchCustomers = useCallback(
    async (q: string) => {
      try {
        const found = await findCustomers(api, q, companyId)
        setEditor((state) => (state ? { ...state, q, customers: found, customersProblem: null } : state))
      } catch (error) {
        setEditor((state) => (state ? { ...state, q, customers: [], customersProblem: readProblem(error) } : state))
      }
    },
    [api, companyId],
  )

  // The address asks for the editor: a new one, or the open figures' correction once they are read. It opens when the
  // address starts asking (never again while it still asks: a save closes it before the address moves on).
  const wantsCorrect = address.correct && open?.answer ? open.answer : null
  const want = address.figures === 'new' ? 'new' : wantsCorrect ? `correct:${wantsCorrect.figures.id}` : null
  const wanted = useRef<string | null>(null)
  useEffect(() => {
    if (want === wanted.current) return
    wanted.current = want
    if (want === 'new') {
      file.current = null
      key.current = newIdempotencyKey()
      setEditor({ mode: 'new', figuresId: null, version: null, draft: emptyFigures(today), q: '', customers: null, customersProblem: null, busy: false, tried: false, problems: null })
      void searchCustomers('')
    } else if (want && wantsCorrect) {
      key.current = newIdempotencyKey()
      setEditor({ mode: 'correct', figuresId: wantsCorrect.figures.id, version: wantsCorrect.figures.version, draft: draftOf(wantsCorrect, locale), q: '', customers: null, customersProblem: null, busy: false, tried: false, problems: null })
    } else {
      setEditor(null)
    }
  }, [want, wantsCorrect, today, locale, searchCustomers])

  const submit = async () => {
    if (!editor || editor.busy || !companyId) return
    const isNew = editor.mode === 'new'
    const entries = entriesOf(editor.draft, today, isNew)
    if (!entries) {
      setEditor({ ...editor, tried: true })
      return
    }
    setEditor({ ...editor, busy: true, tried: true, problems: null })
    try {
      let answer: FiguresAnswer
      if (isNew) {
        // The statement's file first, announced for the figures it will be kept with (its record id becomes theirs).
        let fileId: string | null = null
        if (file.current && can.upload) {
          const sent = await uploadFiguresFile(api, companyId, crypto.randomUUID(), file.current)
          fileId = sent.fileId
        }
        answer = await recordFigures(api, { companyId, partyId: editor.draft.partyId!, asOf: editor.draft.asOf, figures: entries, note: editor.draft.note.trim() || null, ...(fileId ? { fileId } : {}) }, key.current)
      } else {
        answer = await correctFigures(api, editor.figuresId!, { version: editor.version!, asOf: editor.draft.asOf, figures: entries, note: editor.draft.note.trim() || null }, key.current)
      }
      file.current = null
      setEditor(null)
      setOpen({ id: answer.figures.id, answer, problem: null })
      setNotice({ tone: 'success', phrases: [{ key: isNew ? 'figures.recordedNotice' : 'figures.correctedNotice' }] })
      go({ figures: answer.figures.id, correct: false })
      void loadList()
    } catch (error) {
      key.current = newIdempotencyKey()
      setEditor((state) => (state ? { ...state, busy: false, problems: writeProblem(error) } : state))
    }
  }

  const download = async (fileId: string) => {
    try {
      const link = await downloadLink(api, fileId)
      window.open(link.download.url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setNotice({ tone: 'danger', phrases: writeProblem(error) })
    }
  }

  const model: FiguresModel = {
    can: { view, manage: can.figures, price: can.price, upload: can.upload, filesRead: can.filesRead, parties: can.parties },
    rows,
    problem: list.problem,
    slow: list.slow,
    open,
    editor,
  }

  return {
    model,
    notice,
    setNotice,
    loadList,
    loadOpen,
    download,
    actions: {
      onNew: () => go({ figures: 'new', correct: false }),
      onOpen: (figuresId: string) => go({ figures: figuresId, correct: false }),
      onCloseOpen: () => go({ figures: null, correct: false }),
      // The open figures' own id: right after a record the address may still say `new`.
      onCorrect: () => open && go({ figures: open.id, correct: true }),
      onRetry: (part: 'list' | 'open') => void (part === 'list' ? loadList() : loadOpen()),
      onDownload: (fileId: string) => void download(fileId),
      editor: {
        onDraft: (draft: FiguresDraft) => setEditor((state) => (state ? { ...state, draft, problems: null } : state)),
        onSearch: (q: string) => void searchCustomers(q),
        onCustomer: (customer: { id: string; label: string } | null) => setEditor((state) => (state ? { ...state, draft: { ...state.draft, partyId: customer?.id ?? null, partyLabel: customer?.label ?? '' } } : state)),
        onFile: (chosen: File | null) => {
          file.current = chosen
          setEditor((state) => (state ? { ...state, draft: { ...state.draft, fileName: chosen?.name ?? null } } : state))
        },
        onSubmit: () => void submit(),
        onClose: () => go(address.figures === 'new' ? { figures: null, correct: false } : { correct: false }),
      },
    },
  }
}
