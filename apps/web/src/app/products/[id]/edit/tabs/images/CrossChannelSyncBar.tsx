'use client'

// IM.7 — Cross-channel quick sync strip.
// Appears at the bottom of each channel panel (Amazon / eBay / Shopify).
// One click copies images from one channel into another as pending upserts.
// No confirmation needed — the user can Discard if unhappy.

import { ArrowRight, ArrowLeft, Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'

interface CopyResult { copied: number; skipped: number }

interface AmazonSyncProps {
  channel: 'amazon'
  hasMasterImages: boolean
  hasAmazonColorSets: boolean
  onCopyToEbayGallery: () => CopyResult
  onCopyToEbayColorSets: () => CopyResult
  onCopyToShopifyPool: () => CopyResult
  onCopyToShopifyAssignments: () => CopyResult
  onToast: (msg: string) => void
}

interface EbaySyncProps {
  channel: 'ebay'
  hasMasterImages: boolean
  hasAmazonImages: boolean
  hasAmazonColorSets: boolean
  onCopyFromMaster: () => CopyResult
  onCopyFromAmazonGallery: () => CopyResult
  onCopyFromAmazonColorSets: () => CopyResult
  onToast: (msg: string) => void
}

interface ShopifySyncProps {
  channel: 'shopify'
  hasMasterImages: boolean
  hasAmazonImages: boolean
  hasAmazonAssignments: boolean
  onCopyFromMaster: () => CopyResult
  onCopyFromAmazonPool: () => CopyResult
  onCopyFromAmazonAssignments: () => CopyResult
  onToast: (msg: string) => void
}

type Props = AmazonSyncProps | EbaySyncProps | ShopifySyncProps

function toastMsg(result: CopyResult, dest: string): string {
  if (result.copied === 0 && result.skipped > 0)
    return `Already in ${dest} — nothing new to copy`
  if (result.copied === 0)
    return `No images to copy to ${dest}`
  const skippedPart = result.skipped > 0 ? ` (${result.skipped} already existed)` : ''
  return `${result.copied} image${result.copied === 1 ? '' : 's'} added to ${dest}${skippedPart} — save to confirm`
}

function SyncButton({
  label,
  direction,
  onClick,
}: {
  label: string
  direction: 'push' | 'pull'
  onClick: () => void
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={onClick}
      className="gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-700 h-7 px-2.5"
    >
      {direction === 'push'
        ? <ArrowRight className="w-3 h-3" />
        : <ArrowLeft className="w-3 h-3" />}
      {label}
    </Button>
  )
}

export default function CrossChannelSyncBar(props: Props) {
  if (props.channel === 'amazon') {
    return (
      <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-slate-400 mr-1">
          <Copy className="w-3 h-3" /> Quick sync
        </div>
        {props.hasMasterImages && (
          <>
            <SyncButton label="→ eBay gallery" direction="push" onClick={() => props.onToast(toastMsg(props.onCopyToEbayGallery(), 'eBay gallery'))} />
            <SyncButton label="→ Shopify pool" direction="push" onClick={() => props.onToast(toastMsg(props.onCopyToShopifyPool(), 'Shopify pool'))} />
          </>
        )}
        {props.hasAmazonColorSets && (
          <>
            <SyncButton label="→ eBay color sets" direction="push" onClick={() => props.onToast(toastMsg(props.onCopyToEbayColorSets(), 'eBay color sets'))} />
            <SyncButton label="→ Shopify assignments" direction="push" onClick={() => props.onToast(toastMsg(props.onCopyToShopifyAssignments(), 'Shopify variant assignments'))} />
          </>
        )}
      </div>
    )
  }

  if (props.channel === 'ebay') {
    return (
      <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-slate-400 mr-1">
          <Copy className="w-3 h-3" /> Quick sync
        </div>
        {props.hasMasterImages && (
          <SyncButton label="← Master gallery" direction="pull" onClick={() => props.onToast(toastMsg(props.onCopyFromMaster(), 'eBay gallery'))} />
        )}
        {props.hasAmazonImages && (
          <SyncButton label="← Amazon gallery" direction="pull" onClick={() => props.onToast(toastMsg(props.onCopyFromAmazonGallery(), 'eBay gallery'))} />
        )}
        {props.hasAmazonColorSets && (
          <SyncButton label="← Amazon color sets" direction="pull" onClick={() => props.onToast(toastMsg(props.onCopyFromAmazonColorSets(), 'eBay color sets'))} />
        )}
      </div>
    )
  }

  // shopify
  return (
    <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1 text-xs text-slate-400 mr-1">
        <Copy className="w-3 h-3" /> Quick sync
      </div>
      {props.hasMasterImages && (
        <SyncButton label="← Master pool" direction="pull" onClick={() => props.onToast(toastMsg(props.onCopyFromMaster(), 'Shopify pool'))} />
      )}
      {props.hasAmazonImages && (
        <SyncButton label="← Amazon pool" direction="pull" onClick={() => props.onToast(toastMsg(props.onCopyFromAmazonPool(), 'Shopify pool'))} />
      )}
      {props.hasAmazonAssignments && (
        <SyncButton label="← Amazon assignments" direction="pull" onClick={() => props.onToast(toastMsg(props.onCopyFromAmazonAssignments(), 'Shopify assignments'))} />
      )}
    </div>
  )
}
