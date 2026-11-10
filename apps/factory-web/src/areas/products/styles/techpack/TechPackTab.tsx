'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import type { StyleView } from '../api'
import { abilitiesOf, revisionInView, tabsFor } from '../model'
import { getTechPack, listTechPackVersions, type TechPackVersion, type TechPackView } from './api'
import { allowedSections, failed, madeWords, readProblem, ready, reading, techPackCan, valueOf, windowAddress, withSection, type Read, type TechPackAudience, type TechPackLanguage, type TechPackSection } from './model'
import { useMakePdf } from './use-make'
import { TechPackTabView, type TechPackNotice } from './view/TechPackTabView'

/**
 * The Style › Tech pack tab's container (B-W2b-243; SCR-305), mounted by the style studio while the tab is open: reads the live
 * tech pack of the revision in view for the audience and language chosen (every section the person may see; the Contents
 * choose what shows), and the stored versions; again when the studio reads the style again (a change, live or its own).
 * Make tech pack PDF opens here, or from the band's ⋯ (`?make=1`); the version made opens in the PDF window, a new tab.
 */
export function TechPackTab({ style, revisionId, prefix }: { style: StyleView; revisionId: string | null; prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => techPackCan(session.permissions), [session.permissions])
  const tabs = useMemo(() => tabsFor(abilitiesOf(session.permissions)), [session.permissions])
  const allowed = useMemo(() => allowedSections(can), [can])
  const revision = revisionInView(style.revisions, revisionId)
  // A tenant-wide style's copy is the page's company's (its instructions, the brand's packing rules, its tests).
  const companyId = style.companyId === null ? (session.company?.id ?? null) : null

  const [audience, setAudience] = useState<TechPackAudience>('INTERNAL')
  const [language, setLanguage] = useState<TechPackLanguage>(locale)
  const [sections, setSections] = useState<TechPackSection[]>(allowed)
  const [view, setView] = useState<Read<TechPackView> | null>(null)
  const [versions, setVersions] = useState<Read<TechPackVersion[]> | null>(null)
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

  // The live view: the revision in view, the audience, the language; again when the studio reads the style again.
  const revisionKey = revision?.id ?? null
  useEffect(() => {
    if (!revisionKey || !can.view) {
      setView(null)
      return
    }
    const controller = new AbortController()
    setView((current) => (current?.status === 'ready' && current.value.revision.id === revisionKey && current.value.audience === audience && current.value.language === language ? current : reading()))
    getTechPack(api, style.id, revisionKey, { audience, language, companyId }, controller.signal)
      .then((answer) => setView(ready(answer)))
      .catch((error: unknown) => !controller.signal.aborted && setView(failed(readProblem(error))))
    return () => controller.abort()
  }, [api, style, revisionKey, audience, language, companyId, can.view, attempt])

  const [versionsKey, setVersionsKey] = useState(0)
  useEffect(() => {
    if (!revisionKey || !can.view) {
      setVersions(null)
      return
    }
    const controller = new AbortController()
    setVersions((current) => current ?? reading())
    listTechPackVersions(api, style.id, revisionKey, controller.signal)
      .then((answer) => setVersions(ready(answer)))
      .catch((error: unknown) => !controller.signal.aborted && setVersions(failed(readProblem(error))))
    return () => controller.abort()
  }, [api, style, revisionKey, can.view, versionsKey, attempt])

  const make = useMakePdf({
    api,
    target: {
      styleId: style.id,
      styleCode: style.code,
      revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
      privateLabel: style.brand ? { id: style.brand.id, code: style.brand.code, name: style.brand.name } : null,
      companyId,
      allowed,
    },
    can,
    online,
    opensHere: false,
    windowFor: (pdf) => windowAddress(prefix, { styleId: style.id, revisionId: revision?.id ?? null, versionId: pdf.version.id }),
    onMade: (pdf) => {
      const words = madeWords(pdf)
      setNotice({ ...words, tone: pdf.made ? 'success' : 'info', versionId: pdf.version.id })
      setVersionsKey((n) => n + 1)
    },
  })

  // The band's ⋯ "Make tech pack PDF…" opens the tab with `make=1`: the dialog opens once, and the term leaves the address.
  const opened = useRef(false)
  const askedMake = params?.get('make') === '1'
  useEffect(() => {
    if (!askedMake || opened.current || !revision) return
    opened.current = true
    make.open({ audience, language, sections })
    const search = new URLSearchParams(params?.toString() ?? '')
    search.delete('make')
    router.replace(`${pathname}?${search.toString()}`, { scroll: false })
  }, [askedMake, revision, make, audience, language, sections, params, pathname, router])

  const value = valueOf(view)
  const mine = value ? value.sections.filter((entry) => entry.allowed).map((entry) => entry.section) : allowed

  return (
    <TechPackTabView
      model={{
        prefix,
        styleId: style.id,
        styleCode: style.code,
        revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status } : null,
        can,
        tabs,
        audience,
        language,
        sections: sections.filter((section) => mine.includes(section)),
        view,
        versions,
        online,
        make: make.model,
        notice,
      }}
      actions={{
        onAudience: setAudience,
        onLanguage: setLanguage,
        onSection: (section, on) => setSections((current) => withSection(current, section, on)),
        onAllSections: (on) => setSections(on ? mine : []),
        onRetry: () => setAttempt((n) => n + 1),
        onMake: () => make.open({ audience, language, sections: sections.filter((section) => mine.includes(section)) }),
        make: make.actions,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
