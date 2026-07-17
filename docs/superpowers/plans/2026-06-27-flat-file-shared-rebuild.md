# Flat-File Shared Editor Rebuild

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Amazon and eBay flat-file editors behind one shared component tree so any change to toolbar, shortcuts, column-group UX, or shared state is auto-applied to all channels — while also fixing icon confusion and replacing the inline column-group badge bar with a proper DS modal.

**Architecture:** Extract a `useFlatFileCore` hook for all shared state, build a canonical `FlatFileToolbar` component in `components/flat-file/` (replacing `_shared/FlatFileIconToolbar`), and introduce a `ColumnGroupModal` (DS `Modal` + `@dnd-kit/sortable`) to replace the confusing draggable-badge-bar row. The existing `FlatFileGrid` is already channel-agnostic; this plan keeps it intact and wires everything on top via controlled props.

**Tech Stack:** Next.js 14 App Router · React 18 hooks · lucide-react icons · @dnd-kit/sortable (already installed) · Design-system primitives (`Modal`, `Tooltip`, `Kbd`, `Button`, `Toggle`) · localStorage for persistence · TypeScript strict mode

## Global Constraints

- `/products/amazon-flat-file` and `/products/ebay-flat-file` routes/pages are modified ONLY within this plan's scope — no unrelated changes
- All new UI uses DS primitives from `apps/web/src/design-system/`; no hand-rolled buttons, modals, or tooltips
- No changes to any API routes or Prisma schema
- `FlatFileGrid.tsx` internals modified only where strictly necessary; all new props added as optional (non-breaking)
- Every task ends in a working, testable state — no half-finished states committed
- `storageKey` param drives all localStorage namespacing; never hardcode `ff-amazon-*` or `ff-ebay-*` inside shared components
- Icons: `lucide-react` only; no new icon libraries

---

## File Map

**Created:**
```
apps/web/src/components/flat-file/
  toolbar-icons.ts             # canonical icon + label + shortcut registry
  FlatFileToolbar.tsx          # redesigned toolbar (canonical; replaces _shared/FlatFileIconToolbar)
  ColumnGroupModal.tsx         # DS Modal + @dnd-kit reorder for group visibility
  useFlatFileCore.ts           # all shared state + actions hook

apps/web/src/app/products/_shared/
  flat-file-filter.types.ts    # GenericFFFilterState<T> + AmazonFilterDims + EbayFilterDims
  FFFilterPanelBase.tsx        # channel-agnostic filter panel shell
  AmazonFFFilterPanel.tsx      # Amazon-specific filter panel (wraps Base)
  EbayFFFilterPanel.tsx        # eBay-specific filter panel (wraps Base)
```

**Modified:**
```
apps/web/src/components/flat-file/
  FlatFileGrid.types.ts        # add ValidationIssue, SortLevel, ConditionalRule if missing;
                               # add optional closedGroups/groupOrder/onColumnsClick props
  FlatFileGrid.tsx             # remove badge-bar JSX; accept controlled closedGroups/groupOrder;
                               # wire ⌘G → onColumnsClick

apps/web/src/app/products/_shared/
  FlatFileIconToolbar.tsx      # becomes re-export shim → FlatFileToolbar
  FFFilterPanel.tsx            # becomes re-export shim → AmazonFFFilterPanel
  flat-file-shortcuts.ts       # add ⌘G entry for Columns modal

apps/web/src/app/products/amazon-flat-file/
  AmazonFlatFileClient.tsx     # rebuilt: shared state → useFlatFileCore,
                               # toolbar → FlatFileToolbar, group UI → ColumnGroupModal

apps/web/src/app/products/ebay-flat-file/
  EbayFlatFileClient.tsx       # rebuilt: same as above for eBay
```

---

## Task 1: Generic filter types + channel-specific filter panels

**Files:**
- Create: `apps/web/src/app/products/_shared/flat-file-filter.types.ts`
- Create: `apps/web/src/app/products/_shared/FFFilterPanelBase.tsx`
- Create: `apps/web/src/app/products/_shared/AmazonFFFilterPanel.tsx`
- Create: `apps/web/src/app/products/_shared/EbayFFFilterPanel.tsx`
- Modify: `apps/web/src/app/products/_shared/FFFilterPanel.tsx` (re-export shim)

**Interfaces:**
- Produces: `GenericFFFilterState<T>`, `AmazonFilterDims`, `EbayFilterDims`, `AmazonFFFilterState`, `EbayFFFilterState`, `FFFilterPanelBase`, `AmazonFFFilterPanel`, `EbayFFFilterPanel`

- [ ] **Step 1: Create flat-file-filter.types.ts**

```typescript
// apps/web/src/app/products/_shared/flat-file-filter.types.ts
export interface GenericFFFilterState<T = Record<string, never>> {
  missingRequired: boolean
  channel: T
}

export interface AmazonFilterDims {
  parentage: 'any' | 'parent' | 'child'
  hasAsin: 'any' | 'yes' | 'no'
}

export interface EbayFilterDims {
  hasItemId: 'any' | 'yes' | 'no'
  isParent: 'any' | 'parent' | 'child'
}

export type AmazonFFFilterState = GenericFFFilterState<AmazonFilterDims>
export type EbayFFFilterState = GenericFFFilterState<EbayFilterDims>

export const AMAZON_FILTER_DEFAULT: AmazonFFFilterState = {
  missingRequired: false,
  channel: { parentage: 'any', hasAsin: 'any' },
}

export const EBAY_FILTER_DEFAULT: EbayFFFilterState = {
  missingRequired: false,
  channel: { hasItemId: 'any', isParent: 'any' },
}
```

- [ ] **Step 2: Create FFFilterPanelBase.tsx**

```tsx
// apps/web/src/app/products/_shared/FFFilterPanelBase.tsx
import { type ReactNode } from 'react'
import { Button } from '@/design-system/primitives/Button'

export interface FFFilterPanelBaseProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  missingRequired: boolean
  onMissingRequiredChange: (v: boolean) => void
  children: ReactNode
  onReset: () => void
  activeCount: number
}

export function FFFilterPanelBase({
  open,
  onOpenChange,
  missingRequired,
  onMissingRequiredChange,
  children,
  onReset,
  activeCount,
}: FFFilterPanelBaseProps) {
  if (!open) return null
  return (
    <div
      role="dialog"
      aria-label="Filter rows"
      className="absolute left-3 top-10 z-30 w-72 rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Filters{activeCount > 0 && <span className="ml-1 text-blue-500">({activeCount})</span>}
        </span>
        <Button variant="ghost" size="sm" onClick={onReset}>Reset</Button>
      </div>
      <div className="space-y-4 px-4 py-3">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={missingRequired}
            onChange={(e) => onMissingRequiredChange(e.target.checked)}
            className="rounded"
          />
          <span className="text-sm text-slate-700 dark:text-slate-300">Missing required fields</span>
        </label>
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create AmazonFFFilterPanel.tsx**

```tsx
// apps/web/src/app/products/_shared/AmazonFFFilterPanel.tsx
import { FFFilterPanelBase } from './FFFilterPanelBase'
import { type AmazonFFFilterState, AMAZON_FILTER_DEFAULT } from './flat-file-filter.types'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  value: AmazonFFFilterState
  onChange: (next: AmazonFFFilterState) => void
}

