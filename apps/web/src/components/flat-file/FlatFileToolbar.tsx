'use client'
import { type ReactNode } from 'react'
import {
  Undo2, Redo2, Copy, ArrowRightLeft, ShieldAlert,
  ClipboardList, ImageIcon, SlidersHorizontal, Replace,
  Paintbrush2, Wand2, BrainCircuit, Columns,
} from 'lucide-react'
import { Tooltip } from '@/design-system/primitives/Tooltip'
import { Kbd } from '@/design-system/primitives/Kbd'
import { cn } from '@/lib/utils'
import { getToolDef } from './toolbar-icons'

// ── TbBtn ──────────────────────────────────────────────────────────────────
// Exported so channel-specific slot buttons can match toolbar visual style.

export interface TbBtnProps {
  icon: ReactNode
  title: string
  tooltipContent?: ReactNode
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  badge?: number
  className?: string
}

export function TbBtn({
  icon,
  title,
  tooltipContent,
  onClick,
  disabled,
  active,
  badge,
  className,
}: TbBtnProps) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded transition-colors',
        'text-slate-600 dark:text-slate-400',
        'hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100',
        active === true &&
          'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
        'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent dark:disabled:hover:bg-transparent',
        className,
      )}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-semibold leading-none text-white"
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )

  return (
    <Tooltip label={tooltipContent ?? <span className="text-xs">{title}</span>}>
      {btn}
    </Tooltip>
  )
}

// ── Rich tooltip content ───────────────────────────────────────────────────

function ToolTip({
  label,
  description,
  shortcut,
}: {
  label: string
  description: string
  shortcut?: string
}) {
  return (
    <div className="flex max-w-[200px] flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
          {label}
        </span>
        {shortcut && <Kbd className="text-[9px]">{shortcut}</Kbd>}
      </div>
      <span className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">
        {description}
      </span>
    </div>
  )
}

// ── TbDivider ─────────────────────────────────────────────────────────────

function TbDivider() {
  return (
    <div
      aria-hidden
      className="mx-1 h-4 w-px flex-shrink-0 bg-slate-200 dark:bg-slate-700"
    />
  )
}

// ── FlatFileToolbarProps ───────────────────────────────────────────────────

export type RowImageSize = 24 | 32 | 48 | 64 | 96

export interface FlatFileToolbarProps {
  // History
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void

  // Copy / Replicate
  onCopy: () => void
  copyActive?: boolean
  copyDisabled?: boolean
  /** override default "Copy to market" label */
  copyTitle?: string
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
   * different implementations) and passes it here when sortPanelOpen.
   */
  sortPanel?: ReactNode

  // Find & Replace
  findReplaceOpen: boolean
  onFindReplaceClick: () => void
  findReplaceDisabled?: boolean

  // Conditional format (Highlight rules)
  conditionalEnabledCount: number
  conditionalOpen: boolean
  onConditionalClick: () => void
  conditionalDisabled?: boolean

  // AI bulk edit
  aiBulkSelectedCount: number
  onAiBulkClick: () => void
  aiBulkDisabled?: boolean

  // AI Assistant (only rendered when onAiAssistantClick provided)
  aiAssistantOpen?: boolean
  onAiAssistantClick?: () => void

  // Columns modal (NEW — ⌘G; optional during rollout so existing consumers don't break)
  onColumnsClick?: () => void
  columnsActive?: boolean

  // Channel-specific button slots
  /** e.g. Pull, History buttons (Amazon + eBay) */
  slotAfterReplicate?: ReactNode
  /** e.g. Override, Cascade, Reset buttons (Amazon + eBay) */
  slotAfterSmartPaste?: ReactNode

  /** Appended before the Columns + AI Assistant group */
  trailing?: ReactNode
}

const IMAGE_SIZES = [24, 32, 48, 64, 96] as const
const IMAGE_LABELS = ['XS', 'S', 'M', 'L', 'XL'] as const

// ── FlatFileToolbar ────────────────────────────────────────────────────────

