'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { companyPrefix } from '../../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { problemKey } from '../../../shared/model'
import type { CompanyChoice, ListNotice } from '../../doc-templates/model'
import type { PageView } from '../../doc-templates/view/ViewSwitch'
import { refusalOf, refusalReloads } from '../../template-editor/model'
import { createSavedReply, deleteSavedReply, listSavedReplies, updateSavedReply, type SavedReply } from './api'
import { draftBody, draftOf, newDraft, NO_FILTER, saveHeld, type MailPart, type RepliesFilter, type SavedRepliesModel } from './model'
import { SavedRepliesView } from './view/SavedRepliesView'

const OWN_ECHO_MS = 8000

/**
 * `/w/<company>/admin/documents?view=mail&part=replies&company=<id>` (B-TH-279): the saved replies the reader keeps and the shared
 * ones of the company (`GET /templates/replies?companyId`), written, changed and deleted at the version read (one Idempotency-Key per
 * save attempt: a retry of the same save is the same write). Live: saved_reply.changed → "N updates · Show" (never this page's own
 * echo). Nothing is sent from here.
 */
export function SavedRepliesSection({ companies, companyId, onView, onPart, onCompany }: { companies: readonly CompanyChoice[]; companyId: string | null; onView: (view: PageView) => void; onPart: (part: MailPart) => void; onCompany: (companyId: string) => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const mayWrite = session.permissions.includes('email.send')
  const [read, setRead] = useState<SavedRepliesModel['read']>({ status: 'loading' })
  const [filter, setFilter] = useState<RepliesFilter>(NO_FILTER)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [editor, setEditor] = useState<SavedRepliesModel['editor']>(null)
  const [confirm, setConfirm] = useState<SavedRepliesModel['confirm']>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ListNotice | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const lastWrite = useRef(0)
  const saveKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const answer = await listSavedReplies(api, { companyId })
      setRead({ status: 'ready', answer })
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      setRead({ status: 'failed', problem: problemKey(error) })
    }
  }, [api, companyId])

  useEffect(() => {
    setRead({ status: 'loading' })
    setSelected([])
    void load()
  }, [load])

  useLiveBus({
    onChange: (change) => {
      if (change.type !== 'saved_reply.changed') return
      if (Date.now() - lastWrite.current < OWN_ECHO_MS) return
      setUpdates((count) => count + 1)
    },
    onReconnect: () => void load(),
  })

  const answer = read.status === 'ready' ? read.answer : null
  const replyOf = (id: string | null): SavedReply | null => (id && answer ? (answer.replies.find((one) => one.id === id) ?? null) : null)

  const save = async () => {
    if (!editor || busy) return
    const reply = replyOf(editor.draft.id)
    if (saveHeld({ reply, draft: editor.draft, mayWrite, mayShare: answer?.mayShare ?? false, busy, companyId })) return
    const body = draftBody(reply, editor.draft, companyId)
    if (!body) return
    setBusy(true)
    lastWrite.current = Date.now()
    saveKey.current ??= newIdempotencyKey()
    try {
      const saved = reply ? await updateSavedReply(api, reply, body, saveKey.current) : await createSavedReply(api, body as Parameters<typeof createSavedReply>[1], saveKey.current)
      saveKey.current = null
      lastWrite.current = Date.now()
      setEditor(null)
      setNotice({ key: reply ? 'tpl.replies.done.changed' : 'tpl.replies.done.created', tone: 'success', params: { name: saved.name } })
      void load()
    } catch (error) {
      saveKey.current = null
      setEditor((now) => (now ? { ...now, problem: refusalOf(error) } : now))
      if (refusalReloads(error)) void load()
    } finally {
      setBusy(false)
    }
  }

  const removeMany = async (rows: readonly SavedReply[]) => {
    setBusy(true)
    setNotice(null)
    lastWrite.current = Date.now()
    const refused: Array<{ id: string; said: ReturnType<typeof refusalOf> }> = []
    let done = 0
    for (const row of rows) {
      try {
        await deleteSavedReply(api, row)
        done += 1
      } catch (error) {
        refused.push({ id: row.id, said: refusalOf(error) })
      }
    }
    lastWrite.current = Date.now()
    setNotice(refused.length === 0 ? { key: 'tpl.replies.done.deleted', tone: 'success', params: { count: done } } : { key: done === 0 ? 'tpl.replies.done.deleteFailed' : 'tpl.replies.done.deletePartial', tone: done === 0 ? 'danger' : 'warning', params: { count: done, refused: refused.length }, refused })
    setConfirm(null)
    setSelected([])
    setBusy(false)
    void load()
  }

  const model: SavedRepliesModel = { prefix, companies, companyId, read, mayWrite, filter, selected, editor, confirm, busy, notice, asOf, updates }

  return (
    <SavedRepliesView
      model={model}
      actions={{
        onView,
        onPart,
        onCompany,
        onFilter: setFilter,
        onSelect: setSelected,
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onShowUpdates: () => void load(),
        onNew: () => {
          saveKey.current = null
          setEditor({ draft: newDraft(filter), problem: null })
        },
        onEdit: (reply) => {
          saveKey.current = null
          setEditor({ draft: draftOf(reply), problem: null })
        },
        onDraft: (patch) => {
          saveKey.current = null
          setEditor((now) => (now ? { draft: { ...now.draft, ...patch }, problem: null } : now))
        },
        onSave: () => void save(),
        onCloseEditor: () => (busy ? undefined : setEditor(null)),
        onDelete: (rows) => setConfirm(rows && rows.length > 0 ? { rows } : null),
        onDeleteGo: () => {
          if (confirm && !busy) void removeMany(confirm.rows)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
