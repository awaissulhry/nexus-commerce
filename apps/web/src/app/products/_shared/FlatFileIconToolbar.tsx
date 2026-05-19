'use client'

/**
 * FlatFileIconToolbar — Phase B of the toolbar unification.
 *
 * The canonical icon toolbar (Bar 2) shared by the Amazon flat-file
 * editor and the FlatFileGrid component (which eBay consumes). Both
 * channels now render the same buttons in the same order with the
 * same dividers, active/disabled states, and badge styling.
 *
 * Stays dumb on purpose: it only renders the buttons and exposes
 * state + click callbacks. All panels (Sort, Find & Replace,
 * Conditional Format, AI Bulk, AI Assistant) live in the consumers
 * and are passed in via `sortPanel` (positioned inline next to the
 * Sort button) or rendered elsewhere by the consumer.
 *
 * Channel-specific buttons (Pull from Amazon, Override badges,
 * Cascade toggles, etc.) come through the `slotAfterReplicate` and
 * `slotAfterSmartPaste` slots.
 */

import { cn } from '@/lib/utils'
import {
  AlertTriangle, BrainCircuit, ClipboardPaste, Copy, Image as ImageIcon,
  Redo2, Replace, SlidersHorizontal, Sparkles, Undo2,
  ArrowRightLeft,
} from 'lucide-react'

// ── TbBtn ───────────────────────────────────────────────────────────────
// Square 28×28 toolbar button. Exposed so callers can render extra
// buttons that match the toolbar's visual style (used by Amazon for its
// channel-specific Pull/History/Override/Cascade buttons).

export interface TbBtnProps {
  icon: React.ReactNode
  title: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  badge?: number
}

export function TbBtn({ icon, title, onClick, disabled, active, badge }: TbBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'relative h-7 w-7 flex items-center justify-center rounded transition-colors flex-shrink-0',
        active
          ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100',
        'disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent dark:disabled:hover:bg-transparent',
      )}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 text-[9px] font-bold bg-blue-500 text-white rounded-full flex items-center justify-center leading-none pointer-events-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

// ── Divider ─────────────────────────────────────────────────────────────

function Divider() {
  return <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />
}

// ── FlatFileIconToolbar ─────────────────────────────────────────────────

export type RowImageSize = 24 | 32 | 48 | 64 | 96

export interface FlatFileIconToolbarProps {
  // Undo / Redo
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void

  // Copy
  onCopy: () => void
  copyActive?: boolean
  copyDisabled?: boolean
  copyTitle?: string                       // override default tooltip

  // Replicate (only rendered when onReplicate provided)
  onReplicate?: () => void
  replicateActive?: boolean
  replicateDisabled?: boolean

  // Validation
  validationErrorCount: number
  validationWarnCount: number
  validationActive: boolean
  onValidationClick: () => void
  validationDisabled?: boolean

  // Smart paste
  smartPasteEnabled: boolean
  onSmartPasteToggle: () => void

  // Row images
  showRowImages: boolean
  rowImageSize: RowImageSize
  onRowImagesToggle: () => void
  onRowImageSizeChange: (size: RowImageSize) => void
  rowImagesDisabled?: boolean

  // Sort
  sortLevelCount: number
  sortPanelOpen: boolean
  onSortClick: () => void
  sortDisabled?: boolean
  /**
   * Optional panel rendered inside the Sort button's relative wrapper.
   * Consumer renders its own SortPanel (Amazon and FlatFileGrid have
   * different implementations) and passes it here when `sortPanelOpen`.
   */
  sortPanel?: React.ReactNode

  // Find & Replace
  findReplaceOpen: boolean
  onFindReplaceClick: () => void
  findReplaceDisabled?: boolean

  // Conditional formatting
  conditionalEnabledCount: number
  conditionalOpen: boolean
  onConditionalClick: () => void
  conditionalDisabled?: boolean

  // AI bulk actions
  aiBulkSelectedCount: number
  onAiBulkClick: () => void
  aiBulkDisabled?: boolean

  // AI Assistant (only rendered when onAiAssistantClick provided)
  aiAssistantOpen?: boolean
  onAiAssistantClick?: () => void

  // Channel-specific button slots
  slotAfterReplicate?: React.ReactNode      // e.g. Pull, History (Amazon + eBay)
  slotAfterSmartPaste?: React.ReactNode     // e.g. Override, Cascade, Reset (Amazon + eBay)

  // Trailing children — appended at the end of the toolbar before AI
  // Assistant. Used by Amazon to drop in any extras that don't fit a
  // standard slot.
  trailing?: React.ReactNode
}

const IMAGE_SIZE_OPTIONS: ReadonlyArray<{ size: RowImageSize; label: string }> = [
  { size: 24, label: 'XS' },
  { size: 32, label: 'S' },
  { size: 48, label: 'M' },
  { size: 64, label: 'L' },
  { size: 96, label: 'XL' },
]