export function AmazonFFFilterPanel({ open, onOpenChange, value, onChange }: Props) {
  const activeCount =
    (value.missingRequired ? 1 : 0) +
    (value.channel.parentage !== 'any' ? 1 : 0) +
    (value.channel.hasAsin !== 'any' ? 1 : 0)

  return (
    <FFFilterPanelBase
      open={open}
      onOpenChange={onOpenChange}
      missingRequired={value.missingRequired}
      onMissingRequiredChange={(v) => onChange({ ...value, missingRequired: v })}
      onReset={() => onChange(AMAZON_FILTER_DEFAULT)}
      activeCount={activeCount}
    >
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">Row type</p>
        {(['any', 'parent', 'child'] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="parentage"
              value={v}
              checked={value.channel.parentage === v}
              onChange={() => onChange({ ...value, channel: { ...value.channel, parentage: v } })}
            />
            <span className="text-sm capitalize text-slate-700 dark:text-slate-300">
              {v === 'any' ? 'Any' : v}
            </span>
          </label>
        ))}
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">Amazon ASIN</p>
        {(['any', 'yes', 'no'] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="hasAsin"
              value={v}
              checked={value.channel.hasAsin === v}
              onChange={() => onChange({ ...value, channel: { ...value.channel, hasAsin: v } })}
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              {v === 'any' ? 'Any' : v === 'yes' ? 'Has ASIN' : 'No ASIN'}
            </span>
          </label>
        ))}
      </div>
    </FFFilterPanelBase>
  )
}
```

- [ ] **Step 4: Create EbayFFFilterPanel.tsx**

```tsx
// apps/web/src/app/products/_shared/EbayFFFilterPanel.tsx
import { FFFilterPanelBase } from './FFFilterPanelBase'
import { type EbayFFFilterState, EBAY_FILTER_DEFAULT } from './flat-file-filter.types'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  value: EbayFFFilterState
  onChange: (next: EbayFFFilterState) => void
}

export function EbayFFFilterPanel({ open, onOpenChange, value, onChange }: Props) {
  const activeCount =
    (value.missingRequired ? 1 : 0) +
    (value.channel.hasItemId !== 'any' ? 1 : 0) +
    (value.channel.isParent !== 'any' ? 1 : 0)

  return (
    <FFFilterPanelBase
      open={open}
      onOpenChange={onOpenChange}
      missingRequired={value.missingRequired}
      onMissingRequiredChange={(v) => onChange({ ...value, missingRequired: v })}
      onReset={() => onChange(EBAY_FILTER_DEFAULT)}
      activeCount={activeCount}
    >
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">Row type</p>
        {(['any', 'parent', 'child'] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="isParent"
              value={v}
              checked={value.channel.isParent === v}
              onChange={() => onChange({ ...value, channel: { ...value.channel, isParent: v } })}
            />
            <span className="text-sm capitalize text-slate-700 dark:text-slate-300">
              {v === 'any' ? 'Any' : v}
            </span>
          </label>
        ))}
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">eBay Item ID</p>
        {(['any', 'yes', 'no'] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="hasItemId"
              value={v}
              checked={value.channel.hasItemId === v}
              onChange={() => onChange({ ...value, channel: { ...value.channel, hasItemId: v } })}
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              {v === 'any' ? 'Any' : v === 'yes' ? 'Has Item ID' : 'No Item ID'}
            </span>
          </label>
        ))}
      </div>
    </FFFilterPanelBase>
  )
}
```

- [ ] **Step 5: Convert FFFilterPanel.tsx to a re-export shim**

Read `apps/web/src/app/products/_shared/FFFilterPanel.tsx`, then replace the entire file content with:

```typescript
// Re-export shim — canonical implementation is AmazonFFFilterPanel.
// Kept so existing imports in AmazonFlatFileClient don't break during transition.
export { AmazonFFFilterPanel as FFFilterPanel } from './AmazonFFFilterPanel'
export type { AmazonFFFilterState as FFFilterState } from './flat-file-filter.types'
```

- [ ] **Step 6: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -40
```
Expected: 0 new errors (existing errors, if any, were pre-existing)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/products/_shared/flat-file-filter.types.ts \
        apps/web/src/app/products/_shared/FFFilterPanelBase.tsx \
        apps/web/src/app/products/_shared/AmazonFFFilterPanel.tsx \
        apps/web/src/app/products/_shared/EbayFFFilterPanel.tsx \
        apps/web/src/app/products/_shared/FFFilterPanel.tsx
git commit -m "refactor(flat-file): generic FFFilterPanel with typed Amazon+eBay channel variants"
```

---

## Task 2: `toolbar-icons.ts` — canonical icon + label + shortcut registry

**Files:**
- Create: `apps/web/src/components/flat-file/toolbar-icons.ts`
- Modify: `apps/web/src/app/products/_shared/flat-file-shortcuts.ts` (add ⌘G)

**Purpose:** Single source of truth for every toolbar tool. When tool order, icons, or labels change, edit this one file; all consumers auto-update.

**Interfaces:**
- Produces: `ToolbarToolId` union type, `ToolbarToolDef` interface, `TOOLBAR_TOOLS` constant, `getToolDef(id)` helper

- [ ] **Step 1: Create toolbar-icons.ts**

```typescript
// apps/web/src/components/flat-file/toolbar-icons.ts
import {
  Undo2, Redo2, Copy, ArrowRightLeft, ShieldAlert,
  ClipboardList, ImageIcon, SlidersHorizontal, Replace,
  Paintbrush2, Wand2, BrainCircuit, Columns3,
  type LucideIcon,
} from 'lucide-react'

export type ToolbarToolId =
  | 'undo' | 'redo'
  | 'copy' | 'replicate'
  | 'validation' | 'smart-paste'
  | 'row-images'
  | 'sort'
  | 'find-replace'
  | 'conditional-format'
  | 'ai-bulk'
  | 'ai-assistant'
  | 'columns'

export interface ToolbarToolDef {
  id: ToolbarToolId
  icon: LucideIcon
  label: string
  shortcut?: string
  description: string
  group: 'history' | 'clipboard' | 'view' | 'sort' | 'search' | 'ai' | 'columns'
  iconColor?: string
}

export const TOOLBAR_TOOLS: ToolbarToolDef[] = [
  // History
  { id: 'undo',               icon: Undo2,              label: 'Undo',             shortcut: '⌘Z',   description: 'Undo the last change',                          group: 'history' },
  { id: 'redo',               icon: Redo2,              label: 'Redo',             shortcut: '⌘⇧Z',  description: 'Re-apply the last undone change',               group: 'history' },
  // Clipboard
  { id: 'copy',               icon: Copy,               label: 'Copy to market',                     description: 'Copy selected rows to another marketplace',      group: 'clipboard' },
  { id: 'replicate',          icon: ArrowRightLeft,     label: 'Replicate',                          description: 'Copy selected columns to multiple markets',      group: 'clipboard' },
  // View
  { id: 'validation',         icon: ShieldAlert,        label: 'Validation',                         description: 'Show field errors and warnings',                 group: 'view' },
  { id: 'smart-paste',        icon: ClipboardList,      label: 'Smart paste',                        description: 'Map paste by column header instead of position', group: 'view' },
  { id: 'row-images',         icon: ImageIcon,          label: 'Row images',                         description: 'Show product thumbnail in each row',             group: 'view' },
  // Sort
  { id: 'sort',               icon: SlidersHorizontal,  label: 'Sort',                               description: 'Sort rows by one or more columns',               group: 'sort' },
  // Search & format
  { id: 'find-replace',       icon: Replace,            label: 'Find & replace',   shortcut: '⌘F',   description: 'Search and replace values across all cells',    group: 'search' },
  { id: 'conditional-format', icon: Paintbrush2,        label: 'Highlight rules',                    description: 'Color cells by value conditions',                group: 'search' },
  // AI
  { id: 'ai-bulk',            icon: Wand2,              label: 'AI bulk edit',                       description: 'Apply AI instructions to selected rows',         group: 'ai', iconColor: 'text-amber-500' },
  { id: 'ai-assistant',       icon: BrainCircuit,       label: 'AI assistant',                       description: 'Open AI content assistant panel',                group: 'ai', iconColor: 'text-violet-500' },
  // Columns
  { id: 'columns',            icon: Columns3,           label: 'Columns',          shortcut: '⌘G',   description: 'Show, hide and reorder column groups',           group: 'columns' },
]

