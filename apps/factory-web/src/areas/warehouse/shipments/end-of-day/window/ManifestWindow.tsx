'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { presignedBytes } from '../../files'
import { dispatchAbilitiesOf } from '../../pickup/dispatch'
import { manifestPdfLink, readManifest } from '../api'
import { ManifestWindowView, type ManifestWindowModel } from '../view/ManifestWindowView'

/**
 * `/w/<company>/warehouse/shipments/manifest?manifest=<id>` (SCR-652, a window page: WINDOW_PAGES; design tab sh-tab-manifest):
 * the closed sheet (`GET /shipping/manifests/:id`) and its PDF (`…/pdf`, a presigned GET, files.read) read into the viewer: a
 * plain link cannot send the company header, so the page reads the bytes itself.
 */
export function ManifestWindow() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/shipments\/manifest\/?$/, '')
  const manifestId = params?.get('manifest') ?? null
  const readFiles = useMemo(() => dispatchAbilitiesOf(session.permissions).readFiles, [session.permissions])
  const [model, setModel] = useState<ManifestWindowModel>({ prefix, read: { status: 'loading' }, pdf: null, readFiles })
  const [turn, setTurn] = useState(0)

  useEffect(() => {
    if (!manifestId) {
      setModel((state) => ({ ...state, read: { status: 'error', problem: 'notFound' } }))
      return
    }
    const controller = new AbortController()
    setModel({ prefix, read: { status: 'loading' }, pdf: null, readFiles })
    readManifest(api, manifestId, controller.signal)
      .then((sheet) => {
        if (controller.signal.aborted) return
        const reads = sheet.state === 'CLOSED' && readFiles
        setModel((state) => ({ ...state, read: { status: 'ready', value: sheet }, pdf: reads ? { status: 'loading' } : null }))
        if (!reads) return
        manifestPdfLink(api, manifestId, controller.signal)
          .then(async (link) => ({ bytes: await presignedBytes(link), name: link.name }))
          .then(
            ({ bytes, name }) => !controller.signal.aborted && setModel((state) => ({ ...state, pdf: { status: 'ready', value: bytes, name } })),
            () => !controller.signal.aborted && setModel((state) => ({ ...state, pdf: { status: 'error' } })),
          )
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const problem = isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : isApiError(error) && error.kind === 'not_found' ? 'notFound' : 'failed'
        setModel((state) => ({ ...state, read: { status: 'error', problem } }))
      })
    return () => controller.abort()
  }, [api, manifestId, prefix, readFiles, turn])

  return <ManifestWindowView model={model} onRetry={() => setTurn((n) => n + 1)} />
}
