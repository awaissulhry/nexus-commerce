'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLiveChanges } from '../../../../record-panels/live'
import { failed, libraryCan, readProblem, ready, reading, writeProblem, type Notice, type WriteProblem } from '../../library/model'
import { addSizes, archiveScale, getScale, reactivateScale, reorderSizes, stylesOn, updateScale, updateSize, type ScaleView } from '../api'
import { tabOf } from '../model'
import { ScaleRecordView, type ScaleLoad, type ScaleRecordViewModel } from './view/ScaleRecordView'

/**
 * `/w/<company>/products/sizes/<id>` (SCR-049): reads the scale with every size, and the styles on it (Where used). One
 * write at a time with the version read (the scale's, or the size's for a size change; COL-078): a 409 reads it again.
 * Live size_scale.* events of this scale from someone else show "Changed meanwhile · Reload".
 */
export function ScaleRecord({ scaleId }: { scaleId: string }) {
  return (
    <WithMessages namespaces={['library']}>
      <Container scaleId={scaleId} />
    </WithMessages>
  )
}

function Container({ scaleId }: { scaleId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => libraryCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/products\/sizes\/[^/]+\/?$/, '')
  const tab = tabOf(params?.get('tab'))
  const [scale, setScale] = useState<ScaleLoad>({ status: 'loading' })
  const [styles, setStyles] = useState<ScaleRecordViewModel['styles']>(reading())
  const [save, setSave] = useState<ScaleRecordViewModel['save']>({ state: 'idle', at: null })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [refused, setRefused] = useState<WriteProblem | null>(null)
  const [dialog, setDialog] = useState<ScaleRecordViewModel['dialog']>(null)
  const writing = useRef(false)
  const current = scale.status === 'ready' ? scale.value : null

  const load = useCallback(async () => {
    try {
      setScale({ status: 'ready', value: await getScale(api, scaleId) })
      setChanged(null)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setScale({ status: 'notFound' })
      else if (isApiError(error) && error.kind === 'forbidden') setScale({ status: 'forbidden' })
      else setScale({ status: 'error', problem: readProblem(error) })
    }
  }, [api, scaleId])

  const loadStyles = useCallback(() => {
    setStyles(reading())
    stylesOn(api, scaleId)
      .then((answer) => setStyles(ready(answer)))
      .catch((error: unknown) => setStyles(failed(readProblem(error))))
  }, [api, scaleId])

  useEffect(() => {
    void load()
    loadStyles()
  }, [load, loadStyles])

  useLiveChanges({
    onChange: (change) => {
      if (writing.current) return
      if (change.type.startsWith('size_scale.') && change.fields.sizeScaleId === scaleId) setChanged({ at: new Date().toISOString() })
    },
  })

  const write = async (run: (value: ScaleView) => Promise<ScaleView>, success?: Notice): Promise<boolean> => {
    if (!current || writing.current) return false
    writing.current = true
    setBusy(true)
    setSave({ state: 'saving', at: save.at })
    setRefused(null)
    try {
      setScale({ status: 'ready', value: await run(current) })
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

  const model: ScaleRecordViewModel = { prefix, can, tab, scale, styles, save, busy, notice, changed, refused, dialog }
  return (
    <ScaleRecordView
      model={model}
      actions={{
        onRetry: () => {
          void load()
          loadStyles()
        },
        onReload: () => void load(),
        onRename: (patch) => write((value) => updateScale(api, value, patch)),
        onAddSizes: (sizes, before) => write((value) => addSizes(api, value, sizes.map((code) => ({ code })), before), { key: 'scale.notice.added', tone: 'success', params: { count: sizes.length } }),
        onReorder: (codes) => write((value) => reorderSizes(api, value, codes)),
        onSize: (size, patch) => write(() => updateSize(api, scaleId, size, patch)),
        onArchive: (reason) => write((value) => archiveScale(api, value, reason || undefined), { key: 'scale.notice.archived', tone: 'success' }),
        onReactivate: () => void write((value) => reactivateScale(api, value), { key: 'scale.notice.reactivated', tone: 'success' }),
        onDialog: setDialog,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
