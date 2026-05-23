'use client'

// PB.1 — Bottom action bar with Save / Discard + Publish picker.
//
// Visible whenever there are unsaved changes OR at least one channel
// has publishable content. The Save / Discard cluster only renders
// when there's something to commit. The Publish dropdown lives on
// the right and lists each channel + Amazon's 5 marketplaces; if
// dirtyCount > 0 it auto-saves first.
//
// Per-channel publish bars (AmazonPublishBar, EbayPanel, ShopifyPanel)
// still exist for fine-grained control — this bar is the always-visible
// one-click affordance that doesn't require scrolling into a panel.

import { useEffect, useRef, useState } from 'react'
import { Loader2, Save, X, Send, ChevronDown, LayoutGrid } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

const AMAZON_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const

export type PublishTarget =
  | { channel: 'AMAZON'; marketplace: typeof AMAZON_MARKETS[number] | 'ALL' }
  | { channel: 'EBAY' }
  | { channel: 'SHOPIFY' }

export interface ChannelPublishStatus {
  hasContent: boolean
  pendingCount: number
  lastPublishedAt: string | null
}

interface Props {
  dirtyCount: number
  saving: boolean
  publishing: boolean
  channelStatus: {
    amazon: ChannelPublishStatus
    ebay: ChannelPublishStatus
    shopify: ChannelPublishStatus
  }
  onSave: () => void
  onDiscard: () => void
  onPublish: (target: PublishTarget) => void
  // PB.5 — Opens the cross-channel summary modal. Owner is
  // ImagesTab so the modal can read the workspace state directly.
  onOpenCrossChannel?: () => void
}

function elapsed(ts: string | null): string {
  if (!ts) return 'never'
  const ms = Date.now() - new Date(ts).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function ImageActionBar({
  dirtyCount,
  saving,
  publishing,
  channelStatus,
  onSave,
  onDiscard,
  onPublish,
  onOpenCrossChannel,
}: Props) {
  const { t } = useTranslations()
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const anyPublishable =
    channelStatus.amazon.hasContent ||
    channelStatus.ebay.hasContent ||
    channelStatus.shopify.hasContent

  // Nothing dirty and no content to publish → don't render the bar.
  if (dirtyCount === 0 && !anyPublishable) return null

  return (
    <div className="mt-4 flex items-center gap-2 py-3 px-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl">
      {/* Save / Discard cluster — only when there are pending changes */}
      {dirtyCount > 0 && (
        <>
          <Button
            size="sm"
            onClick={onSave}
            disabled={saving || publishing}
            className="gap-1.5"
          >
            {saving
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Save className="w-3.5 h-3.5" />}
            {t('products.edit.images.actionBar.save')} ({t('products.edit.images.actionBar.changes', { count: dirtyCount })})
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDiscard}
            disabled={saving || publishing}
            className="gap-1 text-slate-500"
          >
            <X className="w-3.5 h-3.5" /> {t('products.edit.images.actionBar.discard')}
          </Button>
        </>
      )}

      {/* PB.5 — Cross-channel summary trigger. Sits to the left of
          the Publish dropdown when at least one channel is publishable. */}
      {anyPublishable && onOpenCrossChannel && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onOpenCrossChannel}
          disabled={publishing || saving}
          className="gap-1.5 border border-slate-200 dark:border-slate-700 ml-auto"
          title="Plan a publish across Amazon + eBay + Shopify in one pass"
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          All channels…
        </Button>
      )}

      {/* Publish dropdown — visible whenever there is publishable content */}
      {anyPublishable && (
        <div className={cn('relative', !onOpenCrossChannel && 'ml-auto')} ref={dropdownRef}>
          <Button
            size="sm"
            variant={dirtyCount > 0 ? 'secondary' : 'primary'}
            onClick={() => setOpen((p) => !p)}
            disabled={publishing || saving}
            className="gap-1.5"
            title="Publish images to a channel"
          >
            {publishing
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Send className="w-3.5 h-3.5" />}
            Publish
            <ChevronDown className="w-3 h-3" />
          </Button>
          {open && (
            <div
              role="menu"
              aria-label="Publish to channel"
              className="absolute right-0 bottom-10 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl py-1 min-w-[300px] text-sm"
            >
              {channelStatus.amazon.hasContent && (
                <ChannelSection title="Amazon" status={channelStatus.amazon}>
                  {AMAZON_MARKETS.map((m) => (
                    <DropdownItem
                      key={m}
                      label={`Publish to Amazon ${m}`}
                      onClick={() => { setOpen(false); onPublish({ channel: 'AMAZON', marketplace: m }) }}
                    />
                  ))}
                  <DropdownItem
                    label="Publish to all Amazon markets"
                    primary
                    onClick={() => { setOpen(false); onPublish({ channel: 'AMAZON', marketplace: 'ALL' }) }}
                  />
                </ChannelSection>
              )}

              {channelStatus.ebay.hasContent && (
                <>
                  {channelStatus.amazon.hasContent && <Divider />}
                  <ChannelSection title="eBay" status={channelStatus.ebay}>
                    <DropdownItem
                      label="Publish to eBay"
                      primary
                      onClick={() => { setOpen(false); onPublish({ channel: 'EBAY' }) }}
                    />
                  </ChannelSection>
                </>
              )}

              {channelStatus.shopify.hasContent && (
                <>
                  {(channelStatus.amazon.hasContent || channelStatus.ebay.hasContent) && <Divider />}
                  <ChannelSection title="Shopify" status={channelStatus.shopify}>
                    <DropdownItem
                      label="Publish to Shopify"
                      primary
                      onClick={() => { setOpen(false); onPublish({ channel: 'SHOPIFY' }) }}
                    />
                  </ChannelSection>
                </>
              )}

              {dirtyCount > 0 && (
                <>
                  <Divider />
                  <div className="px-3 py-1.5 text-[11px] text-slate-500 dark:text-slate-400 leading-tight">
                    {dirtyCount} pending change{dirtyCount === 1 ? '' : 's'} will be saved first.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ChannelSection({
  title,
  status,
  children,
}: {
  title: string
  status: ChannelPublishStatus
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="px-3 py-1 flex items-center gap-2 text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400">
        <span>{title}</span>
        {status.pendingCount > 0 && (
          <span className="px-1.5 py-px rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 normal-case font-medium">
            {status.pendingCount} pending
          </span>
        )}
        <span className="ml-auto normal-case font-normal text-slate-400 dark:text-slate-500">
          {status.lastPublishedAt ? `Last ${elapsed(status.lastPublishedAt)}` : 'Never published'}
        </span>
      </div>
      {children}
    </div>
  )
}

function DropdownItem({
  label,
  onClick,
  primary,
}: {
  label: string
  onClick: () => void
  primary?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700',
        primary
          ? 'text-blue-700 dark:text-blue-300 font-medium hover:bg-blue-50 dark:hover:bg-blue-950/30'
          : 'text-slate-700 dark:text-slate-300',
      )}
    >
      {label}
    </button>
  )
}

function Divider() {
  return <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
}
