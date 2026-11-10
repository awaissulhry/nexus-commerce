'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLive, useStepUp } from '../../quality/_shared/hooks'
import { addressOf, addressText, liveTabsOf, rulesCan, tabOf, withAddress, type SettingsAddress, type SettingsTab } from './model'
import { useCr6, useGates } from './use-cr6-gates'
import { useMarkets, usePhrases } from './use-markets-phrases'
import { useOperators } from './use-operators'
import { useRegs } from './use-regs'
import type { TabContext } from './use-settings'
import type { Notice } from './view-model'
import { RulesMarketsView } from './view/RulesMarketsView'

/** Today in the factory's zone (Europe/Rome), the API's "today". */
const todayInRome = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * `/w/<company>/compliance/settings` (SCR-262; B-W2b-265; design compliance.settings): the container. The address holds the tab
 * (`?tab=cr6|gates|regulations|markets|phrases|operators`), its filters and its dialogs (`?add=1`, `?open=`, `?change=`); only
 * the tab shown reads (each part loads and fails on its own). Writes are one call each through the API's own commands (the
 * row's version, an Idempotency-Key); a looser gate or Cr VI rule asks the DS step-up dialog on the API's 403 `stepUp`. Live:
 * the rules' events (quality.settings_changed, compliance_gates.*, compliance_rules.*) read the tab they touch again,
 * coalesced; after a break everything shown is read again.
 */
export function RulesMarketsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale() === 'it' ? 'it' : 'en'
  const prefix = pathname.replace(/\/compliance\/settings\/?$/, '')
  const can = useMemo(() => rulesCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const tab = tabOf(address, can)
  const [today] = useState(todayInRome)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ticks, setTicks] = useState<Record<SettingsTab, number>>({ cr6: 0, gates: 0, regulations: 0, markets: 0, phrases: 0, operators: 0 })
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const go = useCallback(
    (change: Partial<SettingsAddress>) => {
      if (change.tab !== undefined) setNotice(null)
      router.replace(`${pathname}${addressText(withAddress(address, change))}`, { scroll: false })
    },
    [router, pathname, address],
  )
  const stamp = useCallback(() => setReadAt(new Date().toISOString()), [])
  const base = { api, can, address, go, guard, notify: setNotice, stamp, locale, companyId: session.company?.id ?? null, today, me: session.user.id } as const
  const contextOf = (id: SettingsTab): TabContext => ({ ...base, active: tab === id, tick: ticks[id] })

  const cr6 = useCr6(contextOf('cr6'))
  const gates = useGates(contextOf('gates'))
  const regs = useRegs(contextOf('regulations'))
  const markets = useMarkets(contextOf('markets'))
  const phrases = usePhrases(contextOf('phrases'))
  const operators = useOperators(contextOf('operators'))

  // Live: a hint per tab, coalesced (rows never move under the cursor while typing: a cell read again keeps its mark).
  const pending = useRef(new Set<SettingsTab>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bump = useCallback((tabs: readonly SettingsTab[]) => {
    tabs.forEach((id) => pending.current.add(id))
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      const due = [...pending.current]
      pending.current.clear()
      setTicks((current) => {
        const next = { ...current }
        for (const id of due) next[id] += 1
        return next
      })
    }, 800)
  }, [])
  const live = useLive(
    (change) => {
      const tabs = liveTabsOf(change.type)
      if (tabs.length > 0) bump(tabs)
    },
    () => bump(['cr6', 'gates', 'regulations', 'markets', 'phrases', 'operators']),
  )

  return (
    <RulesMarketsView
      model={{
        prefix,
        can,
        me: session.user.id,
        companyId: session.company?.id ?? null,
        companyName: session.company?.name ?? '',
        address,
        today,
        readAt,
        live,
        notice,
        stepUp,
        cr6: cr6.state,
        gates: gates.state,
        regs: regs.state,
        markets: markets.state,
        phrases: phrases.state,
        operators: operators.state,
      }}
      actions={{
        onAddress: go,
        onDismissNotice: () => setNotice(null),
        onStepUp: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onReload: () => tab && bump([tab]),
        cr6: cr6.actions,
        gates: gates.actions,
        regs: regs.actions,
        markets: markets.actions,
        phrases: phrases.actions,
        operators: operators.actions,
      }}
    />
  )
}
