'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLiveChanges } from '../../../../record-panels/live'
import { libraryCan, readProblem, writeProblem, type Notice, type WriteProblem } from '../../library/model'
import { archiveOperation, getOperation, reactivateOperation, updateOperation, useLibraryMinutes, type OperationInput, type OperationView } from '../api'
import { tabOf } from '../model'
import { OperationRecordView, type OperationLoad, type OperationRecordViewModel } from './view/OperationRecordView'

/**
 * `/w/<company>/products/operations/<id>` (SCR-049): reads the operation with where it is used, one write at a time with
 * the version read (COL-078; a 409 reads it again). "Update to the library value" changes each selected draft
 * routing's step through the routing's own route, one by one, each with its revision's version. Live operation.* and
 * style.routing_changed events from someone else show "Changed meanwhile · Reload".
 */
export function OperationRecord({ operationId }: { operationId: string }) {
  return (
    <WithMessages namespaces={['library']}>
      <Container operationId={operationId} />
    </WithMessages>
  )
}

function Container({ operationId }: { operationId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => libraryCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/products\/operations\/[^/]+\/?$/, '')
  const tab = tabOf(params?.get('tab'))
  const [operation, setOperation] = useState<OperationLoad>({ status: 'loading' })
  const [save, setSave] = useState<OperationRecordViewModel['save']>({ state: 'idle', at: null })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [refused, setRefused] = useState<WriteProblem | null>(null)
  const [dialog, setDialog] = useState<OperationRecordViewModel['dialog']>(null)
  const writing = useRef(false)
  const current = operation.status === 'ready' ? operation.value : null

  const load = useCallback(async () => {
    try {
      setOperation({ status: 'ready', value: await getOperation(api, operationId) })
      setChanged(null)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setOperation({ status: 'notFound' })
      else if (isApiError(error) && error.kind === 'forbidden') setOperation({ status: 'forbidden' })
      else setOperation({ status: 'error', problem: readProblem(error) })
    }
  }, [api, operationId])

  useEffect(() => {
    void load()
  }, [load])

  useLiveChanges({
    onChange: (change) => {
      if (writing.current) return
      if (change.type.startsWith('operation.') && change.fields.operationId === operationId) setChanged({ at: new Date().toISOString() })
      else if (change.type === 'style.routing_changed' && current?.whereUsed.some((use) => use.style.id === change.fields.styleId)) setChanged({ at: new Date().toISOString() })
    },
  })

  const write = async (run: (value: OperationView) => Promise<OperationView>, success?: Notice): Promise<boolean> => {
    if (!current || writing.current) return false
    writing.current = true
    setBusy(true)
    setSave({ state: 'saving', at: save.at })
    setRefused(null)
    try {
      setOperation({ status: 'ready', value: await run(current) })
      setSave({ state: 'idle', at: new Date().toISOString() })
      if (success) setNotice(success)
      return true
    } catch (error) {
      const problem = writeProblem(error)
      setRefused(problem)
      setSave({ state: 'failed', at: save.at })
      setNotice({ key: problem.key, tone: 'danger' })
      if (problem.reload) void load()
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const updateRoutings = async (stepIds: string[]): Promise<boolean> => {
    if (!current || writing.current) return false
    writing.current = true
    setBusy(true)
    let done = 0
    try {
      for (const stepId of stepIds) {
        const use = current.whereUsed.find((entry) => entry.stepId === stepId)
        if (!use) continue
        await useLibraryMinutes(api, use, current.standardMinutes)
        done++
      }
      setNotice({ key: 'operation.notice.updated', tone: 'success', params: { count: done } })
      return true
    } catch (error) {
      setNotice({ key: writeProblem(error).key, tone: 'danger', params: { count: done } })
      return false
    } finally {
      writing.current = false
      setBusy(false)
      void load()
    }
  }

  const model: OperationRecordViewModel = { prefix, can, tab, operation, save, busy, notice, changed, refused, dialog }
  return (
    <OperationRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onReload: () => void load(),
        onSave: (patch: Partial<OperationInput> & { code?: string }) => write((value) => updateOperation(api, value, patch)),
        onArchive: (reason) => write((value) => archiveOperation(api, value, reason || undefined), { key: 'operation.notice.archived', tone: 'success' }),
        onReactivate: () => void write((value) => reactivateOperation(api, value), { key: 'operation.notice.reactivated', tone: 'success' }),
        onUpdateRoutings: updateRoutings,
        onDialog: setDialog,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
