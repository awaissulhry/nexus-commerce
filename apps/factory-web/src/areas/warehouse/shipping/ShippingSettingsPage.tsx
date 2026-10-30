'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { listCarrierAccounts, listPrinters, listSiteSettings, saveSiteSettings, type CarrierAccount, type Printer, type SiteSettings } from './api'
import { abilitiesOf, bodyOf, chosenSite, readProblem, saveProblem, serverProblems, type FieldProblems, type SettingsForm } from './model'
import { ShippingSettingsView, type Part, type ShippingSettingsViewModel } from './view/ShippingSettingsView'

/**
 * `/w/<company>/warehouse/shipping` (SCR-068): reads the company's sites with their shipping settings
 * (shipping.settings.view), the company's Sendcloud accounts when the person may list them (integrations.view) and the
 * chosen site's printers (print.view), and saves a site's settings WHOLE (shipping.settings.manage) with the version
 * read: a refused field is said beside it, a version that moved keeps the person's typing behind "Reload". The site is
 * the address's `?site=` (a picker when the person reaches several).
 */
export function ShippingSettingsPage() {
  return (
    <WithMessages namespaces={['shipping-setup']}>
      <Container />
    </WithMessages>
  )
}

const LOADING = { value: null, problem: null }

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/shipping\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const siteId = params?.get('site') ?? null
  const companyId = session.company?.id ?? null

  const [sites, setSites] = useState<ShippingSettingsViewModel['sites']>({ status: 'loading' })
  const [accounts, setAccounts] = useState<Part<CarrierAccount[]> | null>(can.accounts ? LOADING : null)
  const [printers, setPrinters] = useState<Part<Printer[]> | null>(can.printers ? LOADING : null)
  const [formKey, setFormKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<ShippingSettingsViewModel['notice']>(null)
  const [conflict, setConflict] = useState(false)
  const [problems, setProblems] = useState<FieldProblems>({})
  // One key per save attempt of the same settings: a lost answer sent again is answered from its receipt.
  const attempt = useRef<{ body: string; key: string } | null>(null)

  const loadSites = useCallback(async () => {
    try {
      const items = await listSiteSettings(api, companyId)
      setSites({ status: 'ready', items })
      return items
    } catch (error) {
      setSites({ status: 'error', problem: readProblem(error) })
      return null
    }
  }, [api, companyId])

  const loadAccounts = useCallback(() => {
    if (!can.accounts) return
    setAccounts(LOADING)
    listCarrierAccounts(api)
      .then((value) => setAccounts({ value, problem: null }))
      .catch((error: unknown) => setAccounts({ value: null, problem: readProblem(error) }))
  }, [api, can.accounts])

  useEffect(() => {
    void loadSites()
    loadAccounts()
  }, [loadSites, loadAccounts])

  const site = sites.status === 'ready' ? chosenSite(sites.items, siteId) : null
  const shownSiteId = site?.site.id ?? null

  const loadPrinters = useCallback(() => {
    if (!can.printers || !shownSiteId) return
    setPrinters(LOADING)
    listPrinters(api, shownSiteId)
      .then((value) => setPrinters({ value, problem: null }))
      .catch((error: unknown) => setPrinters({ value: null, problem: readProblem(error) }))
  }, [api, can.printers, shownSiteId])

  useEffect(() => {
    loadPrinters()
  }, [loadPrinters])

  const replace = (saved: SiteSettings) =>
    setSites((current) => (current.status === 'ready' ? { status: 'ready', items: current.items.map((entry) => (entry.site.id === saved.site.id ? saved : entry)) } : current))

  const save = useCallback(
    async (form: SettingsForm) => {
      if (!site || busy) return
      const body = bodyOf(form, site.settings?.version ?? null)
      const text = JSON.stringify(body)
      if (attempt.current?.body !== text) attempt.current = { body: text, key: newIdempotencyKey() }
      const key = attempt.current.key
      setBusy(true)
      setNotice(null)
      setProblems({})
      try {
        const saved = await saveSiteSettings(api, site.site.id, body, key)
        attempt.current = null
        replace(saved)
        setConflict(false)
        setSavedAt(new Date().toISOString())
        setFormKey((key) => key + 1)
      } catch (error) {
        const refused = saveProblem(error)
        if (refused.conflict) setConflict(true)
        else {
          setProblems(serverProblems(error))
          setNotice({ tone: 'danger', key: refused.key })
        }
      } finally {
        setBusy(false)
      }
    },
    [api, site, busy],
  )

  const model: ShippingSettingsViewModel = {
    prefix,
    can,
    sites,
    siteId: shownSiteId,
    accounts,
    printers,
    formKey: String(formKey),
    busy,
    savedAt,
    notice,
    conflict,
    serverProblems: problems,
  }

  return (
    <ShippingSettingsView
      model={model}
      actions={{
        onSite: (next) => {
          setSavedAt(null)
          setNotice(null)
          setConflict(false)
          setProblems({})
          router.replace(`${pathname}?site=${encodeURIComponent(next)}`)
        },
        onSave: (form) => void save(form),
        onRetry: () => {
          setSites({ status: 'loading' })
          void loadSites()
          loadAccounts()
        },
        onReload: () => {
          void loadSites().then((items) => {
            if (!items) return
            setConflict(false)
            setSavedAt(null)
            setFormKey((key) => key + 1)
          })
        },
        onRetryPart: (part) => (part === 'accounts' ? loadAccounts() : loadPrinters()),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
