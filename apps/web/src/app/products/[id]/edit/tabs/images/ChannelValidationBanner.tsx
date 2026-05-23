'use client'

// PB.3a — Inline pre-publish validation banner for eBay + Shopify
// panels. Mirrors the Amazon hard-fail / soft-warn gate from IA.4
// but runs purely client-side off the shared validateImageList()
// from @nexus/shared/image-validation.
//
// Mounted at the top of EbayPanel + ShopifyPanel right above the
// gallery / pool. When blocking issues exist, the panel's own
// Publish button is disabled and this banner explains why.
//
// What it does NOT cover (deferred to PB.3b):
//   - Pre-publish preview modal (per-variant detail)
//   - Recent jobs strip with per-SKU receipts
//   - Stale detection (master.updatedAt > publishedAt)
// Per-color variation sets + per-variant assignments are checked
// at the gallery level here; granular per-color validation lands
// alongside the preview modal.

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  PLATFORM_RULES,
  validateImageList,
  type ImageForValidation,
  type PlatformKey,
  type ValidationIssue,
} from '@nexus/shared/image-validation'
import type { ListingImage, PendingUpsert, ProductImage } from './types'

interface Props {
  channel: 'EBAY' | 'SHOPIFY'
  /** Master gallery — used as a fallback when no channel-specific
   *  rows exist (the publish resolver cascades from master). */
  masterImages: ProductImage[]
  /** Saved channel listing images for THIS channel only. Callers
   *  pre-filter (listingImages.filter(i => i.platform === channel)). */
  channelImages: ListingImage[]
  /** Pending upserts for THIS channel only (caller pre-filtered). */
  pendingForChannel: PendingUpsert[]
  /** Pending deletes — checked against channelImages.id. */
  pendingDeletes: Set<string>
  /** True when the panel-level publish button is disabled for some
   *  other reason (publishing in progress, unsaved global state). */
  publishDisabledExternally?: boolean
}

export interface ChannelValidationResult {
  blocking: ValidationIssue[]
  warnings: ValidationIssue[]
  resolvedCount: number
  source: 'channel' | 'master'
}

// Build the effective list that would publish: pending upserts +
// saved channel rows minus deletes; falls back to master gallery
// when the channel has nothing. Mirrors what the publish handler
// would resolve server-side.
export function buildEffectiveImageList(opts: {
  masterImages: ProductImage[]
  channelImages: ListingImage[]
  pendingForChannel: PendingUpsert[]
  pendingDeletes: Set<string>
}): { images: ImageForValidation[]; source: 'channel' | 'master' } {
  const { masterImages, channelImages, pendingForChannel, pendingDeletes } = opts

  // Apply pending edits over saved rows.
  const channelGallery = channelImages
    .filter((i) => !i.variantGroupKey && !pendingDeletes.has(i.id))
  const pendingGallery = pendingForChannel.filter((u) => !u.variantGroupKey)

  // Replace saved rows that have a pending update of the same id.
  const pendingIds = new Set(pendingGallery.filter((u) => u.id).map((u) => u.id as string))
  const baseGallery = channelGallery.filter((i) => !pendingIds.has(i.id))

  const effective: ImageForValidation[] = [
    ...baseGallery.map((i) => ({
      url: i.url,
      role: i.role,
      width: i.width,
      height: i.height,
      mimeType: i.mimeType,
    })),
    ...pendingGallery.map((u) => ({
      url: u.url,
      role: u.role,
      width: u.width ?? null,
      height: u.height ?? null,
      mimeType: u.mimeType ?? null,
    })),
  ]

  if (effective.length > 0) {
    return { images: effective, source: 'channel' }
  }

  // Fallback: master gallery. The publish resolver does this anyway.
  return {
    images: masterImages.map((m) => ({
      url: m.url,
      role: m.type === 'MAIN' ? 'MAIN' : 'GALLERY',
      width: m.width,
      height: m.height,
      mimeType: m.mimeType,
    })),
    source: 'master',
  }
}

