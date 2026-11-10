'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { makePack, packPdf, packZip, readPack, type PackView } from '../api'
import { declarationsCan, problemOf, readProblemOf, type Problem } from '../model'
import { failedRead, loadingRead, readyRead, type PageNotice, type Read } from '../view-model'
import { PackWindowView } from './view/WindowsView'

/**
 * `/w/<company>/compliance/declarations/pack?shipment=<id>&version=<document>` (SCR-052-pack, a window page; design tab:dc-pack;
 * PRD-300): what one shipment's compliance pack holds now (each style's signed DoC and user information in the buyer's
 * language, the certificate in summary, the batches with their public DoC addresses, every file with its SHA-256), why it cannot be
 * made, its versions, a version's PDF in the viewer and its ZIP saved by the browser. Make a version (compliance.declarations.pack);
 * "Make and share" also gives its PDF to the shipment's customer (the portal and the shipment's document link list it). The
 * shipment's own send stays shipping's.
 */
export function PackWindow() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/compliance\/declarations\/pack\/?$/, '')
  const can = useMemo(() => declarationsCan(session.permissions), [session.permissions])
  const shipmentId = params?.get('shipment') ?? null
  const asked = params?.get('version') ?? null
  const [pack, setPack] = useState<Read<PackView> | null>(null)
  const [pdf, setPdf] = useState<Read<Uint8Array> | null>(null)
  const [busy, setBusy] = useState<'make' | 'share' | 'zip' | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [turn, setTurn] = useState(0)
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const load = useCallback(async () => {
    if (!shipmentId) return null
    try {
      const value = await readPack(api, shipmentId)
      setPack(readyRead(value))
      return value
    } catch (error) {
      setPack(failedRead(readProblemOf(error)))
      return null
    }
  }, [api, shipmentId])

  useEffect(() => {
    setPack(shipmentId ? loadingRead : null)
    void load()
  }, [load, turn])

  const value = pack?.status === 'ready' ? pack.value : null
  const versionId = value ? (value.versions.find((version) => version.id === asked)?.id ?? [...value.versions].sort((a, b) => b.version - a.version)[0]?.id ?? null) : null
  useEffect(() => {
    if (!shipmentId || !versionId) {
      setPdf(null)
      return
    }
    const controller = new AbortController()
    setPdf(loadingRead)
    packPdf(api, shipmentId, versionId, controller.signal).then(
      (bytes) => !controller.signal.aborted && setPdf(readyRead(bytes)),
      (error: unknown) => !controller.signal.aborted && setPdf(failedRead(readProblemOf(error))),
    )
    return () => controller.abort()
  }, [api, shipmentId, versionId, turn])

  const choose = (id: string) => router.replace(`${pathname}?shipment=${encodeURIComponent(shipmentId ?? '')}&version=${encodeURIComponent(id)}`, { scroll: false })

  const make = async (share: boolean) => {
    if (!shipmentId || busy) return
    setBusy(share ? 'share' : 'make')
    setProblem(null)
    try {
      const made = await makePack(api, shipmentId, share, newIdempotencyKey())
      setNotice({ tone: 'success', key: made.made ? (share ? 'pack.madeShared' : 'pack.made') : share ? 'pack.sameShared' : 'pack.same', params: { version: made.version.version } })
      await load()
      choose(made.version.id)
    } catch (error) {
      setProblem(problemOf(error))
    } finally {
      setBusy(null)
    }
  }

  const zip = async () => {
    if (!shipmentId || !versionId || busy) return
    setBusy('zip')
    setProblem(null)
    try {
      const bytes = await packZip(api, shipmentId, versionId)
      const version = value?.versions.find((entry) => entry.id === versionId)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${value?.shipment.number ?? 'pack'}-v${version?.version ?? ''}.zip`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (error) {
      setProblem(problemOf(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <PackWindowView
      model={{ prefix, can, shipmentId, pack, versionId, pdf, busy, notice, problem, online }}
      actions={{
        onVersion: choose,
        onMake: (share) => void make(share),
        onZip: () => void zip(),
        onRetry: () => setTurn((n) => n + 1),
        onDismiss: () => setNotice(null),
      }}
    />
  )
}