export function FlatFileToolbar({
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
  onColumnsClick, columnsActive,
  slotAfterReplicate, slotAfterSmartPaste, trailing,
}: FlatFileToolbarProps) {
  const validationBadge = validationErrorCount + validationWarnCount
  const undoDef = getToolDef('undo')
  const redoDef = getToolDef('redo')
  const copyDef = getToolDef('copy')
  const replicateDef = getToolDef('replicate')
  const validationDef = getToolDef('validation')
  const smartPasteDef = getToolDef('smart-paste')
  const rowImagesDef = getToolDef('row-images')
  const sortDef = getToolDef('sort')
  const findReplaceDef = getToolDef('find-replace')
  const conditionalDef = getToolDef('conditional-format')
  const aiBulkDef = getToolDef('ai-bulk')
  const aiAssistantDef = getToolDef('ai-assistant')
  const columnsDef = getToolDef('columns')

  return (
    <div className="flex h-8 items-center gap-0.5 border-b border-slate-100 bg-white px-3 dark:border-slate-800/60 dark:bg-slate-950">

      {/* History */}
      <TbBtn
        icon={<Undo2 className="h-3.5 w-3.5" />}
        title={undoDef.label}
        tooltipContent={<ToolTip label={undoDef.label} description={undoDef.description} shortcut={undoDef.shortcut} />}
        onClick={onUndo}
        disabled={!canUndo}
      />
      <TbBtn
        icon={<Redo2 className="h-3.5 w-3.5" />}
        title={redoDef.label}
        tooltipContent={<ToolTip label={redoDef.label} description={redoDef.description} shortcut={redoDef.shortcut} />}
        onClick={onRedo}
        disabled={!canRedo}
      />

      <TbDivider />

      {/* Clipboard */}
      <TbBtn
        icon={<Copy className="h-3.5 w-3.5" />}
        title={copyTitle ?? copyDef.label}
        tooltipContent={
          <ToolTip
            label={copyTitle ?? copyDef.label}
            description={copyDef.description}
            shortcut={copyDef.shortcut}
          />
        }
        onClick={onCopy}
        active={copyActive}
        disabled={copyDisabled}
      />
      {onReplicate && (
        <TbBtn
          icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
          title={replicateDef.label}
          tooltipContent={
            <ToolTip
              label={replicateDef.label}
              description={replicateDef.description}
              shortcut={replicateDef.shortcut}
            />
          }
          onClick={onReplicate}
          active={replicateActive}
          disabled={replicateDisabled}
        />
      )}
      {slotAfterReplicate}

      <TbDivider />

      {/* Validation + Smart Paste */}
      <TbBtn
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        title={validationDef.label}
        tooltipContent={
          <ToolTip
            label={
              validationBadge > 0
                ? `Validation — ${validationErrorCount} error(s), ${validationWarnCount} warning(s)`
                : 'Validation — no issues'
            }
            description={validationDef.description}
            shortcut={validationDef.shortcut}
          />
        }
        onClick={onValidationClick}
        disabled={validationDisabled}
        active={validationActive}
        badge={validationBadge || undefined}
        className={
          validationErrorCount > 0
            ? 'text-red-500 dark:text-red-400'
            : validationWarnCount > 0
            ? 'text-amber-500 dark:text-amber-400'
            : undefined
        }
      />
      <TbBtn
        icon={<ClipboardList className="h-3.5 w-3.5" />}
        title={smartPasteDef.label}
        tooltipContent={
          <ToolTip
            label={smartPasteEnabled ? 'Smart paste ON' : 'Smart paste OFF'}
            description={smartPasteDef.description}
            shortcut={smartPasteDef.shortcut}
          />
        }
        onClick={onSmartPasteToggle}
        active={smartPasteEnabled}
      />

      <TbDivider />

      {slotAfterSmartPaste}

      {/* Row images */}
      <TbBtn
        icon={<ImageIcon className="h-3.5 w-3.5" />}
        title={rowImagesDef.label}
        tooltipContent={
          <ToolTip
            label={showRowImages ? 'Row images ON' : 'Row images OFF'}
            description={rowImagesDef.description}
            shortcut={rowImagesDef.shortcut}
          />
        }
        onClick={onRowImagesToggle}
        active={showRowImages}
        disabled={rowImagesDisabled}
      />
      {showRowImages &&
        IMAGE_SIZES.map((sz, i) => (
          <button
            key={sz}
            type="button"
            onClick={() => onRowImageSizeChange(sz)}
            className={cn(
              'h-6 flex-shrink-0 rounded px-1.5 text-[10px] font-medium transition-colors',
              rowImageSize === sz
                ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
            )}
          >
            {IMAGE_LABELS[i]}
          </button>
        ))}

      <TbDivider />

      {/* Sort */}
      <div className="relative">
        <TbBtn
          icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
          title={sortDef.label}
          tooltipContent={
            <ToolTip
              label={
                sortLevelCount > 0
                  ? `Sort — ${sortLevelCount} level${sortLevelCount !== 1 ? 's' : ''} active`
                  : sortDef.label
              }
              description={sortDef.description}
              shortcut={sortDef.shortcut}
            />
          }
          onClick={onSortClick}
          active={sortPanelOpen || sortLevelCount > 0}
          disabled={sortDisabled}
          badge={sortLevelCount || undefined}
        />
        {sortPanel}
      </div>

      <TbDivider />

      {/* Find/Replace + Highlight rules + AI bulk edit */}
      <TbBtn
        icon={<Replace className="h-3.5 w-3.5" />}
        title={findReplaceDef.label}
        tooltipContent={
          <ToolTip
            label={findReplaceDef.label}
            description={findReplaceDef.description}
            shortcut={findReplaceDef.shortcut}
          />
        }
        onClick={onFindReplaceClick}
        active={findReplaceOpen}
        disabled={findReplaceDisabled}
      />
      <TbBtn
        icon={<Paintbrush2 className="h-3.5 w-3.5" />}
        title={conditionalDef.label}
        tooltipContent={
          <ToolTip
            label={
              conditionalEnabledCount > 0
                ? `${conditionalDef.label} (${conditionalEnabledCount} active)`
                : conditionalDef.label
            }
            description={conditionalDef.description}
            shortcut={conditionalDef.shortcut}
          />
        }
        onClick={onConditionalClick}
        active={conditionalOpen}
        disabled={conditionalDisabled}
        badge={conditionalEnabledCount || undefined}
      />
      <TbBtn
        icon={<Wand2 className="h-3.5 w-3.5" />}
        title={aiBulkDef.label}
        tooltipContent={
          <ToolTip
            label={
              aiBulkSelectedCount > 0
                ? `${aiBulkDef.label} (${aiBulkSelectedCount} rows)`
                : aiBulkDef.label
            }
            description={aiBulkDef.description}
            shortcut={aiBulkDef.shortcut}
          />
        }
        onClick={onAiBulkClick}
        disabled={aiBulkDisabled || aiBulkSelectedCount === 0}
        badge={aiBulkSelectedCount || undefined}
        className={aiBulkDef.iconColor}
      />

      {trailing}

      {onColumnsClick && (
        <>
          <TbDivider />
          <TbBtn
            icon={<Columns className="h-3.5 w-3.5" />}
            title={columnsDef.label}
            tooltipContent={
              <ToolTip
                label={columnsDef.label}
                description={columnsDef.description}
                shortcut={columnsDef.shortcut}
              />
            }
            onClick={onColumnsClick}
            active={columnsActive}
          />
        </>
      )}

      {/* AI Assistant */}
      {onAiAssistantClick && (
        <>
          <TbDivider />
          <TbBtn
            icon={<BrainCircuit className="h-3.5 w-3.5" />}
            title={aiAssistantDef.label}
            tooltipContent={
              <ToolTip
                label={aiAssistantOpen ? 'Close AI assistant' : aiAssistantDef.label}
                description={aiAssistantDef.description}
                shortcut={aiAssistantDef.shortcut}
              />
            }
            onClick={onAiAssistantClick}
            active={aiAssistantOpen}
            className={aiAssistantDef.iconColor}
          />
        </>
      )}
    </div>
  )
}
