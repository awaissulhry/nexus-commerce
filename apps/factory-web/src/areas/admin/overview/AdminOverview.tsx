'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { listCompanies, listDevices, listIdentities, listPrinters, listRoles, listSeries, listUsers, privacyOverview } from '../shared/api'
import { problemKey } from '../shared/model'
import { listAccounts } from '../connections/api'
import { listImports } from '../import/api'
import { readAttention, type Attention } from '../security/api'
import type { Read as SecurityRead } from '../security/model'
import { OPENING_STOCK, READ_RIGHTS, setupSteps, STEP_READ, type OverviewFacts, type Read, type ReadName } from './model'
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
    accounts: CHECKING,
    imports: CHECKING,
  })
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  // B-W2a-36: Needs attention (any office session; each kind only where the person may read it).
  const [attention, setAttention] = useState<SecurityRead<Attention>>({ state: 'loading' })
  const router = useRouter()
  const readAttentionList = useCallback(() => {
    readAttention(api).then(
      (value) => setAttention({ state: 'ok', value }),
      (error: unknown) => setAttention({ state: 'failed', problem: problemKey(error) }),
    )
  }, [api])

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
        accounts: () => listAccounts(api, { provider: 'SDI' }),
        imports: () => listImports(api, { importerKey: OPENING_STOCK, limit: 20 }),
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
    readAttentionList()
    await Promise.all((Object.keys(READ_RIGHTS) as ReadName[]).map((name) => readOne(name)))
    setCheckedAt(new Date().toISOString())
  }, [readOne, readAttentionList])

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
      model={{ prefix, steps, checkedAt, showAll: false, attention }}
      actions={{
        onAttentionRetry: readAttentionList,
        onOpen: (href) => router.push(href),
        onRecheck: () => void readAll(),
        onRetry: (stepId) => {
          const read = STEP_READ[stepId as keyof typeof STEP_READ]
          if (read) void readOne(read)
        },
      }}
    />
  )
}
