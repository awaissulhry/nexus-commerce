'use client'

import { useRouter } from 'next/navigation'
import { CalendarClock, Download, History as HistoryIcon, Upload, Wand2 } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import AmazonFlatFileClient from '@/app/products/amazon-flat-file/AmazonFlatFileClient'
import EbayFlatFileClient from '@/app/products/ebay-flat-file/EbayFlatFileClient'

// ─── Channel tab bar — the only addition over the existing flat-file pages ────

interface TabBarProps {
  current: 'amazon' | 'ebay'
}

function ChannelTabBar({ current }: TabBarProps) {
  const router = useRouter()
  return (
    <div className="flex-shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 h-9 flex items-center gap-1">
      <button
        onClick={() => router.push('/bulk-operations?channel=amazon')}
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors',
          current === 'amazon'
            ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800',
        )}
      >
        Amazon
      </button>
      <button
        onClick={() => router.push('/bulk-operations?channel=ebay')}
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors',
          current === 'ebay'
            ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800',
        )}
      >
        eBay
      </button>

      <div className="flex-1" />

      {/* Sub-page links */}
      <div className="flex items-center gap-0.5">
        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mr-0.5" />
        {[
          { href: '/bulk-operations/imports',   icon: Upload,        label: 'Imports' },
          { href: '/bulk-operations/exports',   icon: Download,      label: 'Exports' },
          { href: '/bulk-operations/automation',icon: Wand2,         label: 'Automation' },
          { href: '/bulk-operations/schedules', icon: CalendarClock, label: 'Schedules' },
          { href: '/bulk-operations/history',   icon: HistoryIcon,   label: 'History' },
        ].map(({ href, icon: Icon, label }) => (
          <Link
            key={href}
            href={href}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </Link>
        ))}
      </div>
    </div>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  channel: 'amazon' | 'ebay'
  // Amazon
  amazonManifest: any
  amazonRows: any[]
  amazonMarketplace: string
  amazonProductType: string
  // eBay
  ebayRows: any[]
  ebayMarketplace: string
}

// ─── Wrapper ──────────────────────────────────────────────────────────────────

export default function BulkOpsChannelWrapper({
  channel,
  amazonManifest, amazonRows, amazonMarketplace, amazonProductType,
  ebayRows, ebayMarketplace,
}: Props) {
  return (
    <div className="h-dvh flex flex-col">
      <ChannelTabBar current={channel} />

      {/*
        overflow-auto makes this the scroll container so the flat-file client's
        sticky top-0 header sticks within this div (not the viewport), keeping
        the channel tab bar always visible above it.
      */}
      <div className="flex-1 min-h-0 overflow-auto">
        {channel === 'amazon' ? (
          <AmazonFlatFileClient
            initialManifest={amazonManifest}
            initialRows={amazonRows}
            initialMarketplace={amazonMarketplace}
            initialProductType={amazonProductType}
            familyId={undefined}
          />
        ) : (
          <EbayFlatFileClient
            initialRows={ebayRows}
            initialMarketplace={ebayMarketplace}
            familyId={undefined}
          />
        )}
      </div>
    </div>
  )
}