export function getToolDef(id: ToolbarToolId): ToolbarToolDef {
  const def = TOOLBAR_TOOLS.find((t) => t.id === id)
  if (!def) throw new Error(`Unknown toolbar tool: ${id}`)
  return def
}
```

- [ ] **Step 2: Add ⌘G to flat-file-shortcuts.ts**

Read `apps/web/src/app/products/_shared/flat-file-shortcuts.ts`. Find the "Toolbar" shortcut group array. Add an entry:
```typescript
{ key: '⌘G', action: 'Open / close Columns modal' },
```
after the existing `'?'` entry.

- [ ] **Step 3: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```
Expected: 0 errors for the new files

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/flat-file/toolbar-icons.ts \
        apps/web/src/app/products/_shared/flat-file-shortcuts.ts
git commit -m "feat(flat-file): canonical toolbar icon+label+shortcut registry; add ⌘G shortcut"
```

---

## Task 3: `ColumnGroupModal` — DS Modal + @dnd-kit group manager

**Files:**
- Create: `apps/web/src/components/flat-file/ColumnGroupModal.tsx`

**Interfaces:**
- Consumes: `FlatFileColumnGroup` from `FlatFileGrid.types.ts`, DS `Modal`, `Button`, `Toggle`, `@dnd-kit/*`
- Produces: `ColumnGroupModal`, `ColumnGroupModalProps`

- [ ] **Step 1: Verify @dnd-kit is installed**

```bash
ls /Users/awais/nexus-commerce/apps/web/node_modules/@dnd-kit 2>&1
```
Expected: `core  sortable  utilities` directories listed

- [ ] **Step 2: Create ColumnGroupModal.tsx**

```tsx
// apps/web/src/components/flat-file/ColumnGroupModal.tsx
'use client'
import { useState } from 'react'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, RotateCcw } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Toggle } from '@/design-system/primitives/Toggle'
import { type FlatFileColumnGroup } from './FlatFileGrid.types'

const GROUP_DOT: Record<string, string> = {
  slate: 'bg-slate-400', blue: 'bg-blue-400', purple: 'bg-purple-400',
  emerald: 'bg-emerald-400', orange: 'bg-orange-400', teal: 'bg-teal-400',
  cyan: 'bg-cyan-400', sky: 'bg-sky-400', amber: 'bg-amber-400',
  violet: 'bg-violet-400', red: 'bg-red-400',
}

interface SortableRowProps {
  group: FlatFileColumnGroup
  visible: boolean
  onToggle: (id: string) => void
  canHide: boolean
}

function SortableRow({ group, visible, onToggle, canHide }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: group.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
    >
      <button
        {...attributes}
        {...listeners}
        tabIndex={-1}
        aria-label={`Drag to reorder ${group.label}`}
        className="flex-shrink-0 cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing dark:text-slate-600 dark:hover:text-slate-400"
      >
        <GripVertical size={16} />
      </button>
      <span
        className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${GROUP_DOT[group.color] ?? 'bg-slate-400'}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <span className={`text-sm font-medium ${visible ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500'}`}>
          {group.label}
        </span>
        <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">
          {group.columns.length} {group.columns.length === 1 ? 'column' : 'columns'}
        </span>
      </div>
      <Toggle
        checked={visible}
        onChange={() => { if (!visible || canHide) onToggle(group.id) }}
        disabled={visible && !canHide}
        aria-label={`${visible ? 'Hide' : 'Show'} ${group.label}`}
      />
    </div>
  )
}

export interface ColumnGroupModalProps {
  open: boolean
  onClose: () => void
  groups: FlatFileColumnGroup[]
  closedGroups: Set<string>
  groupOrder: string[]
  onApply: (closedGroups: Set<string>, groupOrder: string[]) => void
}

export function ColumnGroupModal({ open, onClose, groups, closedGroups, groupOrder, onApply }: ColumnGroupModalProps) {
  const [localOrder, setLocalOrder] = useState<string[]>(() =>
    groupOrder.length ? groupOrder : groups.map((g) => g.id),
  )
  const [localClosed, setLocalClosed] = useState<Set<string>>(() => new Set(closedGroups))

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const orderedGroups = [
    ...localOrder.map((id) => groups.find((g) => g.id === id)).filter(Boolean) as FlatFileColumnGroup[],
    ...groups.filter((g) => !localOrder.includes(g.id)),
  ]

  const visibleCount = groups.length - localClosed.size
  const canHide = visibleCount > 1

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const oldIdx = orderedGroups.findIndex((g) => g.id === active.id)
    const newIdx = orderedGroups.findIndex((g) => g.id === over.id)
    setLocalOrder(arrayMove(orderedGroups.map((g) => g.id), oldIdx, newIdx))
  }

  function handleToggle(id: string) {
    setLocalClosed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleReset() {
    setLocalOrder(groups.map((g) => g.id))
    setLocalClosed(new Set())
  }

  function handleApply() {
    onApply(localClosed, localOrder)
    onClose()
  }

  // Sync local state when modal opens with fresh external state
  function handleOpen() {
    setLocalOrder(groupOrder.length ? groupOrder : groups.map((g) => g.id))
    setLocalClosed(new Set(closedGroups))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Column groups"
      subtitle="Show, hide, and reorder groups. Drag the handle to reorder."
      size="md"
      footer={
        <div className="flex w-full items-center justify-between">
          <Button variant="ghost" size="sm" onClick={handleReset} className="gap-1.5">
            <RotateCcw size={14} />
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleApply}>Apply</Button>
          </div>
        </div>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={orderedGroups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-0.5">
            {orderedGroups.map((group) => (
              <SortableRow
                key={group.id}
                group={group}
                visible={!localClosed.has(group.id)}
                onToggle={handleToggle}
                canHide={canHide}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {!canHide && (
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          At least one group must remain visible.
        </p>
      )}
    </Modal>
  )
}
```

- [ ] **Step 3: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep -i "ColumnGroupModal\|dnd-kit" | head -20
```
Expected: no output (no errors)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/flat-file/ColumnGroupModal.tsx
git commit -m "feat(flat-file): ColumnGroupModal — DS Modal + @dnd-kit sortable group visibility"
```

---

## Task 4: `FlatFileToolbar` redesign with rich tooltips + fixed icons

Fixes the icon confusion:
- `Sparkles` (white) for Conditional Format → `Paintbrush2` ("Highlight rules")
- `Sparkles` (amber) for AI Bulk → `Wand2` ("AI bulk edit")
- `AlertTriangle` for Validation → `ShieldAlert` ("Validation")
- `ClipboardPaste` for Smart Paste → `ClipboardList` ("Smart paste")
- Every button gets a DS `Tooltip` with label + description + `Kbd` shortcut chip
- New "Columns" button (⌘G) replaces the badge-bar concept

**Files:**
- Create: `apps/web/src/components/flat-file/FlatFileToolbar.tsx`
- Modify: `apps/web/src/app/products/_shared/FlatFileIconToolbar.tsx` (re-export shim)

**Interfaces:**
- Produces: `FlatFileToolbarProps`, `FlatFileToolbar`, `TbBtn` (exported for channel-specific slot buttons)

- [ ] **Step 1: Verify DS Tooltip + Kbd import paths**

```bash
grep -r "export.*Tooltip\|export.*Kbd" /Users/awais/nexus-commerce/apps/web/src/design-system/ --include="*.tsx" --include="*.ts" | head -10
```
Note the exact import paths for use in Step 2.

- [ ] **Step 2: Create FlatFileToolbar.tsx**

```tsx
// apps/web/src/components/flat-file/FlatFileToolbar.tsx
'use client'
import { type ReactNode } from 'react'
import {
  Undo2, Redo2, Copy, ArrowRightLeft, ShieldAlert,
  ClipboardList, ImageIcon, SlidersHorizontal, Replace,
  Paintbrush2, Wand2, BrainCircuit, Columns3,
} from 'lucide-react'
import { Tooltip } from '@/design-system/primitives/Tooltip'
import { Kbd } from '@/design-system/primitives/Kbd'
import { cn } from '@/lib/utils'
import { getToolDef } from './toolbar-icons'

// ── TbBtn ──────────────────────────────────────────────────────────────────

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

export function TbBtn({ icon, title, tooltipContent, onClick, disabled, active, badge, className }: TbBtnProps) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'relative flex h-7 w-7 items-center justify-center rounded',
        'text-slate-600 dark:text-slate-400',
        'hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100',
        active && 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100',
        disabled && 'pointer-events-none opacity-40',
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

function ToolTip({ label, description, shortcut }: { label: string; description: string; shortcut?: string }) {
  return (
    <div className="flex max-w-[200px] flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">{label}</span>
        {shortcut && <Kbd className="text-[9px]">{shortcut}</Kbd>}
      </div>
      <span className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">{description}</span>
    </div>
  )
}

// ── Divider ────────────────────────────────────────────────────────────────

function TbDivider() {
  return <div aria-hidden className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
}

// ── FlatFileToolbarProps ───────────────────────────────────────────────────

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
  rowImageSize: 24 | 32 | 48 | 64 | 96
  onRowImagesToggle: () => void
  onRowImageSizeChange: (size: 24 | 32 | 48 | 64 | 96) => void
  rowImagesDisabled?: boolean
  // Sort
  sortLevelCount: number
  sortPanelOpen: boolean
  onSortClick: () => void
  sortDisabled?: boolean
  sortPanel?: ReactNode
  // Find & Replace
  findReplaceOpen: boolean
  onFindReplaceClick: () => void
  findReplaceDisabled?: boolean
  // Conditional format
  conditionalEnabledCount: number
  conditionalOpen: boolean
  onConditionalClick: () => void
  conditionalDisabled?: boolean
  // AI Bulk
  aiBulkSelectedCount: number
  onAiBulkClick: () => void
  aiBulkDisabled?: boolean
  // AI Assistant
  aiAssistantOpen?: boolean
  onAiAssistantClick?: () => void
  // Columns modal (NEW)
  onColumnsClick: () => void
  columnsActive?: boolean
  // Channel-specific slots
  slotAfterReplicate?: ReactNode
  slotAfterSmartPaste?: ReactNode
  trailing?: ReactNode
}

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
  const IMAGE_SIZES = [24, 32, 48, 64, 96] as const
  const IMAGE_LABELS = ['XS', 'S', 'M', 'L', 'XL']

  return (
    <div className="flex h-8 items-center gap-0.5 border-b border-slate-100 bg-white px-3 dark:border-slate-800/60 dark:bg-slate-950">

      {/* History */}
      <TbBtn icon={<Undo2 size={14} />} title="Undo" tooltipContent={<ToolTip {...getToolDef('undo')} />} onClick={onUndo} disabled={!canUndo} />
      <TbBtn icon={<Redo2 size={14} />} title="Redo" tooltipContent={<ToolTip {...getToolDef('redo')} />} onClick={onRedo} disabled={!canRedo} />

      <TbDivider />

      {/* Clipboard */}
      <TbBtn
        icon={<Copy size={14} />}
        title={copyTitle ?? 'Copy to market'}
        tooltipContent={<ToolTip {...getToolDef('copy')} label={copyTitle ?? getToolDef('copy').label} />}
        onClick={onCopy}
        active={copyActive}
        disabled={copyDisabled}
      />
      {onReplicate && (
        <TbBtn
          icon={<ArrowRightLeft size={14} />}
          title="Replicate"
          tooltipContent={<ToolTip {...getToolDef('replicate')} />}
          onClick={onReplicate}
          active={replicateActive}
          disabled={replicateDisabled}
        />
      )}
      {slotAfterReplicate}

      <TbDivider />

      {/* Validation + Smart Paste */}
      <TbBtn
        icon={<ShieldAlert size={14} />}
        title="Validation"
        tooltipContent={
          <ToolTip
            {...getToolDef('validation')}
            label={validationBadge > 0
              ? `Validation — ${validationErrorCount} error(s), ${validationWarnCount} warning(s)`
              : 'Validation — no issues'}
          />
        }
        onClick={onValidationClick}
        disabled={validationDisabled}
        active={validationActive}
        badge={validationBadge || undefined}
        className={validationErrorCount > 0 ? 'text-red-500 dark:text-red-400' : validationWarnCount > 0 ? 'text-amber-500 dark:text-amber-400' : undefined}
      />
      <TbBtn
        icon={<ClipboardList size={14} />}
        title="Smart paste"
        tooltipContent={<ToolTip {...getToolDef('smart-paste')} label={smartPasteEnabled ? 'Smart paste ON' : 'Smart paste OFF'} />}
        onClick={onSmartPasteToggle}
        active={smartPasteEnabled}
      />
      {slotAfterSmartPaste}

      <TbDivider />

      {/* Row images */}
      <TbBtn
        icon={<ImageIcon size={14} />}
        title="Row images"
        tooltipContent={<ToolTip {...getToolDef('row-images')} />}
        onClick={onRowImagesToggle}
        active={showRowImages}
        disabled={rowImagesDisabled}
      />
      {showRowImages && IMAGE_SIZES.map((sz, i) => (
        <button
          key={sz}
          type="button"
          onClick={() => onRowImageSizeChange(sz)}
          className={cn(
            'h-6 rounded px-1.5 text-[10px] font-medium',
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
          icon={<SlidersHorizontal size={14} />}
          title="Sort"
          tooltipContent={<ToolTip {...getToolDef('sort')} label={sortLevelCount > 0 ? `Sort — ${sortLevelCount} level(s) active` : 'Sort'} />}
          onClick={onSortClick}
          active={sortPanelOpen || sortLevelCount > 0}
          disabled={sortDisabled}
          badge={sortLevelCount || undefined}
        />
        {sortPanel}
      </div>

      <TbDivider />

      {/* Find/Replace + Highlight + AI Bulk */}
      <TbBtn
        icon={<Replace size={14} />}
        title="Find & replace"
        tooltipContent={<ToolTip {...getToolDef('find-replace')} />}
        onClick={onFindReplaceClick}
        active={findReplaceOpen}
        disabled={findReplaceDisabled}
      />
      <TbBtn
        icon={<Paintbrush2 size={14} />}
        title="Highlight rules"
        tooltipContent={<ToolTip {...getToolDef('conditional-format')} label={conditionalEnabledCount > 0 ? `Highlight rules (${conditionalEnabledCount} active)` : 'Highlight rules'} />}
        onClick={onConditionalClick}
        active={conditionalOpen}
        disabled={conditionalDisabled}
        badge={conditionalEnabledCount || undefined}
      />
      <TbBtn
        icon={<Wand2 size={14} />}
        title="AI bulk edit"
        tooltipContent={<ToolTip {...getToolDef('ai-bulk')} label={aiBulkSelectedCount > 0 ? `AI bulk edit (${aiBulkSelectedCount} rows)` : 'AI bulk edit'} />}
        onClick={onAiBulkClick}
        disabled={aiBulkDisabled || aiBulkSelectedCount === 0}
        badge={aiBulkSelectedCount || undefined}
        className="text-amber-500"
      />

      {trailing}

      <TbDivider />

      {/* Columns */}
      <TbBtn
        icon={<Columns3 size={14} />}
        title="Columns"
        tooltipContent={<ToolTip {...getToolDef('columns')} />}
        onClick={onColumnsClick}
        active={columnsActive}
      />

      {/* AI Assistant */}
      {onAiAssistantClick && (
        <>
          <TbDivider />
          <TbBtn
            icon={<BrainCircuit size={14} />}
            title="AI assistant"
            tooltipContent={<ToolTip {...getToolDef('ai-assistant')} label={aiAssistantOpen ? 'Close AI assistant' : 'AI assistant'} />}
            onClick={onAiAssistantClick}
            active={aiAssistantOpen}
            className="text-violet-500"
          />
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Convert FlatFileIconToolbar.tsx to re-export shim**

Read `apps/web/src/app/products/_shared/FlatFileIconToolbar.tsx` (to confirm its current exports), then replace entirely with:

```typescript
// apps/web/src/app/products/_shared/FlatFileIconToolbar.tsx
// Canonical implementation moved to components/flat-file/FlatFileToolbar.tsx
// This shim preserves existing import paths during transition.
export {
  FlatFileToolbar as FlatFileIconToolbar,
  TbBtn,
  type FlatFileToolbarProps as FlatFileIconToolbarProps,
} from '@/components/flat-file/FlatFileToolbar'
```

- [ ] **Step 4: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -40
```
Expected: 0 new errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/flat-file/FlatFileToolbar.tsx \
        apps/web/src/app/products/_shared/FlatFileIconToolbar.tsx
git commit -m "feat(flat-file): redesigned FlatFileToolbar — fixed icons, DS tooltips+Kbd, Columns button"
```

---

## Task 5: `useFlatFileCore` — shared state hook

Extract all state that is duplicated between `AmazonFlatFileClient` and `EbayFlatFileClient` into a single reusable hook.

**Files:**
- Create: `apps/web/src/components/flat-file/useFlatFileCore.ts`
- Modify: `apps/web/src/components/flat-file/FlatFileGrid.types.ts` (add missing shared types if absent)

**Interfaces:**
- Produces: `UseFlatFileCoreOptions<TRow, TFilterDims>`, `UseFlatFileCoreReturn<TRow, TFilterDims>`

- [ ] **Step 1: Read FlatFileGrid.types.ts to identify existing types**

```bash
cat -n /Users/awais/nexus-commerce/apps/web/src/components/flat-file/FlatFileGrid.types.ts
```

- [ ] **Step 2: Add missing shared types to FlatFileGrid.types.ts**

If `ValidationIssue`, `SortLevel`, or `ConditionalRule` are not already exported from this file, add them:

```typescript
// Add to FlatFileGrid.types.ts if missing:
export interface ValidationIssue {
  rowId: string
  columnId: string
  message: string
  severity: 'error' | 'warning'
}

export interface SortLevel {
  id: string
  colId: string
  mode: 'asc' | 'desc' | 'custom'
  customOrder?: string[]
}

export interface ConditionalRule {
  id: string
  columnId: string
  op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq' | 'neq' | 'contains' | 'startsWith' | 'endsWith' | 'empty' | 'notEmpty'
  value: unknown
  tone: 'red' | 'amber' | 'green' | 'blue' | 'slate'
  enabled: boolean
}
```

- [ ] **Step 3: Create useFlatFileCore.ts**

```typescript
// apps/web/src/components/flat-file/useFlatFileCore.ts
'use client'
import { useState, useCallback, useRef, useMemo } from 'react'
import type { BaseRow, FlatFileColumnGroup, SortLevel, ConditionalRule, ValidationIssue } from './FlatFileGrid.types'
import type { GenericFFFilterState } from '@/app/products/_shared/flat-file-filter.types'

const MAX_HISTORY = 50

export interface UseFlatFileCoreOptions<TRow extends BaseRow, TFilterDims> {
  storageKey: string
  initialRows: TRow[]
  makeBlankRow: () => TRow
  minGhostRows?: number
  initialFilter: GenericFFFilterState<TFilterDims>
  validate?: (rows: TRow[]) => ValidationIssue[]
}

export function useFlatFileCore<TRow extends BaseRow, TFilterDims>({
  storageKey,
  initialRows,
  makeBlankRow,
  minGhostRows = 8,
  initialFilter,
  validate,
}: UseFlatFileCoreOptions<TRow, TFilterDims>) {

  // ── Rows ──────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<TRow[]>(() => {
    const ghosts = Array.from({ length: minGhostRows }, () =>
      ({ ...makeBlankRow(), _ghost: true, _dirty: false, _isNew: false }),
    )
    return [...initialRows, ...ghosts]
  })

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  const historyRef = useRef<TRow[][]>([])
  const futureRef = useRef<TRow[][]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const pushSnapshot = useCallback((snap: TRow[]) => {
    historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY - 1)), snap]
    futureRef.current = []
    setCanUndo(true)
    setCanRedo(false)
  }, [])

  const updateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    setRows((prev) => {
      pushSnapshot(prev)
      return prev.map((r) =>
        r._rowId === rowId ? { ...r, [colId]: value, _dirty: true, _ghost: false } : r,
      )
    })
  }, [pushSnapshot])

  const handleUndo = useCallback(() => {
    const snap = historyRef.current.pop()
    if (!snap) return
    setRows((cur) => { futureRef.current.push(cur); return snap })
    setCanUndo(historyRef.current.length > 0)
    setCanRedo(true)
  }, [])

  const handleRedo = useCallback(() => {
    const snap = futureRef.current.pop()
    if (!snap) return
    setRows((cur) => { historyRef.current.push(cur); return snap })
    setCanUndo(true)
    setCanRedo(futureRef.current.length > 0)
  }, [])

  // ── Sort ──────────────────────────────────────────────────────────────────
  const [sortConfig, setSortConfig] = useState<SortLevel[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-sort`) ?? '[]') } catch { return [] }
  })
  const persistSort = useCallback((next: SortLevel[]) => {
    setSortConfig(next)
    try { localStorage.setItem(`${storageKey}-sort`, JSON.stringify(next)) } catch { /* ignore */ }
  }, [storageKey])

  // ── Conditional formatting ─────────────────────────────────────────────────
  const [cfRules, setCfRules] = useState<ConditionalRule[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-cf-rules`) ?? '[]') } catch { return [] }
  })
  const persistCfRules = useCallback((next: ConditionalRule[]) => {
    setCfRules(next)
    try { localStorage.setItem(`${storageKey}-cf-rules`, JSON.stringify(next)) } catch { /* ignore */ }
  }, [storageKey])

  // ── Filter ────────────────────────────────────────────────────────────────
  const [ffFilter, setFfFilter] = useState<GenericFFFilterState<TFilterDims>>(initialFilter)

  // ── Smart paste ───────────────────────────────────────────────────────────
  const [smartPasteEnabled, setSmartPasteEnabled] = useState(() => {
    try { return localStorage.getItem(`${storageKey}-smart-paste`) === '1' } catch { return false }
  })
  const toggleSmartPaste = useCallback(() => {
    setSmartPasteEnabled((v) => {
      const next = !v
      try { localStorage.setItem(`${storageKey}-smart-paste`, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [storageKey])

  // ── Row images ────────────────────────────────────────────────────────────
  const [showRowImages, setShowRowImages] = useState(() => {
    try { return localStorage.getItem(`${storageKey}-show-images`) === '1' } catch { return false }
  })
  const [rowImageSize, setRowImageSize] = useState<24 | 32 | 48 | 64 | 96>(() => {
    try { return (parseInt(localStorage.getItem(`${storageKey}-image-size`) ?? '48') || 48) as 24 | 32 | 48 | 64 | 96 } catch { return 48 }
  })
  const toggleRowImages = useCallback(() => {
    setShowRowImages((v) => {
      const next = !v
      try { localStorage.setItem(`${storageKey}-show-images`, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [storageKey])
  const changeImageSize = useCallback((sz: 24 | 32 | 48 | 64 | 96) => {
    setRowImageSize(sz)
    try { localStorage.setItem(`${storageKey}-image-size`, String(sz)) } catch { /* ignore */ }
  }, [storageKey])

  // ── Column group settings ─────────────────────────────────────────────────
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`${storageKey}-closed-groups`) ?? '[]') as string[]) } catch { return new Set() }
  })
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-group-order`) ?? '[]') } catch { return [] }
  })
  const applyGroupSettings = useCallback((nextClosed: Set<string>, nextOrder: string[]) => {
    setClosedGroups(nextClosed)
    setGroupOrder(nextOrder)
    try {
      localStorage.setItem(`${storageKey}-closed-groups`, JSON.stringify([...nextClosed]))
      localStorage.setItem(`${storageKey}-group-order`, JSON.stringify(nextOrder))
    } catch { /* ignore */ }
  }, [storageKey])
  const [columnGroupModalOpen, setColumnGroupModalOpen] = useState(false)

  // ── Panel open states ─────────────────────────────────────────────────────
  const [sortPanelOpen, setSortPanelOpen] = useState(false)
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const [conditionalOpen, setConditionalOpen] = useState(false)
  const [validationOpen, setValidationOpen] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiModalOpen, setAiModalOpen] = useState(false)

  // ── Selection ─────────────────────────────────────────────────────────────
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())

  // ── Validation ────────────────────────────────────────────────────────────
  const realRows = useMemo(() => rows.filter((r) => !r._ghost), [rows])
  const validationIssues = useMemo(
    () => (validate ? validate(realRows as TRow[]) : []),
    [validate, realRows],
  )
  const validationErrorCount = useMemo(() => validationIssues.filter((i) => i.severity === 'error').length, [validationIssues])
  const validationWarnCount = useMemo(() => validationIssues.filter((i) => i.severity === 'warning').length, [validationIssues])

  // ── Dirty state ───────────────────────────────────────────────────────────
  const dirtyRows = useMemo(() => realRows.filter((r) => r._dirty || r._isNew), [realRows])
  const hasDirty = dirtyRows.length > 0

  return {
    rows, setRows, updateCell, realRows, dirtyRows, hasDirty, pushSnapshot,
    canUndo, canRedo, handleUndo, handleRedo,
    sortConfig, persistSort,
    cfRules, persistCfRules,
    ffFilter, setFfFilter,
    smartPasteEnabled, toggleSmartPaste,
    showRowImages, rowImageSize, toggleRowImages, changeImageSize,
    closedGroups, groupOrder, applyGroupSettings,
    columnGroupModalOpen, setColumnGroupModalOpen,
    sortPanelOpen, setSortPanelOpen,
    findReplaceOpen, setFindReplaceOpen,
    conditionalOpen, setConditionalOpen,
    validationOpen, setValidationOpen,
    aiPanelOpen, setAiPanelOpen,
    aiModalOpen, setAiModalOpen,
    selectedRows, setSelectedRows,
    validationIssues, validationErrorCount, validationWarnCount,
  }
}
```

- [ ] **Step 4: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -30
```
Expected: 0 new errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/flat-file/useFlatFileCore.ts \
        apps/web/src/components/flat-file/FlatFileGrid.types.ts
