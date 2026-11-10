'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { defaultSectionLayout, readSectionLayout, writeSectionLayout, type SectionLayoutValue } from '@nexus/ui/patterns'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { liveMatches } from '../../quality/_shared/hooks'
import { problemKey } from '../../quality/_shared/model'
import { getCr6, getExpiries, getGaps, getKpis, getRegister, type Cr6, type Expiries, type Gaps, type Kpis, type Register } from './api'
import {
  cr6CsvRows,
  csvName,
  csvText,
  romeToday,
  expiryCsvRows,
  gapCsvRows,
  kpiCsvRows,
  LAYOUT_KEY,
  rangeShown,
  registerCsvRows,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  sectionSpecs,
  type CsvWords,
  type ReportsAddress,
  type ReportSection,
} from './model'
import { ReportsView, type Read } from './view/ReportsView'

/**
 * What changes a figure (design "certificate.* / shipment.shipped / gate.refused → KPIs (debounced; AsOf updates)"): a
 * certificate and its depth, a gate refusal or override, a requirement or a market, a register entry, a recall, an authority
 * notice or request, a lot's test or decision, a shipment's status, a supplier declaration decided. Each event comes only to
 * whoever may see its record; the page reads again.
 */
const LIVE_TYPES = [
  'compliance.certificate_',
  'certificates_depth.',
  'compliance_gates.',
  'compliance_rules.market_changed',
  'compliance.register_entry_',
  'recall.',
  'authority_notice.',
  'authority_request.',
  'lot.',
  'shipment.status_changed',
  'compliance_material_tests.declaration_decided',
]

const saveCsv = (name: string, text: string) => {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/**
 * `/w/<company>/compliance/reports?from=&to=&brand=` (SCR-261): the screen's company, the period of the address (else the 365
 * days up to today), a brand; five panels each read on its own (a failed one says so and the others stay), live re-reads,
 * Arrange saved per person on this device, a panel's rows as a CSV file, the annual compliance review (SCR-307) in a new tab.
 */
export function ReportsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/compliance\/reports\/?$/, '')
  const can = useMemo(() => reportsCan(session.permissions), [session.permissions])
  const address = useMemo(() => reportsAddressOf(params), [params])
  const enabled = can.view

  const [kpis, setKpis] = useState<Read<Kpis>>({ status: 'idle' })
  const [gaps, setGaps] = useState<Read<Gaps>>({ status: 'idle' })
  const [expiries, setExpiries] = useState<Read<Expiries>>({ status: 'idle' })
  const [cr6, setCr6] = useState<Read<Cr6>>({ status: 'idle' })
  const [register, setRegister] = useState<Read<Register>>({ status: 'idle' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const specs = useMemo(() => sectionSpecs((id) => id), [])
  const [layout, setLayout] = useState<SectionLayoutValue>(() => defaultSectionLayout(specs))
  useEffect(() => setLayout(readSectionLayout(LAYOUT_KEY, specs)), [specs])

  const scope = useMemo(() => ({ from: address.from, to: address.to, brandId: address.brandId }), [address.from, address.to, address.brandId])

  const readKpis = useCallback(async () => {
    if (!enabled) return
    try {
      const value = await getKpis(api, scope)
      setKpis({ status: 'ready', value })
      setAsOf(value.asOf)
    } catch (error) {
      setKpis({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scope])
  const readGaps = useCallback(async () => {
    if (!enabled) return
    try {
      setGaps({ status: 'ready', value: await getGaps(api, scope) })
    } catch (error) {
      setGaps({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scope])
  const readExpiries = useCallback(async () => {
    if (!enabled) return
    try {
      setExpiries({ status: 'ready', value: await getExpiries(api, scope) })
    } catch (error) {
      setExpiries({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scope])
  const readCr6 = useCallback(async () => {
    if (!enabled) return
    try {
      setCr6({ status: 'ready', value: await getCr6(api, scope) })
    } catch (error) {
      setCr6({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scope])
  const readRegister = useCallback(async () => {
    if (!enabled) return
    try {
      setRegister({ status: 'ready', value: await getRegister(api, scope) })
    } catch (error) {
      setRegister({ status: 'error', problem: problemKey(error) })
    }
  }, [api, enabled, scope])

  // One read after another (each panel on its own): the matrix reads of KPIs and gaps are the heaviest.
  useEffect(() => {
    if (!enabled) return
    setKpis({ status: 'loading' })
    setGaps({ status: 'loading' })
    setExpiries({ status: 'loading' })
    setCr6({ status: 'loading' })
    setRegister({ status: 'loading' })
    void (async () => {
      await readKpis()
      await readGaps()
      await readExpiries()
      await readCr6()
      await readRegister()
    })()
  }, [enabled, readKpis, readGaps, readExpiries, readCr6, readRegister])

  const readAll = useCallback(() => {
    void (async () => {
      await readKpis()
      await readGaps()
      await readExpiries()
      await readCr6()
      await readRegister()
    })()
  }, [readKpis, readGaps, readExpiries, readCr6, readRegister])
  const refresh = useCoalesced(readAll, 1500)
  const live = useLive((change) => (liveMatches(change, LIVE_TYPES) ? refresh() : undefined), readAll, enabled)

  const go = (change: Partial<ReportsAddress>) => router.replace(`${pathname}${reportsAddressText({ ...address, ...change })}`, { scroll: false })
  const answered = kpis.status === 'ready' ? kpis.value : register.status === 'ready' ? register.value : null
  const range = rangeShown(address, answered)
  const today = kpis.status === 'ready' ? kpis.value.today : romeToday()

  const exportPanel = (panel: ReportSection, words: CsvWords) => {
    const labels = words.labels ?? {}
    if (panel === 'kpi' && kpis.status === 'ready') saveCsv(csvName(panel, range), csvText(words.header, kpiCsvRows(kpis.value, labels, locale)))
    if (panel === 'gaps' && gaps.status === 'ready') saveCsv(csvName(panel, range), csvText(words.header, gapCsvRows(gaps.value.rows, labels)))
    if (panel === 'expiry' && expiries.status === 'ready') saveCsv(csvName(panel, { from: expiries.value.from, to: expiries.value.to }), csvText(words.header, expiryCsvRows(expiries.value)))
    if (panel === 'cr6' && cr6.status === 'ready') saveCsv(csvName(panel, range), csvText(words.header, cr6CsvRows(cr6.value, words, locale)))
    if (panel === 'register' && register.status === 'ready') saveCsv(csvName(panel, range), csvText(words.header, registerCsvRows(register.value, labels, locale)))
  }

  const retry: Record<ReportSection, () => void> = {
    kpi: () => {
      setKpis({ status: 'loading' })
      void readKpis()
    },
    gaps: () => {
      setGaps({ status: 'loading' })
      void readGaps()
    },
    expiry: () => {
      setExpiries({ status: 'loading' })
      void readExpiries()
    },
    cr6: () => {
      setCr6({ status: 'loading' })
      void readCr6()
    },
    register: () => {
      setRegister({ status: 'loading' })
      void readRegister()
    },
  }

  return (
    <ReportsView
      model={{ prefix, can, address, companyName: session.company?.name ?? null, range, today, kpis, gaps, expiries, cr6, register, live, asOf, layout, specs, arranging }}
      actions={{
        onAddress: go,
        onRetry: (panel) => retry[panel](),
        onArrange: setArranging,
        onArranged: (next) => {
          setLayout(next)
          writeSectionLayout(LAYOUT_KEY, next)
          setArranging(false)
        },
        onExport: exportPanel,
      }}
    />
  )
}
