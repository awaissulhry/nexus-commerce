'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLiveBus } from '../../../shell/live/use-live'
import { getLibrary, installStandard, type KpiLibrary } from './api'
import { download } from './files'
import { csvName, definitionsCsv, KPI_LIVE_EVENTS, kpiHref, kpisCanOf, libraryAddressOf, libraryHref, libraryRows, readProblem, writeProblem, type LibraryAddress } from './model'
import { LibraryView, type LibraryModel } from './view/LibraryView'

/**
 * `/w/<company>/home/kpis?q=&area=` (SCR-249, the KPI library): reads every KPI once (GET /insights/kpis, the address's
 * company as the scope), keeps the search and the area chip in the address, reads again when the metric layer says the
 * facts were rebuilt or a KPI changed (`facts.rebuilt`, `kpi.changed`, `kpi.uses_changed` on the tab's live channel),
 * writes the definitions' CSV in the browser (all shown, or the rows selected) and lets the owner install the standard KPIs
 * (POST /insights/kpis/sync). Without home.kpis.view the page says so and asks the API nothing.
 */
export function KpisPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/home\/kpis\/?$/, '')
  const can = useMemo(() => kpisCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  // The search and the chips answer at once (state here) and are kept in the address; an address that changes from outside
  // (back, a link) is taken over, never one this page just wrote (its replace may land after the next keystroke).
  const [address, setAddress] = useState<LibraryAddress>(() => libraryAddressOf(params))
  const written = useRef<Set<string>>(new Set())
  useEffect(() => {
    const fromUrl = libraryAddressOf(params)
    const href = libraryHref('', fromUrl)
    if (written.current.has(href)) {
      written.current.delete(href)
      return
    }
    setAddress(fromUrl)
  }, [params])
  const [library, setLibrary] = useState<{ value: KpiLibrary | null; problem: string | null }>({ value: null, problem: null })
  const [selected, setSelected] = useState<string[]>([])
  const [install, setInstall] = useState<NonNullable<LibraryModel['install']>>({ asking: false, busy: false, installed: null, problem: null })

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      setLibrary({ value: await getLibrary(api, { companyId }), problem: null })
    } catch (error) {
      setLibrary((current) => ({ value: current.value, problem: readProblem(error) }))
    }
  }, [api, can.view, companyId])

  useEffect(() => {
    void load()
  }, [load])

  // A rebuild of the facts or a change of a KPI is a hint to read again (quiet a second: a rebuild sends one per company).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const later = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void load(), 1000)
  }, [load])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useLiveBus({ onChange: (change) => (KPI_LIVE_EVENTS.includes(change.type) ? later() : undefined), onReconnect: later }, can.view)

  const exportCsv = (keys: readonly string[] | null) => {
    const value = library.value
    if (!value) return
    const t = createTranslator(locale, messagesFor(locale, ['home-kpis'])['home-kpis'] ?? {})
    const items = keys ? value.kpis.filter((item) => keys.includes(item.key)) : libraryRows(value.kpis, address, locale)
    download(definitionsCsv(items, t, locale), csvName(t('library.fileName'), value.asOf.slice(0, 10)))
  }

  return (
    <LibraryView
      model={{ can, prefix, address, library, selected, install }}
      actions={{
        onAddress: (next) => {
          setAddress(next)
          written.current.add(libraryHref('', next))
          router.replace(libraryHref(prefix, next), { scroll: false })
        },
        onRetry: () => void load(),
        onOpen: (key) => router.push(kpiHref(prefix, key)),
        onSelect: setSelected,
        onExport: exportCsv,
        onInstall: (step) => {
          if (step === 'ask') setInstall({ asking: true, busy: false, installed: null, problem: null })
          else if (step === 'cancel' || step === 'dismiss') setInstall({ asking: false, busy: false, installed: null, problem: null })
          else {
            setInstall({ asking: false, busy: true, installed: null, problem: null })
            installStandard(api)
              .then((result) => {
                setInstall({ asking: false, busy: false, installed: result.installed, problem: null })
                void load()
              })
              .catch((error: unknown) => setInstall({ asking: false, busy: false, installed: null, problem: writeProblem(error).key }))
          }
        },
      }}
    />
  )
}
