'use client'

/**
 * Professional category iconography for the automation surface — replaces emoji
 * with consistent lucide glyphs in a tinted tile, for an enterprise look.
 */

import { TrendingDown, Sprout, Ban, Scissors, Wallet, ShieldCheck, Activity, LayoutGrid, Package, Bell, Layers, Zap, type LucideIcon } from 'lucide-react'

const CAT: Record<string, LucideIcon> = {
  Bidding: TrendingDown,
  Harvesting: Sprout,
  Negation: Ban,
  Pruning: Scissors,
  Budget: Wallet,
  Profitability: ShieldCheck,
  Conversion: Activity,
  Placement: LayoutGrid,
  'Inventory & retail': Package,
  Alerts: Bell,
}

export function CatIcon({ cat, size = 17 }: { cat: string; size?: number }) {
  const I = CAT[cat] ?? Zap
  return <I size={size} />
}

export function PlaybookIcon({ size = 17 }: { size?: number }) {
  return <Layers size={size} />
}
