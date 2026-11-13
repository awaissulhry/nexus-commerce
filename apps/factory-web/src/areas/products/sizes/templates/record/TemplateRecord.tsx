'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useLiveChanges } from '../../../../../record-panels/live'
import { getTemplate, moveTemplate, readRules, renameTemplate, savePoints, switchRules, type TemplateView } from '../api'
import { draftsOf, pointsBody, readProblem, refusedPoints, saveHeld, switchedNotice, tabOf, templateCan, writeProblem, type Notice, type WriteProblem } from '../model'
import { TemplatesMessages } from '../parts'
import { TemplateRecordView, type RecordDialog, type TemplateLoad, type TemplateRecordModel } from './view/TemplateRecordView'
// B-W2b-371: the rule editor (XF2:05) and where the template is used (XF2:04).
import { useRulesEditor } from '../rules/use-rules'
import { readWhereUsed } from '../where-used/api'

/**
 * `/w/<company>/products/sizes/templates/<id>` (SCR-049-template; `?tab=points|mtm|whereused`): reads the template page (B-W2b-358)
 * and, on its Made-to-measure tab, the rules (B-W2b-248). One write at a time with the version read and one Idempotency-Key per
 * attempt: the points saved whole, the switch, archive / restore, the name; a moved version reads it again and says so (never
 * overwritten). Live measurement_template.changed of this template from someone else shows "Changed meanwhile · Reload".
 */
export function TemplateRecord({ templateId }: { templateId: string }) {
  return (
    <TemplatesMessages>
      <Container templateId={templateId} />
    </TemplatesMessages>
  )
}

