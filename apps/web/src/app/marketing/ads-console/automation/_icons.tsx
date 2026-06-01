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

/** Strip leading emoji/symbols from seeded rule names/messages for a clean, professional display. */
export const cleanName = (s: string | null | undefined): string =>
  (s ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}]/gu, '').replace(/\s{2,}/g, ' ').trim()