export function FlatFileIconToolbar({
  canUndo, canRedo, onUndo, onRedo,
  onCopy, copyActive, copyDisabled, copyTitle,
  onReplicate, replicateActive, replicateDisabled,
  validationErrorCount, validationWarnCount, validationActive, onValidationClick, validationDisabled,
  smartPasteEnabled, onSmartPasteToggle,
  showRowImages, rowImageSize, onRowImagesToggle, onRowImageSizeChange, rowImagesDisabled,
  sortLevelCount, sortPanelOpen, onSortClick, sortDisabled, sortPanel,
  findReplaceOpen, onFindReplaceClick, findReplaceDisabled,
  conditionalEnabledCount, conditionalOpen, onConditionalClick, conditionalDisabled,
  aiBulkSelectedCount, onAiBulkClick, aiBulkDisabled,
  aiAssistantOpen, onAiAssistantClick,
  slotAfterReplicate, slotAfterSmartPaste, trailing,
}: FlatFileIconToolbarProps) {
  const validationTotal = validationErrorCount + validationWarnCount
  const validationTitle =
    validationTotal > 0
      ? `Validation: ${validationErrorCount} error${validationErrorCount !== 1 ? 's' : ''}, ${validationWarnCount} warning${validationWarnCount !== 1 ? 's' : ''}`
      : 'Validation — no issues'

  return (
    <div className="px-3 h-8 flex items-center gap-0.5 border-b border-slate-100 dark:border-slate-800/60">
      <TbBtn
        icon={<Undo2 className="w-3.5 h-3.5" />}
        title="Undo (⌘Z)"
        onClick={onUndo}
        disabled={!canUndo}
      />
      <TbBtn
        icon={<Redo2 className="w-3.5 h-3.5" />}
        title="Redo (⌘⇧Z)"
        onClick={onRedo}
        disabled={!canRedo}
      />
      <Divider />

      <TbBtn
        icon={<Copy className="w-3.5 h-3.5" />}
        title={copyTitle ?? 'Copy rows to another market'}
        onClick={onCopy}
        disabled={copyDisabled}
        active={copyActive}
      />
      {onReplicate && (
        <TbBtn
          icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
          title="Replicate to multiple markets"
          onClick={onReplicate}
          disabled={replicateDisabled}
          active={replicateActive}
        />
      )}

      {slotAfterReplicate}

      <Divider />

      <TbBtn
        icon={<AlertTriangle className="w-3.5 h-3.5" />}
        title={validationTitle}
        onClick={onValidationClick}
        active={validationActive}
        disabled={validationDisabled}
        badge={validationTotal || undefined}
      />
      <TbBtn
        icon={<ClipboardPaste className="w-3.5 h-3.5" />}
        title={
          smartPasteEnabled
            ? 'Smart paste ON — first row treated as column headers when ≥2 match. Click to turn off.'
            : 'Smart paste OFF — positional paste (default). Click to turn on header-mapping mode.'
        }
        onClick={onSmartPasteToggle}
        active={smartPasteEnabled}
      />

      <Divider />

      {slotAfterSmartPaste}

      <TbBtn
        icon={<ImageIcon className="w-3.5 h-3.5" />}
        title={showRowImages ? 'Hide product images' : 'Show product images in rows'}
        onClick={onRowImagesToggle}
        disabled={rowImagesDisabled}
        active={showRowImages}
      />
      {showRowImages && (
        <>
          {IMAGE_SIZE_OPTIONS.map(({ size, label }) => (
            <button
              key={size}
              type="button"
              onClick={() => onRowImageSizeChange(size)}
              className={cn(
                'h-6 px-1.5 rounded text-[10px] font-medium transition-colors flex-shrink-0',
                rowImageSize === size
                  ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800',
              )}
            >
              {label}
            </button>
          ))}
        </>
      )}

      <Divider />

      <div className="relative">
        <TbBtn
          icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
          title={
            sortLevelCount > 0
              ? `Sort — ${sortLevelCount} level${sortLevelCount !== 1 ? 's' : ''} active`
              : 'Sort rows'
          }
          onClick={onSortClick}
          disabled={sortDisabled}
          active={sortPanelOpen || sortLevelCount > 0}
          badge={sortLevelCount || undefined}
        />
        {sortPanel}
      </div>

      <Divider />

      <TbBtn
        icon={<Replace className="w-3.5 h-3.5" />}
        title="Find & Replace (⌘F)"
        onClick={onFindReplaceClick}
        disabled={findReplaceDisabled}
        active={findReplaceOpen}
      />
      <TbBtn
        icon={<Sparkles className="w-3.5 h-3.5" />}
        title={
          conditionalEnabledCount > 0
            ? `Conditional formatting (${conditionalEnabledCount} active)`
            : 'Conditional formatting'
        }
        onClick={onConditionalClick}
        disabled={conditionalDisabled}
        active={conditionalOpen}
        badge={conditionalEnabledCount || undefined}
      />
      <TbBtn
        icon={<Sparkles className="w-3.5 h-3.5 text-amber-500" />}
        title={
          aiBulkSelectedCount > 0
            ? `AI bulk actions (${aiBulkSelectedCount} selected)`
            : 'AI bulk actions — select rows first'
        }
        onClick={onAiBulkClick}
        disabled={aiBulkDisabled || aiBulkSelectedCount === 0}
        badge={aiBulkSelectedCount || undefined}
      />

      {trailing}

      {onAiAssistantClick && (
        <>
          <Divider />
          <TbBtn
            icon={<BrainCircuit className="w-3.5 h-3.5 text-violet-500" />}
            title={aiAssistantOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
            onClick={onAiAssistantClick}
            active={aiAssistantOpen}
          />
        </>
      )}
    </div>
  )
}