git commit -m "feat(flat-file): useFlatFileCore shared state hook; add ValidationIssue/SortLevel/ConditionalRule types"
```

---

## Task 6: Rebuild `AmazonFlatFileClient.tsx` with shared infrastructure

Reduces ~7917 lines to target ~4000 by replacing duplicated shared state and toolbar rendering with the new shared components.

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx`

**Keep:** All Amazon-specific logic — pull flow, feed submission, replicate modal, cascade modal, override badges, AI assistant panel, market sync badges, variation family creation, push panel, multi-type manifest union.

**Remove (moved to shared):** Undo/redo history stack + refs, sort state + localStorage, CF rules state + localStorage, filter state, smart-paste state + localStorage, row-images state + localStorage, closed-groups + group-order state + localStorage, all panel-open booleans, selected-rows state, validation issue memoization.

- [ ] **Step 1: Read the first 200 lines of AmazonFlatFileClient.tsx to understand import block**

```bash
head -200 /Users/awais/nexus-commerce/apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx
```

- [ ] **Step 2: Add new imports after reading**

At the top of the imports block (after existing imports), add:
```typescript
import { useFlatFileCore } from '@/components/flat-file/useFlatFileCore'
import { FlatFileToolbar } from '@/components/flat-file/FlatFileToolbar'
import { ColumnGroupModal } from '@/components/flat-file/ColumnGroupModal'
import { AmazonFFFilterPanel } from '../_shared/AmazonFFFilterPanel'
import { AMAZON_FILTER_DEFAULT, type AmazonFFFilterState, type AmazonFilterDims } from '../_shared/flat-file-filter.types'
```

