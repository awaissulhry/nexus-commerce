'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import type { ApiClient } from '../../../../../lib/api/client'
import type { DepartmentAnswer } from '../../../../../lib/department/model'
import { wantDepartments } from '../../../../../lib/department/use-departments'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { moneyText } from '../../model'
import { deptLooksOf } from '../../routing/route/model'
import { useOfficeReach } from '../../routing/route/office'
import { problemKeyOf, refusalOf, type Words } from '../now/model'
import { createRate, readLeatherBases, readRates, readSettings, saveSettings, updateRate, type CostingSettings, type LeatherBasis, type RateRow } from './api'
import { deptRatesOf, draftOf, draftProblems, mayChangeRates, previewOf, ratesHeldOf, writesOf, type RatesDraft } from './model'
import { RatesWindow, type RatesWindowModel } from './view/RatesWindow'

/**
 * owb-pd5b step 5.4 (S4) — "The factory's rates…": a button and its ONE window, from the Cost tab and from Products › Settings ›
 * Costing defaults (the same window, the same right). It reads on open (the departments, the rates, the overhead and the company's
 * switch, the leathers), saves only what changed (a department rate: PATCH its own or POST one with `departmentId`; the overhead and
 * the switch in one settings write), then closes and tells the host (`onSaved`: the cost now moves). Outside the office (the design
 * index, a test's render) it draws nothing.
 */

export interface RatesDoorProps {
  /** The company whose rates are read and written (the style's, else the page's). */
  readonly companyId: string | null
  /** After a save: the cost now of every product moved. */
  readonly onSaved?: () => void
}

export function RatesDoor({ companyId, onSaved }: RatesDoorProps): ReactElement | null {
  const { api, can } = useOfficeReach()
  if (!api) return null
  return (
    <WithMessages namespaces={['products-cost']}>
      <Door api={api} change={mayChangeRates(can)} companyId={companyId} onSaved={onSaved} />
    </WithMessages>
  )
}

type Loaded = { status: 'reading' } | { status: 'failed'; problem: string } | { status: 'ready'; departments: readonly DepartmentAnswer[]; rates: RateRow[]; settings: CostingSettings; leathers: LeatherBasis[] }

function Door({ api, change, companyId, onSaved }: { api: ApiClient; change: boolean; companyId: string | null; onSaved?: () => void }): ReactElement {
  const t = useT('products-cost')
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ status: 'reading' })
  const [draft, setDraft] = useState<RatesDraft>({ depts: {}, overhead: '', oneKeeper: false, reason: '' })
  const [busy, setBusy] = useState(false)
  const [saveProblem, setSaveProblem] = useState<Words | null>(null)
  const [round, setRound] = useState(0)
  /** The draft starts from what is saved when the window opens; a read again after a refusal keeps what is typed. */
  const fresh = useRef(true)

  const read = useCallback(
    async (signal: AbortSignal) => {
      setLoaded({ status: 'reading' })
      try {
        const [departments, rates, settings, leathers] = await Promise.all([wantDepartments(api), readRates(api, companyId, signal), readSettings(api, companyId, signal), readLeatherBases(api, companyId, signal).catch(() => [] as LeatherBasis[])])
        setLoaded({ status: 'ready', departments, rates, settings, leathers })
        if (fresh.current) {
          setDraft(draftOf(settings))
          fresh.current = false
        }
      } catch (error) {
        if (!signal.aborted) setLoaded({ status: 'failed', problem: problemKeyOf(error) })
      }
    },
    [api, companyId],
  )
  useEffect(() => {
    if (!open) return
    const control = new AbortController()
    void read(control.signal)
    return () => control.abort()
  }, [open, read, round])

  const looks = useMemo(() => (loaded.status === 'ready' ? deptLooksOf(loaded.departments, locale) : []), [loaded, locale])
  const rows = useMemo(() => (loaded.status === 'ready' ? deptRatesOf(looks, loaded.rates) : []), [loaded, looks])
  const settings = loaded.status === 'ready' ? loaded.settings : null
  const problems = settings ? draftProblems(rows, draft, settings) : {}
  const today = new Date().toISOString().slice(0, 10)
  const writes = settings ? writesOf(rows, draft, settings, companyId, today) : []
  const currency = loaded.status === 'ready' ? (loaded.rates[0]?.currency ?? 'EUR') : 'EUR'
  const money = (amount: string | null | undefined) => moneyText(amount, currency, locale)

  const save = async () => {
    if (!settings || ratesHeldOf(problems, writes, busy)) return
    setBusy(true)
    setSaveProblem(null)
    try {
      for (const write of writes) {
        if (write.kind === 'create') await createRate(api, write.body)
        else if (write.kind === 'update') await updateRate(api, write.rate, write.body)
        else await saveSettings(api, write.body)
      }
      setOpen(false)
      onSaved?.()
    } catch (error) {
      setSaveProblem(refusalOf(error, []))
      // What was saved before the refusal stays: read again so the next Save starts from it.
      setRound((value) => value + 1)
    } finally {
      setBusy(false)
    }
  }

  const setDept = (departmentId: string, patch: Partial<{ cpm: string; eff: string }>) =>
    setDraft((current) => ({ ...current, depts: { ...current.depts, [departmentId]: { cpm: '', eff: '', ...current.depts[departmentId], ...patch } } }))

  const model: RatesWindowModel = {
    state: loaded.status,
    problem: loaded.status === 'failed' ? loaded.problem : null,
    change,
    rows: rows.map((row) => ({
      departmentId: row.departmentId,
      dept: row.dept,
      preview: previewOf(row, draft.depts[row.departmentId]),
      kind: row.kindRate ? { cpm: row.kindRate.costPerMinute ?? null, eff: row.kindRate.plannedEfficiencyPct } : null,
      draft: draft.depts[row.departmentId] ?? { cpm: '', eff: '' },
    })),
    overhead: draft.overhead,
    oneKeeper: draft.oneKeeper,
    oneKeeperSaved: settings ? draftOf(settings).oneKeeper : false,
    reason: draft.reason,
    leathers: loaded.status === 'ready' ? loaded.leathers.filter((leather) => leather.inForce) : [],
    problems,
    held: ratesHeldOf(problems, writes, busy),
    busy,
    saveProblem,
    money,
  }

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          fresh.current = true
          setOpen(true)
        }}
      >
        <SlidersHorizontal size={13} aria-hidden /> {t('rates.open')}
      </Button>
      {open && (
        <RatesWindow
          model={model}
          actions={{
            onCpm: (departmentId, text) => setDept(departmentId, { cpm: text }),
            onEff: (departmentId, text) => setDept(departmentId, { eff: text }),
            onOverhead: (text) => setDraft((current) => ({ ...current, overhead: text })),
            onOneKeeper: (on) => setDraft((current) => ({ ...current, oneKeeper: on })),
            onReason: (text) => setDraft((current) => ({ ...current, reason: text })),
            onSave: () => void save(),
            onClose: () => {
              setOpen(false)
              setSaveProblem(null)
            },
            onRetry: () => setRound((value) => value + 1),
          }}
        />
      )}
    </>
  )
}
