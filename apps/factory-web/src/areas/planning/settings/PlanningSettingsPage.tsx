'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { listPlanningSites, type PlanningSite } from './api'
import { CalendarsTab } from './calendars/CalendarsTab'
import { chosenSite, PLANNING_SETTINGS_NAMESPACES, readProblem, settingsCan, settingsHref, tabOf, type SaveStatus, type TabHost } from './model'
import { EfficiencyTab } from './params/EfficiencyTab'
import { HorizonTab } from './params/HorizonTab'
import { ItemsTab } from './params/ItemsTab'
import { ReorderTab } from './params/ReorderTab'
import { PlanningSettingsView, type PlanningSettingsModel } from './view/PlanningSettingsView'

/**
 * `/w/<company>/planning/settings?site=&tab=calendars|items|reorder|horizon|efficiency` (SCR-124, SCR-127): reads the
 * sites the person plans at (`GET /planning/settings`, planning.view) and draws the frame; the tab's own container
 * reads and keeps its part (calendars and shift patterns; item parameters; reorder rules; horizon and buckets; line
 * efficiency) with its own terms in the address. A tab reports its save words to the band.
 */
export function PlanningSettingsPage() {
  return (
    <WithMessages namespaces={PLANNING_SETTINGS_NAMESPACES}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/planning\/settings\/?$/, '')
  const can = useMemo(() => settingsCan(session.permissions), [session.permissions])
  const tab = tabOf(params?.get('tab'))
  const companyId = session.company?.id ?? null
  const [sites, setSites] = useState<PlanningSettingsModel['sites']>({ status: 'loading' })
  const [status, setStatus] = useState<SaveStatus | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      const items = (await listPlanningSites(api, companyId)).map((entry) => entry.site).filter((site) => !companyId || site.companyId === companyId)
      setSites({ status: 'ready', items })
    } catch (error) {
      setSites({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, companyId])
  useEffect(() => {
    void load()
  }, [load])

  const all: readonly PlanningSite[] = sites.status === 'ready' ? sites.items : []
  const site = chosenSite(all, params?.get('site'))
  useEffect(() => setStatus(null), [tab, site?.id])

  const setParams = useCallback(
    (patch: Readonly<Record<string, string | null>>) => {
      const query = new URLSearchParams(params?.toString() ?? '')
      for (const [name, value] of Object.entries(patch)) {
        if (value === null || value === '') query.delete(name)
        else query.set(name, value)
      }
      router.replace(`${pathname}?${query.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  const host: TabHost | null = site ? { prefix, site, sites: all, can, onStatus: setStatus, param: (name) => params?.get(name) ?? null, setParams } : null
  const body = !host ? null : tab === 'calendars' ? (
    <CalendarsTab key={site!.id} host={host} />
  ) : tab === 'items' ? (
    <ItemsTab key={site!.id} host={host} />
  ) : tab === 'reorder' ? (
    <ReorderTab key={site!.id} host={host} />
  ) : tab === 'horizon' ? (
    <HorizonTab key={site!.id} host={host} />
  ) : (
    <EfficiencyTab key={site!.id} host={host} />
  )

  return (
    <PlanningSettingsView
      model={{ prefix, can, tab, sites, siteId: site?.id ?? null, status }}
      actions={{
        onSite: (next) => router.replace(settingsHref(prefix, next, tab)),
        onRetry: () => {
          setSites({ status: 'loading' })
          void load()
        },
      }}
    >
      {body}
    </PlanningSettingsView>
  )
}