- [ ] **Step 3: Replace shared state with useFlatFileCore**

In the component body, find the block of `useState` / `useRef` calls for: `undoStack`, `redoStack`, `sortConfig`, `cfRules`, `ffFilter`, `smartPasteEnabled`, `showRowImages`, `imageSize`, `closedGroups`, `groupOrder`, `sortPanelOpen`, `findReplaceOpen`, `cfOpen`, `showValidPanel`, `aiPanelOpen`, `aiModalOpen`, `selectedRows`.

Replace ALL of those with:

```typescript
const core = useFlatFileCore<AmazonRow, AmazonFilterDims>({
  storageKey: `ff-amazon-${marketplace}-${effectiveProductType}`,
  initialRows,
  makeBlankRow: () => makeEmptyRow(marketplace),
  initialFilter: AMAZON_FILTER_DEFAULT,
  validate: (rows) => validateAmazonRows(rows, effectiveManifest),
})

const {
  rows, setRows, updateCell, realRows, dirtyRows, hasDirty, pushSnapshot,
  canUndo, canRedo, handleUndo, handleRedo,
  sortConfig, persistSort: setSortConfig,
  cfRules, persistCfRules: setCfRules,
  ffFilter, setFfFilter,
  smartPasteEnabled, toggleSmartPaste: handleSmartPasteToggle,
  showRowImages, rowImageSize, toggleRowImages: handleRowImagesToggle, changeImageSize: handleImageSizeChange,
  closedGroups, groupOrder, applyGroupSettings,
  columnGroupModalOpen, setColumnGroupModalOpen,
  sortPanelOpen, setSortPanelOpen,
  findReplaceOpen, setFindReplaceOpen,
  conditionalOpen: cfOpen, setConditionalOpen: setCfOpen,
  validationOpen: showValidPanel, setValidationOpen: setShowValidPanel,
  aiPanelOpen, setAiPanelOpen,
  aiModalOpen, setAiModalOpen,
  selectedRows, setSelectedRows,
  validationErrorCount, validationWarnCount,
} = core
```

