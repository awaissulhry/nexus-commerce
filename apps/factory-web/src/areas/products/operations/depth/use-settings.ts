'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { readProblem, writeProblem, type Notice, type WriteProblem } from '../../library/model'
import { getLibrarySettings, listMachineClasses, setLibrarySettings, type LibrarySettings, type MachineClassChoice } from './api'
import { useOffline } from './online'
import { settingBodiesOf, type Part, type SettingsActions, type SettingsModel } from './model'

/**
 * The Machine & settings tab's container hook (B-W2b-235 on B-W2b-225's API; design products.operations › Operation ›
 * Machine & settings, PRD-118): reads the library operation's settings while the tab is open, the machine classes once
 * (plant.view; without it the class is shown, not picked), and saves the whole list at the OPERATION's version (a 409
 * reads it again and says why). Live `operation.updated` of this operation with its machine settings reads it again.
 */
export function useOperationSettings({ api, operationId, enabled, classesReadable, onChanged }: { api: ApiClient; operationId: string; enabled: boolean; classesReadable: boolean; onChanged?: () => void }): {
  model: SettingsModel
  actions: SettingsActions
} {
  const [part, setPart] = useState<Part<LibrarySettings>>({ status: 'idle' })
  const [classes, setClasses] = useState<MachineClassChoice[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<WriteProblem | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const writing = useRef(false)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const offline = useOffline()

  const load = useCallback(() => {
    setPart((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    getLibrarySettings(api, operationId)
      .then((value) => setPart({ status: 'ready', value }))
      .catch((error: unknown) => setPart({ status: 'error', problem: readProblem(error) }))
  }, [api, operationId])

  useEffect(() => {
    if (!enabled) return
    load()
  }, [load, enabled])

  useEffect(() => {
    if (!enabled || classes !== null) return
    if (!classesReadable) {
      setClasses([])
      return
    }
    listMachineClasses(api)
      .then(setClasses)
      .catch(() => setClasses([]))
  }, [api, enabled, classesReadable, classes])

  useLiveChanges({
    onChange: (change) => {
      if (!enabled || writing.current) return
      const fields = change.fields.fields
      if (change.type === 'operation.updated' && change.fields.operationId === operationId && (!Array.isArray(fields) || fields.includes('machineSettings'))) load()
    },
  })

  const actions: SettingsActions = {
    onRetry: load,
    onSave: async (drafts) => {
      if (part.status !== 'ready' || writing.current) return false
      writing.current = true
      setBusy(true)
      setRefused(null)
      try {
        setPart({ status: 'ready', value: await setLibrarySettings(api, part.value.operation, settingBodiesOf(drafts)) })
        setNotice({ key: 'settings.notice.saved', tone: 'success', params: { count: drafts.length } })
        changed.current?.()
        return true
      } catch (error) {
        const problem = writeProblem(error)
        setRefused(problem)
        setNotice({ key: problem.key, tone: 'danger' })
        if (problem.reload) load()
        return false
      } finally {
        writing.current = false
        setBusy(false)
      }
    },
    onDismissNotice: () => setNotice(null),
  }

  const model = useMemo<SettingsModel>(() => ({ part, classes, busy, refused, notice, offline }), [part, classes, busy, refused, notice, offline])
  return { model, actions }
}
