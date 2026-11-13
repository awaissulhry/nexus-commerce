'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { businessDate } from '@nexus/factory-domain/core/time'
import { isApiError } from '../../../../lib/api/errors'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi } from '../../../../lib/session/context'
import { readProblemOf } from '../model'
import { getVersionBoard } from './api'
import { DEPTH_NAMESPACE, EXPORT_COLUMNS, exportQuery } from './model'
import { useBoardExport } from './use-export'
import { VersionTabView, type VersionTabModel } from './view/VersionTabView'

/**
 * `/w/<company>/planning/board?version=<id>` — a published version, read-only (design tab:version, SCR-408; B-W2b-337 on
 * B-W2b-329's GET /planning/schedule/versions/:id/board): what the floor was given beside the working plan, and Export this
 * version (XLSX). Opened in a new tab from the board; planning.view.
 */
export function VersionTab({ versionId }: { versionId: string }) {
  const api = useOfficeApi()
  const t = useT(DEPTH_NAMESPACE)
  const pathname = usePathname() ?? ''
  const prefix = pathname.replace(/\/planning\/board\/?$/, '')
  const [read, setRead] = useState<VersionTabModel['read']>({ status: 'loading' })
  const [online, setOnline] = useState(true)
  const exporter = useBoardExport(
    t('export.versionTitle'),
    useCallback((column: (typeof EXPORT_COLUMNS)[number]) => t(`export.column.${column}`), [t]),
  )

  const load = useCallback(async () => {
    setRead({ status: 'loading' })
    try {
      setRead({ status: 'ready', value: await getVersionBoard(api, versionId) })
    } catch (error) {
      setRead(isApiError(error) && (error.kind === 'not_found' || error.kind === 'invalid') ? { status: 'notFound' } : { status: 'error', problem: readProblemOf(error) })
    }
  }, [api, versionId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const board = read.status === 'ready' ? read.value : null
  const model: VersionTabModel = {
    prefix,
    read,
    today: board ? businessDate(new Date(), board.site.timeZone) : null,
    offline: !online,
    mayExport: exporter.available,
    exportJob: exporter.state,
  }
  return (
    <VersionTabView
      model={model}
      actions={{
        onRetry: () => void load(),
        onExport: () => void exporter.start(exportQuery({ versionId })),
        onExportDownload: exporter.download,
        onExportAgain: exporter.again,
        onCloseExport: exporter.close,
      }}
    />
  )
}