Note: If the existing code has local function names that differ (e.g., `handleUndo` vs `undo`), use the destructuring aliases shown above to maintain the same local names and avoid changing call sites.

- [ ] **Step 4: Replace FlatFileIconToolbar JSX with FlatFileToolbar**

Find `<FlatFileIconToolbar` in the JSX return and change to `<FlatFileToolbar`. Add two new props:
```tsx
onColumnsClick={() => setColumnGroupModalOpen(true)}
columnsActive={columnGroupModalOpen}
```

- [ ] **Step 5: Add ColumnGroupModal to JSX return**

Inside the return statement, before the closing `</div>` of the root element, add:
```tsx
<ColumnGroupModal
  open={columnGroupModalOpen}
  onClose={() => setColumnGroupModalOpen(false)}
  groups={effectiveManifest?.groups.map((g) => ({
    id: g.id,
    label: g.labelEn,
    color: g.color,
    columns: g.columns,
  })) ?? []}
  closedGroups={closedGroups}
  groupOrder={groupOrder}
  onApply={applyGroupSettings}
/>
```

Note: `FlatFileColumnGroup` from `FlatFileGrid.types.ts` expects `label` (not `labelEn`/`labelLocal`). Map the Amazon manifest group shape to the canonical type at this call site.

- [ ] **Step 6: Replace FFFilterPanel with AmazonFFFilterPanel**

Find `<FFFilterPanel` usage and replace with `<AmazonFFFilterPanel`. The prop interface is the same; only the import changes (already added in Step 2).

- [ ] **Step 7: Remove the old badge bar JSX**

Search for the `<div>` that renders the draggable group badges row (contains `setDraggingGroupId`, group badge buttons with `draggable={true}`). Delete that entire `<div>` block. The `ColumnGroupModal` replaces it.

```bash
grep -n "setDraggingGroupId\|draggingGroupId\|group.*badge\|draggable.*true" \
  /Users/awais/nexus-commerce/apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx | head -20
```
Use the line numbers to locate and remove the badge bar block.

