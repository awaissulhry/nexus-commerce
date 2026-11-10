'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { useLiveChanges } from '../../../../../record-panels/live'
import type { StyleNotice } from '../record-model'
import { addPatternFile, patternDownloadAddress, readPatternFiles, removePatternFiles, sendPatternFile, setPatternFileVersion, updatePatternFile, type PatternFilesView } from './api'
import { patternsProblem, patternsReadProblem, rowOf, type PatternsActions, type PatternsDialog, type PatternsModel, type PatternsNotice, type PatternsPart } from './patterns-model'

/**
 * Files & patterns › Pattern files' container hook (B-W2b-236; SCR-304-patterns): reads the pattern files of the revision in
 * view while the tab shows (again when the revision changes, and on `style.pattern_files_changed` of this style), sends a file
 * in parts from this device, and does what the section asks through the studio's ONE write queue (`write`).
 */
export function usePatternFiles({
  api,
  style,
  revisionId,
  loadKey,
  enabled,
  canManage,
  canEdit,
  write,
}: {
  api: ApiClient
  style: { id: string; companyId: string | null } | null
  revisionId: string | null
  loadKey: string | null
  enabled: boolean
  canManage: boolean
  canEdit: boolean
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
}): { model: PatternsModel; actions: PatternsActions; reload: () => void } {
  const [part, setPart] = useState<PatternsPart>({ status: 'idle' })
  const valueRef = useRef<PatternFilesView | null>(null)
  const [dialog, setDialog] = useState<PatternsDialog | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState<PatternsNotice | null>(null)
  const [sending, setSending] = useState<PatternsModel['sending']>({ state: 'idle', problem: null })
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const styleId = style?.id ?? null

  const setValue = useCallback((next: PatternFilesView) => {
    valueRef.current = next
    setPart({ status: 'ready', value: next })
    setSelected((current) => current.filter((id) => next.files.some((row) => row.id === id)))
  }, [])

  const load = useCallback(() => {
    if (!styleId || !revisionId) return
    setPart((current) => (current.status === 'ready' && current.value.revision.id === revisionId ? current : { status: 'loading' }))
    readPatternFiles(api, styleId, revisionId)
      .then(setValue)
      .catch((error: unknown) => setPart({ status: 'error', problem: patternsReadProblem(error) }))
  }, [api, styleId, revisionId, setValue])

  useEffect(() => {
    if (!enabled || !styleId || !revisionId) {
      valueRef.current = null
      setPart({ status: 'idle' })
      return
    }
    load()
  }, [loadKey, enabled, styleId, revisionId])

  const reload = useCallback(() => {
    if (enabled && valueRef.current) load()
  }, [enabled, load])

  useLiveChanges(
    {
      onChange: (change) => {
        if (change.type === 'style.pattern_files_changed' && change.fields['styleId'] === styleId && !busy) reload()
      },
    },
    enabled && !!styleId,
  )

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

  const run = async (work: () => Promise<PatternFilesView | null>, done?: PatternsNotice): Promise<boolean> => {
    let failure: unknown = null
    setBusy(true)
    const ok = await write(async () => {
      try {
        const next = await work()
        if (next) setValue(next)
      } catch (error) {
        failure = error
        throw error
      }
    })
    setBusy(false)
    setNotice(ok ? (done ?? null) : { key: patternsProblem(failure), tone: 'danger' })
    if (!ok && patternsProblem(failure) !== 'patterns.problem.invalid' && patternsProblem(failure) !== 'patterns.add.wrongType') load()
    return ok
  }

  const actions: PatternsActions = {
    onRetry: load,
    onDialog: (next) => {
      setNotice(null)
      setSending({ state: 'idle', problem: null })
      setDialog(next)
    },
    onSelect: setSelected,
    onDismissNotice: () => setNotice(null),
    onAdd: (file, fields) => {
      if (!style || !revisionId) return
      setSending({ state: 'sending', problem: null })
      let held = false
      void run(async () => {
        const sent = await sendPatternFile(api, { companyId: style.companyId, revisionId }, file)
        if (!sent.available) {
          held = true
          return null
        }
        return addPatternFile(api, style.id, revisionId, { fileId: sent.fileId, ...fields })
      }, { key: 'patterns.notice.added', tone: 'success', params: { name: file.name } }).then((ok) => {
        setSending(ok ? { state: 'idle', problem: null } : { state: 'failed', problem: 'patterns.add.failed' })
        if (ok) setDialog(null)
        if (ok && held) setNotice({ key: 'patterns.notice.held', tone: 'info', params: { name: file.name } })
      })
    },
    onSave: (id, fields) => {
      const row = valueRef.current ? rowOf(valueRef.current, id) : null
      if (!styleId || !revisionId || !row) return
      void run(() => updatePatternFile(api, styleId, revisionId, id, { version: row.version, ...fields })).then((ok) => {
        if (ok) setDialog(null)
      })
    },
    onNewVersion: (id, file) => {
      const row = valueRef.current ? rowOf(valueRef.current, id) : null
      if (!style || !revisionId || !row) return
      setSending({ state: 'sending', problem: null })
      void run(async () => {
        const sent = await sendPatternFile(api, { companyId: style.companyId, revisionId, of: row.file.id }, file)
        if (!sent.available) return null
        return setPatternFileVersion(api, style.id, revisionId, row, sent.fileId)
      }, { key: 'patterns.notice.version', tone: 'success', params: { name: file.name } }).then((ok) => {
        setSending(ok ? { state: 'idle', problem: null } : { state: 'failed', problem: 'patterns.add.failed' })
        if (ok) setDialog(null)
      })
    },
    onRemove: (ids) => {
      const view = valueRef.current
      if (!styleId || !revisionId || !view) return
      const rows = ids.flatMap((id) => {
        const row = rowOf(view, id)
        return row ? [row] : []
      })
      if (rows.length === 0) return
      void run(() => removePatternFiles(api, styleId, revisionId, rows), { key: 'patterns.notice.removed', tone: 'success', params: { count: rows.length } }).then((ok) => {
        if (ok) {
          setDialog(null)
          setSelected([])
        }
      })
    },
    onDownload: (id, fileId) => {
      if (!styleId || !revisionId) return
      patternDownloadAddress(api, styleId, revisionId, id, fileId)
        .then((address) => window.location.assign(address))
        .catch((error: unknown) => setNotice({ key: patternsProblem(error), tone: 'danger' }))
    },
  }

  return { model: { part, canManage, canEdit, dialog, selected, busy, sending, notice, offline }, actions, reload }
}