function Container({ templateId }: { templateId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => templateCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/products\/sizes\/templates\/[^/]+\/?$/, '')
  const tab = tabOf(params?.get('tab'))
  const [template, setTemplate] = useState<TemplateLoad>({ status: 'loading' })
  const [rules, setRules] = useState<TemplateRecordModel['rules']>({ value: null, problem: null })
  const [edit, setEdit] = useState<TemplateRecordModel['edit']>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)
  const keys = useRef<Record<string, string>>({})
  const keyOf = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const current = template.status === 'ready' ? template.value : null

  const load = useCallback(async () => {
    try {
      setTemplate({ status: 'ready', value: await getTemplate(api, templateId) })
      setChanged(null)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setTemplate({ status: 'notFound' })
      else if (isApiError(error) && error.kind === 'forbidden') setTemplate({ status: 'forbidden' })
      else setTemplate({ status: 'error', problem: readProblem(error) })
    }
  }, [api, templateId])

  const loadRules = useCallback(() => {
    setRules({ value: null, problem: null })
    readRules(api, templateId)
      .then((value) => setRules({ value, problem: null }))
      .catch((error: unknown) => setRules({ value: null, problem: readProblem(error) }))
  }, [api, templateId])

  useEffect(() => {
    if (can.view) void load()
  }, [load, can.view])
  useEffect(() => {
    if (tab === 'mtm' && can.view) loadRules()
  }, [tab, loadRules, can.view])

  // B-W2b-371 (XF2:05): the rule editor saves the whole list once; the answer is the rules as kept.
  const rulesEdit = useRulesEditor({
    api,
    templateId,
    rules: rules.value,
    onSaved: (value) => {
      setRules({ value, problem: null })
      void load()
    },
    onStale: () => {
      loadRules()
      void load()
    },
  })
  // B-W2b-371 (XF2:04): the styles and open orders the template serves, while Where used is open.
  const [whereUsed, setWhereUsed] = useState<TemplateRecordModel['whereUsed']>(null)
  const loadWhereUsed = useCallback(() => {
    setWhereUsed({ value: null, problem: null })
    readWhereUsed(api, templateId)
      .then((value) => setWhereUsed({ value, problem: null }))
      .catch((error: unknown) => setWhereUsed({ value: null, problem: readProblem(error) }))
  }, [api, templateId])
  useEffect(() => {
    if (tab === 'whereused' && can.view) loadWhereUsed()
  }, [tab, loadWhereUsed, can.view])

  useLiveChanges({
    onChange: (change) => {
      if (writing.current) return
      if (change.type.startsWith('measurement_template.') && change.fields.templateId === templateId) setChanged({ at: new Date().toISOString() })
    },
  })

  /** One write at a time; the answer is the template as it is now; a refusal is said, a moved version reads again. */
  const write = async (name: string, run: (value: TemplateView) => Promise<TemplateView>, after?: (value: TemplateView) => void): Promise<WriteProblem | null> => {
    if (!current || writing.current) return { key: 'held.busy', reload: false, paths: [] }
    writing.current = true
    setBusy(true)
    try {
      const value = await run(current)
      delete keys.current[name]
      setTemplate({ status: 'ready', value })
      setChanged(null)
      after?.(value)
      return null
    } catch (error) {
      const problem = writeProblem(error)
      if (problem.reload) {
        delete keys.current[name]
        void load()
      }
      return problem
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const save = async () => {
    if (!current || !edit || saveHeld(current, edit.drafts, edit.busy)) return
    setEdit({ ...edit, busy: true, refused: {} })
    const drafts = edit.drafts
    const failed = await write('points', (value) => savePoints(api, value, pointsBody(drafts), keyOf('points')))
    if (failed === null) {
      setEdit(null)
      setNotice({ key: 'points.done', tone: 'success' })
      return
    }
    setNotice({ key: failed.key, tone: 'danger' })
    // A refused save names its points (`points/<i>/<field>`, in the order sent): said at each point.
    setEdit((now) => (now ? { ...now, busy: false, refused: refusedPoints(failed.paths, drafts) } : now))
  }

  const doSwitch = async () => {
    if (!current || dialog?.kind !== 'switch' || writing.current) return
    const asked = dialog
    writing.current = true
    setBusy(true)
    try {
      const value = await switchRules(api, current.id, { version: rules.value?.template.version ?? current.version, on: asked.on, reason: asked.reason.trim() || null }, keyOf('switch'))
      delete keys.current.switch
      setRules({ value, problem: null })
      setDialog(null)
      setNotice(switchedNotice(asked.on, current.code))
      writing.current = false
      void load()
    } catch (error) {
      const problem = writeProblem(error)
      if (problem.reload) {
        delete keys.current.switch
        loadRules()
        void load()
      }
      setDialog({ ...asked, problem: problem.key })
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const doMove = async (to: 'archive' | 'restore') => {
    const failed = await write(to, (value) => moveTemplate(api, value, to, keyOf(to)))
    if (failed === null) {
      setDialog(null)
      setNotice({ key: to === 'archive' ? 'move.archived' : 'move.restored', tone: 'success' })
    } else setDialog((now) => (now && now.kind === to ? { ...now, problem: failed.key } : now))
  }

  const doRename = async () => {
    if (dialog?.kind !== 'rename') return
    const name = dialog.name.trim()
    const failed = await write('rename', (value) => renameTemplate(api, value, { name }, keyOf('rename')))
    if (failed === null) {
      setDialog(null)
      setNotice({ key: 'rename.done', tone: 'success' })
    } else setDialog((now) => (now && now.kind === 'rename' ? { ...now, problem: failed.key } : now))
  }

  const model: TemplateRecordModel = { prefix, can, tab, template, rules, edit, dialog, notice, changed, busy, rulesEdit: rulesEdit.model, whereUsed }
  return (
    <TemplateRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onReload: () => void load(),
        onRetryRules: loadRules,
        onEdit: (open) => {
          delete keys.current.points
          setEdit(open && current ? { drafts: draftsOf(current), busy: false, refused: {} } : null)
        },
        onDrafts: (drafts) => setEdit((now) => (now ? { ...now, drafts: [...drafts], refused: {} } : now)),
        onSave: () => void save(),
        onDialog: setDialog,
        onSwitch: () => void doSwitch(),
        onMove: (to) => void doMove(to),
        onRename: () => void doRename(),
        onDismissNotice: () => setNotice(null),
        rulesEdit: rulesEdit.actions,
        onRetryWhereUsed: loadWhereUsed,
      }}
    />
  )
}