- [ ] **Step 8: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -50
```
Expected: 0 errors

- [ ] **Step 9: Measure line reduction**

```bash
wc -l /Users/awais/nexus-commerce/apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx
```

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx
git commit -m "refactor(amazon-flat-file): replace shared state+toolbar+group-bar with useFlatFileCore+FlatFileToolbar+ColumnGroupModal"
```

---

## Task 7: Rebuild `EbayFlatFileClient.tsx` with shared infrastructure

**Files:**
- Modify: `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx`

**Keep:** All eBay-specific logic — aspects panel, category search modal, description editor modal, variation value order modal, push history panel, channel strip (market tabs), per-market field handling, AddListingPopover.

**Remove (moved to shared):** Same list as Task 6.

- [ ] **Step 1: Read the first 150 lines of EbayFlatFileClient.tsx**

```bash
head -150 /Users/awais/nexus-commerce/apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx
```

- [ ] **Step 2: Add new imports**

```typescript
import { useFlatFileCore } from '@/components/flat-file/useFlatFileCore'
import { FlatFileToolbar } from '@/components/flat-file/FlatFileToolbar'
import { ColumnGroupModal } from '@/components/flat-file/ColumnGroupModal'
import { EbayFFFilterPanel } from '../_shared/EbayFFFilterPanel'
import { EBAY_FILTER_DEFAULT, type EbayFFFilterState, type EbayFilterDims } from '../_shared/flat-file-filter.types'
```

- [ ] **Step 3: Replace shared state with useFlatFileCore**

```typescript
const core = useFlatFileCore<EbayRow, EbayFilterDims>({
  storageKey: `ff-ebay-${marketplace}`,
  initialRows,
  makeBlankRow: () => makeBlankEbayRow(),
  initialFilter: EBAY_FILTER_DEFAULT,
  validate: (rows) => validateEbayRows(rows),
})

const {
  rows, setRows, updateCell, realRows, dirtyRows, hasDirty, pushSnapshot,
  canUndo, canRedo, handleUndo, handleRedo,
  sortConfig, persistSort: setSortConfig,
  cfRules, persistCfRules: setCfRules,
  ffFilter, setFfFilter,
  smartPasteEnabled, toggleSmartPaste: handleSmartPasteToggle,
  showRowImages, rowImageSize, toggleRowImages: handleRowImagesToggle, changeImageSize: handleImageSizeChange,
  closedGroups, groupOrder, applyGroupSettings,
  columnGroupModalOpen, setColumnGroupModalOpen,
  sortPanelOpen, setSortPanelOpen,
  findReplaceOpen, setFindReplaceOpen,
  conditionalOpen: cfOpen, setConditionalOpen: setCfOpen,
  validationOpen: showValidPanel, setValidationOpen: setShowValidPanel,
  aiModalOpen, setAiModalOpen,
  selectedRows, setSelectedRows,
  validationErrorCount, validationWarnCount,
} = core
```

Note: eBay does not use `aiPanelOpen` (no AI assistant panel on eBay). Omit that from the destructuring.

- [ ] **Step 4: Replace toolbar JSX + add ColumnGroupModal**

Find `<FlatFileIconToolbar` → replace with `<FlatFileToolbar ... onColumnsClick={() => setColumnGroupModalOpen(true)} columnsActive={columnGroupModalOpen} />`.

Add `<ColumnGroupModal open={columnGroupModalOpen} onClose={() => setColumnGroupModalOpen(false)} groups={columnGroups} closedGroups={closedGroups} groupOrder={groupOrder} onApply={applyGroupSettings} />` before the closing root div.

