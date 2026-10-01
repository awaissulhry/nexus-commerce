'use client'

/**
 * A-53 — what a tab shows when the studio has no market to open in, in place of the old
 * *"Waiting for the market…"* line (Sheet, Matrix, Variants). See `marketGate.ts`.
 *
 * DS `EmptyState` + `Button` only; no feature CSS beyond the frame's own centring. `NoMarketView` is the pure
 * render (every state testable with `renderToStaticMarkup`); `NoMarketState` wires it to the frame.
 */
import { useState } from 'react'
import { AlertTriangle, Store } from 'lucide-react'

import { EmptyState } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { usePermission } from '@/lib/auth/AuthProvider'

import { useStudioDiscovery, useStudioScope } from './contracts'
import { marketGate, setUpMarkets, SET_UP_MARKETS_PERMISSION, type MarketGate } from './marketGate'
import styles from './studio.module.css'

export function useMarketGate(): MarketGate {
  const { market, locale, options } = useStudioScope()
  const discovery = useStudioDiscovery()
  return marketGate({ market, locale, marketCount: options.markets.length, discoveryFailed: discovery?.failed === true })
}

export interface NoMarketViewProps {
  gate: MarketGate
  /** The frame's market re-read; absent outside a studio frame, and then no button is offered. */
  onRetry?: () => void
  retrying: boolean
  canSetUp: boolean
  onSetUp?: () => void
  settingUp: boolean
  /** The server's refusal of the last set-up, as a sentence. */
  refusal: string | null
}

export function NoMarketView({ gate, onRetry, retrying, canSetUp, onSetUp, settingUp, refusal }: NoMarketViewProps) {
  if (gate === 'ready') return null
  if (gate === 'failed') {
    return (
      <div className={styles.centered}>
        <EmptyState
          icon={<AlertTriangle size={20} />}
          title="Markets could not be loaded"
          description="Nexus could not read this business's markets, so the product sheet has no market to open in."
          action={onRetry ? (
            <Button size="sm" variant="secondary" disabled={retrying} onClick={onRetry}>
              {retrying ? 'Trying again…' : 'Try again'}
            </Button>
          ) : undefined}
        />
      </div>
    )
  }
  const busy = settingUp || retrying
  return (
    <div className={styles.centered}>
      <EmptyState
        icon={<Store size={20} />}
        title="This business has no markets yet"
        description={<>
          The product sheet opens in a market, and none are set up for this business. Setting up adds the standard
          Amazon, eBay, Shopify, WooCommerce and Etsy markets. Only channels you have connected appear in the scope bar.
          {!canSetUp && ' Ask an owner of this business to set up markets.'}
          {refusal && <><br />{refusal}</>}
        </>}
        action={canSetUp && onSetUp ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={onSetUp}>
            {busy ? 'Setting up…' : 'Set up markets'}
          </Button>
        ) : undefined}
      />
    </div>
  )
}

export function NoMarketState() {
  const gate = useMarketGate()
  const discovery = useStudioDiscovery()
  const canSetUp = usePermission(SET_UP_MARKETS_PERMISSION)
  const [settingUp, setSettingUp] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const retry = discovery?.retry
  const setUp = async () => {
    if (!retry) return
    setSettingUp(true)
    setRefusal(null)
    try {
      const result = await setUpMarkets(() => fetch(`${getBackendUrl()}/api/marketplaces/seed`, { method: 'POST' }), retry)
      if (!result.ok) setRefusal(result.message)
    } finally { setSettingUp(false) }
  }
  return (
    <NoMarketView gate={gate} retrying={discovery?.retrying === true} canSetUp={canSetUp} settingUp={settingUp} refusal={refusal}
      onRetry={retry ? () => void retry() : undefined} onSetUp={retry ? () => void setUp() : undefined} />
  )
}
