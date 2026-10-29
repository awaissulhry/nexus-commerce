'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { listCompanies, listDevices, listIdentities, listPrinters, listRoles, listSeries, listUsers, privacyOverview } from '../shared/api'
import { problemKey } from '../shared/model'
import { READ_RIGHTS, setupSteps, STEP_READ, type OverviewFacts, type Read, type ReadName } from './model'
import { AdminOverviewView } from './view/AdminOverviewView'

const CHECKING: Read<never> = { state: 'checking' }

/**
 * `/w/<company>/admin` — All settings (W0: the set-up checklist). Reads what each step rests on, only where the person
 * holds the right (a read they may not make says so instead of failing), and reads it all again on "Check again" and
 * when the tab comes back into view (no live event reports these facts yet).
 */
export function AdminOverview() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const [facts, setFacts] = useState<Omit<OverviewFacts, 'me'>>({
    companies: CHECKING,
    identities: CHECKING,
    series: CHECKING,
    users: CHECKING,
    roles: CHECKING,
    devices: CHECKING,
    printers: CHECKING,
    privacy: CHECKING,
  })
  const [checkedAt, setCheckedAt] = useState<string | null>(null)

  const readOne = useCallback(
    async (name: ReadName) => {
      const right = READ_RIGHTS[name]
      if (!held.has(right)) {
        setFacts((current) => ({ ...current, [name]: { state: 'no-right', need: right } }))
        return
      }
      setFacts((current) => ({ ...current, [name]: CHECKING }))
      const work: Record<ReadName, () => Promise<unknown>> = {
        companies: () => listCompanies(api),
        identities: () => listIdentities(api),
        series: () => listSeries(api),
        users: () => listUsers(api),
        roles: () => listRoles(api),
        devices: () => listDevices(api),
        printers: () => listPrinters(api),
        privacy: () => privacyOverview(api),
      }
      try {
        const value = await work[name]()
        setFacts((current) => ({ ...current, [name]: { state: 'ok', value } }))
      } catch (error) {
        setFacts((current) => ({ ...current, [name]: { state: 'failed', problem: problemKey(error) } }))
      }
    },
    [api, held],
  )

  const readAll = useCallback(async () => {
    await Promise.all((Object.keys(READ_RIGHTS) as ReadName[]).map((name) => readOne(name)))
    setCheckedAt(new Date().toISOString())
  }, [readOne])

  useEffect(() => {
    void readAll()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void readAll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [readAll])

  const steps = setupSteps({ me: session.user.id, ...facts } as OverviewFacts, prefix, OFFICE_PAGES)
  return (
    <AdminOverviewView
      model={{ prefix, steps, checkedAt, showAll: false }}
      actions={{
        onRecheck: () => void readAll(),
        onRetry: (stepId) => {
          const read = STEP_READ[stepId as keyof typeof STEP_READ]
          if (read) void readOne(read)
        },
      }}
    />
  )
}
