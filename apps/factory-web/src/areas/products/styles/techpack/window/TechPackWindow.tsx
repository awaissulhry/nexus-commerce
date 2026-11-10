'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { getStyle, type StyleView } from '../../api'
import { revisionInView } from '../../model'
import { listTechPackVersions, scanTechPack, techPackPdfBytes, type ScanView, type TechPackVersion } from '../api'
import { allowedSections, failed, madeWords, pickVersion, readProblem, ready, reading, techPackCan, valueOf, windowAddress, windowTargetOf, WINDOW_PATH, type Read, type WindowTarget } from '../model'
import { readTechPackCode } from '@nexus/factory-domain/product/techpack/scan'
import { useMakePdf } from '../use-make'
import type { TechPackNotice } from '../view/TechPackTabView'
import { TechPackWindowView } from './view/TechPackWindowView'

/**
 * `/w/<company>/products/styles/tech-pack?style=&rev=&version=` (SCR-306, a window page; design tab:styles.techpack): reads the
 * style, the revision's stored versions, then the version's PDF (a plain link cannot send the company header, so the page
 * reads the bytes) into the viewer. `?scan=<code>` (a scanned QR, `/tech-pack/<code>` lands here): reads the scan first, then
 * shows that page with its verdict, and offers the newest. Make new version opens here and shows the version made.
 */
export function TechPackWindow() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(new RegExp(`${WINDOW_PATH.replace(/\//g, '\\/')}\\/?$`), '')
  const can = useMemo(() => techPackCan(session.permissions), [session.permissions])
  const allowed = useMemo(() => allowedSections(can), [can])
  const asked = windowTargetOf(params)

  const [scan, setScan] = useState<Read<ScanView> | null>(null)
  const [style, setStyle] = useState<Read<StyleView> | null>(null)
  const [versions, setVersions] = useState<Read<TechPackVersion[]> | null>(null)
  const [pdf, setPdf] = useState<Read<Uint8Array> | null>(null)
  const [notice, setNotice] = useState<TechPackNotice | null>(null)
  const [attempt, setAttempt] = useState(0)
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

  const go = (next: WindowTarget) => router.replace(windowAddress(prefix, { ...asked, ...next }), { scroll: false })

  // A scanned QR: which page it is, and its verdict.
  useEffect(() => {
    if (!asked.scan || !can.view) {
      setScan(null)
      return
    }
    // A code that cannot be one (mistyped) is said at once, without asking the server.
    if (readTechPackCode(asked.scan) === null) {
      setScan(failed('techpack.problem.read.not_found'))
      return
    }
    const controller = new AbortController()
    setScan(reading())
    scanTechPack(api, asked.scan, controller.signal)
      .then((answer) => setScan(ready(answer)))
      .catch((error: unknown) => !controller.signal.aborted && setScan(failed(readProblem(error))))
    return () => controller.abort()
  }, [api, asked.scan, can.view, attempt])

  const scanned = valueOf(scan)
  const styleId = asked.styleId ?? scanned?.printed.styleId ?? null
  useEffect(() => {
    if (!styleId || !can.view) {
      setStyle(null)
      return
    }
    const controller = new AbortController()
    setStyle((current) => (current?.status === 'ready' && current.value.id === styleId ? current : reading()))
    getStyle(api, styleId)
      .then((answer) => !controller.signal.aborted && setStyle(ready(answer)))
      .catch((error: unknown) => !controller.signal.aborted && setStyle(failed(readProblem(error))))
    return () => controller.abort()
  }, [api, styleId, can.view, attempt])

  const styleValue = valueOf(style)
  const revision = styleValue ? revisionInView(styleValue.revisions, asked.revisionId ?? scanned?.printed.revisionId ?? null) : null
  const revisionId = revision?.id ?? null
  const [versionsKey, setVersionsKey] = useState(0)
  useEffect(() => {
    if (!styleId || !revisionId) {
      setVersions(null)
      return
    }
    const controller = new AbortController()
    setVersions(reading())
    listTechPackVersions(api, styleId, revisionId, controller.signal)
      .then((answer) => setVersions(ready(answer)))
      .catch((error: unknown) => !controller.signal.aborted && setVersions(failed(readProblem(error))))
    return () => controller.abort()
  }, [api, styleId, revisionId, versionsKey, attempt])

  const versionList = valueOf(versions)
  // The scanned page's version in its revision; in the revision in force it points at, the newest of the same audience and language.
  const scannedHere = !scanned ? null : scanned.printed.revisionId === revisionId ? scanned.printed.version : scanned.newer?.revisionId === revisionId ? scanned.newer.version : null
  const version = versionList ? pickVersion(versionList, asked.versionId, scannedHere) : null
  const versionId = version?.id ?? null
  useEffect(() => {
    if (!styleId || !revisionId || !versionId) {
      setPdf(null)
      return
    }
    const controller = new AbortController()
    setPdf(reading())
    techPackPdfBytes(api, styleId, revisionId, versionId, controller.signal)
      .then((bytes) => setPdf(ready(bytes)))
      .catch((error: unknown) => !controller.signal.aborted && setPdf(failed(readProblem(error))))
    return () => controller.abort()
  }, [api, styleId, revisionId, versionId, attempt])

  const make = useMakePdf({
    api,
    target: {
      styleId: styleId ?? '',
      styleCode: styleValue?.code ?? '',
      revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
      privateLabel: styleValue?.brand ? { id: styleValue.brand.id, code: styleValue.brand.code, name: styleValue.brand.name } : null,
      companyId: styleValue && styleValue.companyId === null ? (session.company?.id ?? null) : null,
      allowed,
    },
    can,
    online,
    opensHere: true,
    windowFor: (made) => windowAddress(prefix, { ...asked, styleId, revisionId, versionId: made.version.id }),
    onMade: (made) => {
      setNotice({ ...madeWords(made), tone: made.made ? 'success' : 'info' })
      setVersionsKey((n) => n + 1)
      go({ styleId, revisionId, versionId: made.version.id })
    },
  })

  return (
    <TechPackWindowView
      model={{
        can,
        online,
        scanCode: asked.scan,
        scan,
        style,
        revisionId,
        versions,
        versionId,
        pdf,
        make: make.model,
        notice,
      }}
      actions={{
        onRevision: (next) => go({ styleId, revisionId: next, versionId: null }),
        onVersion: (next) => go({ styleId, revisionId, versionId: next }),
        onNewest: () => {
          if (!scanned?.newer) return
          const newer = scanned.newer
          if (newer.revisionId !== revisionId) go({ styleId, revisionId: newer.revisionId, versionId: null })
          else {
            const found = versionList?.find((entry) => entry.version === newer.version)
            if (found) go({ styleId, revisionId, versionId: found.id })
          }
        },
        onScanCode: (code) => router.replace(windowAddress(prefix, { scan: code }), { scroll: false }),
        onRetry: () => setAttempt((n) => n + 1),
        onMake: () => {
          const shown = version
          make.open({ audience: shown?.audience ?? 'INTERNAL', language: shown?.language === 'en' ? 'en' : shown?.language === 'it' ? 'it' : locale })
        },
        make: make.actions,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
