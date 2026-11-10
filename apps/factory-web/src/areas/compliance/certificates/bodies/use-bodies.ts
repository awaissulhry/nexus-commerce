'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { failedRead, problemKey, reading, ready } from '../../../quality/_shared/model'
import { createBody, editBody, listBodies, type NotifiedBody } from '../depth/api'
import { blankBodyDraft, bodyDraftOf, bodyInputOf, closedBodies, type BodiesFilter, type BodiesModel, type BodyDraft, type BodyField } from '../depth/model'

const issueLines = (error: unknown): string[] => (isApiError(error) ? [...error.issues.map((issue) => issue.message ?? '').filter(Boolean), ...(error.issues.length === 0 && error.kind === 'conflict' ? [error.message] : [])] : [])

function writeProblem(error: unknown): string {
  if (!isApiError(error)) return 'write.failed'
  if (error.kind === 'conflict') return 'bodies.write.conflict'
  if (error.kind === 'forbidden') return 'bodies.held.manage'
  if (error.kind === 'invalid') return 'write.invalid'
  return 'write.failed'
}

export interface BodiesActions {
  onOpen?: () => void
  onClose?: () => void
  onRetry?: () => void
  onFilter?: (filter: BodiesFilter) => void
  onQuery?: (q: string) => void
  onSelect?: (ids: readonly string[]) => void
  onNew?: () => void
  onEdit?: (body: NotifiedBody) => void
  onBack?: () => void
  onDraft?: (patch: Partial<BodyDraft>) => void
  onTouch?: (field: BodyField) => void
  onSave?: () => void
  onArchive?: (body: NotifiedBody, status: 'ACTIVE' | 'ARCHIVED') => void
  onExport?: (bodies: readonly NotifiedBody[]) => void
  onDismissNotice?: () => void
}

/**
 * The Notified bodies pop-up's container (B-W2b-255; design compliance.certificates › pop:ce-nb; SCR-291): the register's
 * ⋯ "Notified bodies" and the record's Notified body tab mount it. Reads the whole directory (archived ones too: the
 * filter is local) when it opens, adds and edits a body (PATCH with its version), archives or restores it, and tells the
 * page when the directory changed (a record re-reads its depth). Live: `certificates_depth.notified_body_changed`.
 */
export function useBodies(input: { api: ApiClient; onChanged?: () => void; onExport: (bodies: readonly NotifiedBody[]) => void }) {
  const { api, onChanged } = input
  const [model, setModel] = useState<BodiesModel>(closedBodies())
  const request = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setModel((current) => ({ ...current, directory: current.directory?.value ? current.directory : reading() }))
    try {
      const directory = await listBodies(api, { status: 'ALL' }, controller.signal)
      if (controller.signal.aborted) return
      setModel((current) => ({ ...current, directory: ready(directory), selected: current.selected.filter((id) => directory.bodies.some((body) => body.id === id)) }))
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return
      setModel((current) => ({ ...current, directory: failedRead(problemKey(error)) }))
    }
  }, [api])

  useEffect(() => {
    if (model.open && !model.directory) void load()
  }, [load, model.directory, model.open])

  const save = async () => {
    const form = model.form
    if (!form) return
    setModel((current) => ({ ...current, busy: true, problem: null, lines: [] }))
    try {
      const values = bodyInputOf(form.draft)
      const known = model.directory?.value?.bodies.find((body) => body.id === form.bodyId) ?? null
      const saved = form.mode === 'new' ? await createBody(api, values) : await editBody(api, known!, known!.linked > 0 ? { ...values, number: undefined } : values)
      setModel((current) => ({ ...current, busy: false, form: null, notice: { key: form.mode === 'new' ? 'bodies.done.added' : 'bodies.done.saved', params: { number: saved.number } } }))
      await load()
      onChanged?.()
    } catch (error) {
      setModel((current) => ({ ...current, busy: false, problem: writeProblem(error), lines: issueLines(error) }))
    }
  }

  const archive = async (body: NotifiedBody, status: 'ACTIVE' | 'ARCHIVED') => {
    setModel((current) => ({ ...current, busy: true, problem: null, lines: [] }))
    try {
      await editBody(api, body, { status })
      setModel((current) => ({ ...current, busy: false, notice: { key: status === 'ARCHIVED' ? 'bodies.done.archived' : 'bodies.done.restored', params: { number: body.number } } }))
      await load()
      onChanged?.()
    } catch (error) {
      setModel((current) => ({ ...current, busy: false, problem: writeProblem(error), lines: issueLines(error) }))
    }
  }

  const actions: BodiesActions = {
    onOpen: () => setModel((current) => ({ ...closedBodies(), open: true, directory: current.directory })),
    onClose: () => setModel((current) => ({ ...closedBodies(), directory: current.directory })),
    onRetry: () => void load(),
    onFilter: (filter) => setModel((current) => ({ ...current, filter, selected: [] })),
    onQuery: (q) => setModel((current) => ({ ...current, q })),
    onSelect: (ids) => setModel((current) => ({ ...current, selected: [...ids] })),
    onNew: () => setModel((current) => ({ ...current, form: { mode: 'new', bodyId: null, draft: blankBodyDraft(), touched: [] }, problem: null, lines: [], notice: null })),
    onEdit: (body) => setModel((current) => ({ ...current, form: { mode: 'edit', bodyId: body.id, draft: bodyDraftOf(body), touched: [] }, problem: null, lines: [], notice: null })),
    onBack: () => setModel((current) => ({ ...current, form: null, problem: null, lines: [] })),
    onDraft: (patch) => setModel((current) => (current.form ? { ...current, form: { ...current.form, draft: { ...current.form.draft, ...patch } } } : current)),
    onTouch: (field) => setModel((current) => (current.form && !current.form.touched.includes(field) ? { ...current, form: { ...current.form, touched: [...current.form.touched, field] } } : current)),
    onSave: () => void save(),
    onArchive: (body, status) => void archive(body, status),
    onExport: (rows) => {
      input.onExport(rows)
      setModel((current) => ({ ...current, notice: { key: 'bodies.done.exported', params: { count: rows.length } } }))
    },
    onDismissNotice: () => setModel((current) => ({ ...current, notice: null })),
  }
  return { model, actions, reload: load }
}
