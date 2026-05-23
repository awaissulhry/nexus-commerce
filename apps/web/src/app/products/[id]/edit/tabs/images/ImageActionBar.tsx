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
import { Loader2, Save, X, Send, ChevronDown, LayoutGrid, Zap, Calendar } from 'lucide-react'
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
  // PB.10 — Opens the schedule-publish modal. Count badge surfaces
  // when there are pending scheduled rows.
  onOpenSchedule?: () => void
  pendingScheduleCount?: number
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

// PB.6 — localStorage key for the operator's remembered "Save &
// publish to…" target. JSON-encoded PublishTarget.
const SAVE_PUBLISH_TARGET_KEY = 'nexus.images.savePublishTarget'

function readStoredTarget(): PublishTarget | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SAVE_PUBLISH_TARGET_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PublishTarget
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.channel === 'AMAZON' && parsed.marketplace) return parsed
    if (parsed.channel === 'EBAY' || parsed.channel === 'SHOPIFY') return parsed
    return null
  } catch {
    return null
  }
}

function storeTarget(target: PublishTarget) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SAVE_PUBLISH_TARGET_KEY, JSON.stringify(target))
  } catch {
    // localStorage may be unavailable (private browsing, quota). Non-fatal.
  }
}

function describeTarget(target: PublishTarget): string {
  if (target.channel === 'AMAZON') {
    return target.marketplace === 'ALL' ? 'all Amazon markets' : `Amazon ${target.marketplace}`
  }
  if (target.channel === 'EBAY') return 'eBay'
  return 'Shopify'
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
  onOpenSchedule,
  pendingScheduleCount = 0,
}: Props) {
  const { t } = useTranslations()
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  // PB.6 — combo button state.
  const [comboOpen, setComboOpen] = useState(false)
  const comboRef = useRef<HTMLDivElement>(null)
  const [storedTarget, setStoredTarget] = useState<PublishTarget | null>(null)
  useEffect(() => { setStoredTarget(readStoredTarget()) }, [])

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

  // PB.6 — outside-click + Esc for the combo dropdown.
  useEffect(() => {
    if (!comboOpen) return
    function onMouseDown(e: MouseEvent) {
      if (!comboRef.current?.contains(e.target as Node)) setComboOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setComboOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [comboOpen])

  const anyPublishable =
    channelStatus.amazon.hasContent ||
    channelStatus.ebay.hasContent ||
    channelStatus.shopify.hasContent

  // Nothing dirty and no content to publish → don't render the bar.
  if (dirtyCount === 0 && !anyPublishable) return null

  // PB.6 — Compute the effective Save & publish target. Honor the
  // stored target when its channel still has content; otherwise
  // pick the channel with the most recent lastPublishedAt; otherwise
  // first available (Amazon → eBay → Shopify, Amazon defaults to ALL).
  function targetIsAvailable(t: PublishTarget): boolean {
    if (t.channel === 'AMAZON') return channelStatus.amazon.hasContent
    if (t.channel === 'EBAY') return channelStatus.ebay.hasContent
    return channelStatus.shopify.hasContent
  }
  function defaultTarget(): PublishTarget | null {
    if (storedTarget && targetIsAvailable(storedTarget)) return storedTarget
    const candidates: Array<{ target: PublishTarget; lastPub: string | null }> = []
    if (channelStatus.amazon.hasContent) candidates.push({ target: { channel: 'AMAZON', marketplace: 'ALL' }, lastPub: channelStatus.amazon.lastPublishedAt })
    if (channelStatus.ebay.hasContent)   candidates.push({ target: { channel: 'EBAY' },                       lastPub: channelStatus.ebay.lastPublishedAt })
    if (channelStatus.shopify.hasContent) candidates.push({ target: { channel: 'SHOPIFY' },                   lastPub: channelStatus.shopify.lastPublishedAt })
    if (candidates.length === 0) return null
    candidates.sort((a, b) => {
      if (a.lastPub && b.lastPub) return b.lastPub.localeCompare(a.lastPub)
      if (a.lastPub) return -1
      if (b.lastPub) return 1
      return 0
    })
    return candidates[0]!.target
  }
  const effectiveTarget = defaultTarget()

  function fireComboPublish(target: PublishTarget) {
    storeTarget(target)
    setStoredTarget(target)
    onPublish(target)
  }

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

          {/* PB.6 — Save & publish combo. Split button: main face fires
              save + publish to the remembered (or smart-default) target;
              chevron opens a small picker to change it. */}
          {effectiveTarget && (
            <div className="relative" ref={comboRef}>
              <div className="inline-flex">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => fireComboPublish(effectiveTarget)}
                  disabled={saving || publishing}
                  className="gap-1.5 rounded-r-none border-r border-blue-500/30"
                  title={`Save and publish to ${describeTarget(effectiveTarget)} in one click`}
                >
                  {publishing
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Zap className="w-3.5 h-3.5" />}
                  Save & publish to {describeTarget(effectiveTarget)}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setComboOpen((p) => !p)}
                  disabled={saving || publishing}
                  className="px-1.5 rounded-l-none"
                  aria-label="Change publish target"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </Button>
              </div>
              {comboOpen && (
                <div
                  role="menu"
                  className="absolute left-0 bottom-10 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl py-1 min-w-[260px] text-sm"
                >
                  <div className="px-3 py-1 text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400">
                    Save & publish target
                  </div>
                  {channelStatus.amazon.hasContent && (
                    <>
                      <Divider />
                      {AMAZON_MARKETS.map((m) => (
                        <DropdownItem
                          key={`combo-amz-${m}`}
                          label={`Amazon ${m}`}
                          onClick={() => { setComboOpen(false); fireComboPublish({ channel: 'AMAZON', marketplace: m }) }}
                        />
                      ))}
                      <DropdownItem
                        label="All Amazon markets"
                        primary
                        onClick={() => { setComboOpen(false); fireComboPublish({ channel: 'AMAZON', marketplace: 'ALL' }) }}
                      />
                    </>
                  )}
                  {channelStatus.ebay.hasContent && (
                    <>
                      <Divider />
                      <DropdownItem
                        label="eBay"
                        onClick={() => { setComboOpen(false); fireComboPublish({ channel: 'EBAY' }) }}
                      />
                    </>
                  )}
                  {channelStatus.shopify.hasContent && (
                    <>
                      <Divider />
                      <DropdownItem
                        label="Shopify"
                        onClick={() => { setComboOpen(false); fireComboPublish({ channel: 'SHOPIFY' }) }}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          )}
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

              {/* PB.10 — Schedule for later entry. Always available
                  when a channel can publish; opens a separate modal. */}
              {onOpenSchedule && (
                <>
                  <Divider />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setOpen(false); onOpenSchedule() }}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700 inline-flex items-center gap-2 text-slate-700 dark:text-slate-300"
                  >
                    <Calendar className="w-3.5 h-3.5 text-slate-400" />
                    Schedule for later…
                    {pendingScheduleCount > 0 && (
                      <span className="ml-auto text-[10px] font-medium px-1.5 py-px rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                        {pendingScheduleCount} pending
                      </span>
                    )}
                  </button>
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
