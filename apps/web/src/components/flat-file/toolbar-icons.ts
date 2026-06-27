import {
  Undo2, Redo2, Copy, ArrowRightLeft, ShieldAlert,
  ClipboardList, ImageIcon, SlidersHorizontal, Replace,
  Paintbrush2, Wand2, BrainCircuit, Columns,
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
  { id: 'columns',            icon: Columns,            label: 'Columns',          shortcut: '⌘G',   description: 'Show, hide and reorder column groups',           group: 'columns' },
]

export function getToolDef(id: ToolbarToolId): ToolbarToolDef {
  const def = TOOLBAR_TOOLS.find((t) => t.id === id)
  if (!def) throw new Error(`Unknown toolbar tool: ${id}`)
  return def
}