export function useChannelValidation(props: Props): ChannelValidationResult {
  return useMemo(() => {
    const { images, source } = buildEffectiveImageList(props)
    const result = validateImageList(images, props.channel as PlatformKey, 'DEFAULT')
    return {
      blocking: result.blocking,
      warnings: result.warnings,
      resolvedCount: images.length,
      source,
    }
  }, [props])
}

export default function ChannelValidationBanner(props: Props) {
  const result = useChannelValidation(props)
  const [expanded, setExpanded] = useState(false)
  const rules = PLATFORM_RULES[props.channel as PlatformKey]

  const hasBlocking = result.blocking.length > 0
  const hasWarnings = result.warnings.length > 0

  // No issues + has content → green "ready to publish" line.
  if (!hasBlocking && !hasWarnings && result.resolvedCount > 0) {
    return (
      <div className="px-5 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20">
        <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
        <span>
          {result.resolvedCount} image{result.resolvedCount === 1 ? '' : 's'} ready to publish
          {result.source === 'master' && ' (resolved from master gallery)'}
        </span>
        <span className="ml-auto text-slate-400 dark:text-slate-500 font-mono">
          {props.channel === 'EBAY' ? 'max 24' : 'max 250'} · min {rules.minDimensionPx}px
        </span>
      </div>
    )
  }

  // No images at all + no master fallback → quiet "nothing to publish yet".
  if (!hasBlocking && !hasWarnings && result.resolvedCount === 0) {
    return null
  }

  const tone = hasBlocking
    ? { bg: 'bg-rose-50 dark:bg-rose-950/30', border: 'border-rose-200 dark:border-rose-800', text: 'text-rose-700 dark:text-rose-300', icon: 'text-rose-500' }
    : { bg: 'bg-amber-50 dark:bg-amber-950/30', border: 'border-amber-200 dark:border-amber-800', text: 'text-amber-700 dark:text-amber-300', icon: 'text-amber-500' }

  return (
    <div className={cn('px-5 py-3 border-b text-xs', tone.bg, tone.border)}>
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="w-full flex items-start gap-2"
        aria-expanded={expanded}
      >
        <AlertTriangle className={cn('w-4 h-4 mt-0.5 flex-shrink-0', tone.icon)} />
        <div className="flex-1 min-w-0 text-left">
          <div className={cn('font-medium', tone.text)}>
            {hasBlocking
              ? `${result.blocking.length} blocking issue${result.blocking.length === 1 ? '' : 's'} — publish disabled`
              : `${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'} — publish allowed`}
            {result.source === 'master' && ' (resolving from master gallery)'}
          </div>
          {!expanded && (
            <div className="text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {hasBlocking
                ? result.blocking[0]?.message
                : result.warnings[0]?.message}
              {(hasBlocking ? result.blocking.length : result.warnings.length) > 1 && ' …'}
            </div>
          )}
        </div>
        <span className="text-slate-400 dark:text-slate-500 ml-2 flex-shrink-0">
          {expanded
            ? <ChevronUp className="w-3.5 h-3.5" />
            : <ChevronDown className="w-3.5 h-3.5" />}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 pl-6 space-y-1.5">
          {result.blocking.map((issue, idx) => (
            <IssueRow key={`b-${idx}`} issue={issue} blocking />
          ))}
          {result.warnings.map((issue, idx) => (
            <IssueRow key={`w-${idx}`} issue={issue} />
          ))}
        </div>
      )}
    </div>
  )
}

function IssueRow({ issue, blocking }: { issue: ValidationIssue; blocking?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className={cn(
        'font-mono uppercase text-[9px] px-1 py-px rounded mt-0.5 flex-shrink-0',
        blocking
          ? 'bg-rose-200/60 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200'
          : 'bg-amber-200/60 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200',
      )}>
        {issue.code}
      </span>
      <span className="text-slate-700 dark:text-slate-300">{issue.message}</span>
    </div>
  )
}