Note: `columnGroups` in `EbayFlatFileClient` is a `FlatFileColumnGroup[]` already (eBay uses the canonical type directly unlike Amazon's manifest shape), so no mapping is needed.

- [ ] **Step 5: Remove badge bar JSX**

```bash
grep -n "setDraggingGroupId\|draggingGroupId\|group.*badge\|draggable.*true" \
  /Users/awais/nexus-commerce/apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx | head -20
```
Delete the badge bar block found at those lines.

- [ ] **Step 6: Replace FFFilterPanel with EbayFFFilterPanel**

If eBay currently has a filter panel, replace it with `<EbayFFFilterPanel ...>`. If eBay doesn't have one, skip this step.

- [ ] **Step 7: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -50
```
Expected: 0 errors

- [ ] **Step 8: Measure line reduction**

```bash
wc -l /Users/awais/nexus-commerce/apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx
git commit -m "refactor(ebay-flat-file): replace shared state+toolbar+group-bar with useFlatFileCore+FlatFileToolbar+ColumnGroupModal"
```

---

## Task 8: Lift column group state into FlatFileGrid controlled props + wire ⌘G

The `FlatFileGrid` currently manages `closedGroups` and `groupOrder` as internal state. Now that both client files drive these via `useFlatFileCore`, the grid should accept them as controlled props so `ColumnGroupModal.onApply` flows directly into the grid's rendering.

Also wire `⌘G` keyboard shortcut inside the grid.

**Files:**
- Modify: `apps/web/src/components/flat-file/FlatFileGrid.types.ts`
- Modify: `apps/web/src/components/flat-file/FlatFileGrid.tsx`

- [ ] **Step 1: Add controlled props to FlatFileGridProps**

In `FlatFileGrid.types.ts`, add to the props interface:
```typescript
// Controlled column group state (from useFlatFileCore)
closedGroupsProp?: Set<string>
groupOrderProp?: string[]
onColumnsClick?: () => void     // ⌘G opens the ColumnGroupModal in the parent
```

- [ ] **Step 2: Use controlled props in FlatFileGrid.tsx with internal fallback**

In `FlatFileGrid.tsx`, find where `closedGroups` and `groupOrder` state are declared (currently internal `useState`). Change to:

```typescript
// If parent provides controlled values, use them; otherwise use internal state
const [internalClosedGroups, setInternalClosedGroups] = useState<Set<string>>(() => {
  try { return new Set(JSON.parse(localStorage.getItem(`${storageKey}-closed-groups`) ?? '[]') as string[]) } catch { return new Set() }
})
const [internalGroupOrder, setInternalGroupOrder] = useState<string[]>(() => {
  try { return JSON.parse(localStorage.getItem(`${storageKey}-group-order`) ?? '[]') } catch { return [] }
})
const closedGroups = props.closedGroupsProp ?? internalClosedGroups
const groupOrder = props.groupOrderProp ?? internalGroupOrder
```

Any places that call `setClosedGroups` or `setGroupOrder` inside the grid (from the old badge-bar drag handlers) now only update internal state (they'll only fire if the parent doesn't provide controlled props). This is the "uncontrolled fallback" path.

- [ ] **Step 3: Remove badge bar from FlatFileGrid.tsx**

Find lines containing the draggable group badge bar in FlatFileGrid.tsx:
```bash
grep -n "draggingGroupId\|setDraggingGroupId\|group-badge\|onDragStart.*group\|onDrop.*group" \
  /Users/awais/nexus-commerce/apps/web/src/components/flat-file/FlatFileGrid.tsx | head -20
```

Delete:
1. The `[draggingGroupId, setDraggingGroupId]` state declaration
2. The JSX block rendering the badge-bar row (the `<div>` with draggable group buttons)
3. The drag event handlers attached to those badges (onDragStart, onDragOver, onDrop on the badge buttons)

Keep: `closedGroups`, `groupOrder`, `orderedGroups`, `openGroups`, `visibleGroups`, `allColumns` — all still needed for the grid rendering and header coloring.

- [ ] **Step 4: Add ⌘G keyboard shortcut**

In `FlatFileGrid.tsx`, find the `handleKeyDown` function (the main keyboard event handler for the grid container). Find where `⌘F` is handled:
```bash
grep -n "KeyF\|key.*=.*'f'\|metaKey.*f\|findReplace" \
  /Users/awais/nexus-commerce/apps/web/src/components/flat-file/FlatFileGrid.tsx | head -10
```

In the same block, add immediately after the `⌘F` handler:
```typescript
if (e.key === 'g' && (e.metaKey || e.ctrlKey)) {
  e.preventDefault()
  props.onColumnsClick?.()
  return
}
```

- [ ] **Step 5: Pass controlled props from both clients**

In `AmazonFlatFileClient.tsx`, find `<FlatFileGrid` and add:
```tsx
closedGroupsProp={closedGroups}
groupOrderProp={groupOrder}
onColumnsClick={() => setColumnGroupModalOpen(true)}
```

In `EbayFlatFileClient.tsx`, find `<FlatFileGrid` (or the component that wraps it) and add the same three props.

- [ ] **Step 6: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -40
```
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/flat-file/FlatFileGrid.tsx \
        apps/web/src/components/flat-file/FlatFileGrid.types.ts \
        apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx \
        apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx
git commit -m "refactor(flat-file-grid): controlled closedGroups/groupOrder props; remove badge bar; wire ⌘G shortcut"
```

---

## Task 9: Update KeyboardShortcutsModal to include ⌘G + use DS primitives

**Files:**
- Modify: whichever file `KeyboardShortcutsModal` lives in (likely `apps/web/src/app/_shared/grid-lens/KeyboardShortcutsModal.tsx`)

- [ ] **Step 1: Find the file**

```bash
find /Users/awais/nexus-commerce/apps/web/src -name "KeyboardShortcutsModal*" 2>/dev/null
```

- [ ] **Step 2: Read the file**

Read it completely.

- [ ] **Step 3: Add ⌘G entry to the Toolbar section**

Find the toolbar shortcuts array and add:
```typescript
{ key: '⌘G', action: 'Open Columns modal — show, hide, reorder column groups' },
```

- [ ] **Step 4: Verify it uses DS Modal + Kbd**

Check that:
- The modal wrapper uses `Modal` from `@/design-system/components/Modal` (not a raw `dialog` or custom overlay)
- Keyboard key chips use `Kbd` from `@/design-system/primitives/Kbd`

If either is missing, replace the relevant part with DS equivalents (keep the layout the same).

- [ ] **Step 5: Run type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add [path to KeyboardShortcutsModal file]
git commit -m "feat(flat-file): KeyboardShortcutsModal — add ⌘G; verify DS Modal+Kbd"
```

---

## Task 10: Deploy + full parity verification

- [ ] **Step 1: Final type-check**

```bash
cd /Users/awais/nexus-commerce && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | tail -5
```
Expected: `Found 0 errors.`

- [ ] **Step 2: Push to Railway + Vercel**

```bash
git push origin main
```

- [ ] **Step 3: Verify Amazon flat file**

Open `/products/amazon-flat-file?marketplace=IT&productType=OUTERWEAR` on production.

Toolbar icon checks:
- [ ] Validation button: `ShieldAlert` icon (was `AlertTriangle`) — verify it changed
- [ ] Highlight rules button: `Paintbrush2` icon (was `Sparkles` white) — verify it changed
- [ ] AI bulk edit button: `Wand2` icon (was `Sparkles` amber) — verify it changed
- [ ] Smart paste button: `ClipboardList` icon (was `ClipboardPaste`) — verify it changed
- [ ] New "Columns" button appears (last button before AI assistant)

Tooltip checks (hover each button):
- [ ] Undo tooltip: "Undo" + description + `⌘Z` Kbd chip
- [ ] Find & replace tooltip: "Find & replace" + description + `⌘F` Kbd chip
- [ ] Columns tooltip: "Columns" + description + `⌘G` Kbd chip

Column modal checks:
- [ ] Click "Columns" button → `ColumnGroupModal` opens
- [ ] All column groups listed with color dot + column count
- [ ] Toggle a group OFF → Apply → group columns disappear from grid
- [ ] Drag group up/down → Apply → column order changes in grid
- [ ] Reset to default → Apply → all groups visible, original order
- [ ] Press ⌘G → modal opens; Esc or Cancel → modal closes
- [ ] Old badge bar is gone (no second row below toolbar)

- [ ] **Step 4: Verify eBay flat file**

Open `/products/ebay-flat-file?marketplace=IT` on production.

- [ ] Same toolbar icon changes verified
- [ ] "Columns" button opens ColumnGroupModal with eBay-specific groups (Identifiers, Listing, Content, Pricing, Inventory, Images, Policies, Status, Item Specifics, Market groups)
- [ ] Filter panel shows "eBay Item ID" and "Row type" filters (not "Amazon ASIN")
- [ ] All eBay-specific features intact: Aspects panel, Category search, Variation value order modal, Push history

- [ ] **Step 5: Cross-channel change propagation test**

In `toolbar-icons.ts`, change `label: 'Highlight rules'` → `label: 'Cell highlighting'`. Run type-check + push. Verify BOTH Amazon and eBay toolbars show the new label without touching either client file. Revert after confirming.

```bash
# Revert test change
git checkout apps/web/src/components/flat-file/toolbar-icons.ts
git push origin main
```

- [ ] **Step 6: Regression check on core grid operations**

On both editors:
- [ ] Cell edit (F2 / double-click) works
- [ ] Undo ⌘Z / Redo ⌘⇧Z work
- [ ] Copy ⌘C / Paste ⌘V work
- [ ] Fill down ⌘D works
- [ ] Find & Replace ⌘F works
- [ ] Sort panel opens and applies correctly
- [ ] Conditional formatting rules apply
- [ ] Row images toggle works

---

## Self-Review

**Spec coverage:**
1. ✅ Shared toolbar — `FlatFileToolbar` in `components/flat-file/`; both clients import from there; one change propagates to all
2. ✅ Shared shortcuts — `flat-file-shortcuts.ts` + `TOOLBAR_TOOLS` registry; ⌘G wired in grid keyboard handler
3. ✅ Shared column group UX — `ColumnGroupModal` used by both clients; replaces confusing badge bar
4. ✅ Shared state — `useFlatFileCore` generic hook; both clients destructure from it
5. ✅ Icon clarity — Sparkles×2 resolved: `Paintbrush2` + `Wand2` + `ShieldAlert` + `ClipboardList`
6. ✅ Rich tooltips — DS `Tooltip` wraps every `TbBtn`; content includes label, description, `Kbd` shortcut
7. ✅ Column modal — DS `Modal` + `@dnd-kit/sortable`; replaces draggable badge bar entirely
8. ✅ DS primitives only — `Modal`, `Tooltip`, `Kbd`, `Button`, `Toggle` all from `design-system/`
9. ✅ No API changes — zero route/schema modifications
10. ✅ No new icon libraries — `lucide-react` throughout
11. ✅ FFFilterPanel generalized — `FFFilterPanelBase` + typed `AmazonFFFilterPanel` + `EbayFFFilterPanel`
12. ✅ Both clients rebuilt — Tasks 6+7 cover Amazon and eBay respectively
13. ✅ Backwards-compatible — `FlatFileIconToolbar` and `FFFilterPanel` become re-export shims; no broken imports elsewhere

**Type consistency:**
- `FlatFileColumnGroup` (from `FlatFileGrid.types.ts`) used by `ColumnGroupModal`, `FlatFileGrid`, and both clients ✅
- `GenericFFFilterState<T>` used by `useFlatFileCore` and both channel filter panels ✅
- `AmazonFilterDims` defined in `flat-file-filter.types.ts`, used in `AmazonFFFilterPanel` and `useFlatFileCore` call in Task 6 ✅
- `EbayFilterDims` same pattern for Task 7 ✅
- `FlatFileToolbarProps.onColumnsClick: () => void` — required prop, wired in Tasks 6+7 ✅
- `FlatFileGridProps.onColumnsClick?: () => void` — optional, wired in Task 8 ✅
- `ToolbarToolId` union covers all 13 tools; `getToolDef` throws on unknown id — catches typos at runtime ✅
