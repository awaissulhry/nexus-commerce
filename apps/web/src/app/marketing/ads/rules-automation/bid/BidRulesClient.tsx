'use client'

/**
 * The Bid page (2026-10-10, Bid page programme wave 2): header · tab bar · tiles · the view, whose toolbar starts with
 * the [Rules | Bids] switch.
 *
 * Rules (`rules/RulesView.tsx`): one table with the brain first, a side panel per rule, the bid builder for a new rule
 * and for "Edit all" — every change reviewed in the DS `ReviewChangesModal`. Bids (`bids/`, lane BIDS): every keyword bid
 * with its one owner, its own toolbar and panel. The tiles (`rules/BidTiles.tsx`) show the rules' numbers on the Rules
 * view and the bids' own numbers on the Bids view (audit M1); each filters the view under it.
 *
 * The page does all its work itself (Owner 2026-10-10): asks are decided here (a rule's Waiting tab), a rule's history,
 * undo and roll back are in its panel — nothing hands off to another page (no Change log, no Suggestions link).
 *
 * The header and the tab bar are the section's (`AdsPageHeader` → the DS `RulesHeader` the layout frames, lane SHELL).
 * The market picker writes `?market=`; the view is `?view=rules|bids`. The parked bid page (`BidClient.tsx` and its
 * section files) stays parked beside this file.
 */
import { useCallback, useEffect, useState } from 'react'
import { SegmentedControl } from '@/design-system/primitives'
import { ToastProvider } from '@/design-system/components'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { useAdsMarketplace, useSharedAdsMarket } from '../../_shell/MarketplaceContext'
import { RulesTabs, rulesTabHeader } from '../_shared/tabs'
import { BidsView, isBidsShow, type BidsTotals } from './bids'
import { BidTiles, type BidsTileTotals } from './rules/BidTiles'
import { isRulesTile } from './rules/bidRulesModel'
import { RulesView } from './rules/RulesView'
import { useBidRules } from './rules/useBidRules'
import styles from './bid.module.css'

const VIEWS = [{ value: 'rules', label: 'Rules' }, { value: 'bids', label: 'Bids' }]

export function BidRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const { readMarkets } = useAdsMarketplace()
  const [market] = useSharedAdsMarket({ raw: params.get('market') })
  const view = params.get('view') === 'bids' ? 'bids' : 'rules'
  const show = params.get('show')
  const data = useBidRules(market)
  const [bidsTotals, setBidsTotals] = useState<BidsTileTotals | null>(null)
  // The bids' numbers belong to one read of one market: a new market waits for its own.
  useEffect(() => { setBidsTotals(null) }, [market])
  // The contract with lane BIDS (M1): `show` filters its bids, `onTotals` reports its totals after each read.
  const onTotals = useCallback((t: BidsTotals) => { setBidsTotals({ changed7d: t.changed7d, contested: t.contested }) }, [])

  /** One place writes the address: the rest of the query is kept. `push` adds a history entry (opening a rule's detail,
   *  so Back closes it); everything else replaces the address. */
  const setQuery = useCallback((patch: Record<string, string | null>, opts?: { push?: boolean }) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const q = next.toString()
    const href = q ? `?${q}` : '?'
    if (opts?.push) router.push(href, { scroll: false })
    else router.replace(href, { scroll: false })
  }, [router])

  /** "Waiting for you": the rule's Waiting tab when one rule waits, else the rules that wait — always on this page. */
  const openWaiting = useCallback(() => {
    const waiting = (data.answer?.rules ?? []).filter((r) => !r.archived && r.waiting > 0)
    if (waiting.length === 1) setQuery({ view: null, show: null, archived: null, bid: null, rule: waiting[0].id, tab: 'waiting' }, { push: true })
    else setQuery({ view: null, show: 'waiting', archived: null, bid: null, rule: null, tab: null })
  }, [data.answer, setQuery])

  const viewSwitch = (
    <SegmentedControl
      size="sm"
      ariaLabel="View"
      options={VIEWS}
      value={view}
      onChange={(v) => setQuery({ view: v === 'bids' ? 'bids' : null, show: null, rule: null, bid: null, tab: null, builder: null, ruleId: null })}
    />
  )

  return (
    <ToastProvider>
      <div className="h10-rules-page">
        <AdsPageHeader
          {...rulesTabHeader('bid')}
          markets={readMarkets}
          market={market}
          onMarketChange={(m) => setQuery({ market: m && m !== 'all' ? m : null })}
          showDataSync={false}
          showDateRange={false}
          showChangeLog
        />
        <RulesTabs active="bid" />
        <div className={styles.page}>
          <BidTiles
            view={view}
            totals={data.answer?.totals ?? null}
            bids={view === 'bids' ? bidsTotals : null}
            tile={view === 'rules' && isRulesTile(show) ? show : null}
            bidsShow={view === 'bids' && isBidsShow(show) ? show : null}
            onQuery={setQuery}
            onWaiting={openWaiting}
          />
          {view === 'bids'
            ? <BidsView market={market} viewSwitch={viewSwitch} show={isBidsShow(show) ? show : undefined} onTotals={onTotals} />
            : <RulesView market={market} data={data} viewSwitch={viewSwitch} setQuery={setQuery} />}
        </div>
      </div>
    </ToastProvider>
  )
}
