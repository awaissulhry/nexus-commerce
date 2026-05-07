'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Search,
  ChevronDown,
  ChevronRight,
  Lock,
  X,
  Save,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import {
  type SavedView,
  DEFAULT_VIEWS,
  isDefaultView,
} from '../lib/saved-views'

export interface FieldDef {
  id: string
  label: string
  type: string
  category: string
  channel?: string
  productTypes?: string[]
  options?: string[]
  width?: number
  editable: boolean
  /** T.5 — required-field readiness filter checks this. */
  required?: boolean
  helpText?: string
}

const CATEGORY_ORDER: Array<{
  id: string
  label: string
  description: string
}> = [
  { id: 'universal', label: 'Universal', description: 'Applies to every product' },
  { id: 'pricing', label: 'Pricing', description: 'Master pricing constraints' },
  { id: 'inventory', label: 'Inventory', description: 'Stock and fulfillment' },
  { id: 'identifiers', label: 'Identifiers', description: 'External IDs (SKU, ASIN, GTIN)' },
  { id: 'physical', label: 'Physical', description: 'Weight and dimensions' },
]

const CHANNEL_OPTIONS: Array<{ id: string; label: string; smartDefaults: string[] }> = [
  {
    id: 'AMAZON',
    label: 'Amazon fields',
    smartDefaults: ['amazon_title', 'amazon_bullets', 'amazon_searchKeywords'],
  },
  {
    id: 'EBAY',
    label: 'eBay fields',
    smartDefaults: ['ebay_title', 'ebay_format', 'ebay_duration'],
  },
]

const CATEGORY_TYPE_OPTIONS: Array<{
  id: string
  label: string
  smartDefaults: string[]
}> = [
  {
    id: 'OUTERWEAR',
    label: 'OUTERWEAR fields',
    smartDefaults: ['attr_armorType', 'attr_ceCertification', 'attr_waterproofRating'],
  },
  {
    id: 'HELMET',
    label: 'HELMET fields',
    smartDefaults: ['attr_dotCertification', 'attr_helmetType'],
  },
]

interface Props {
  /** All fields from /api/pim/fields (with current channels/productTypes filters applied). */
  allFields: FieldDef[]
  /** IDs currently visible in the table. */
  visibleColumnIds: string[]
  onVisibleChange: (ids: string[]) => void

  /** Channel/category filter state — drives which fields are returned. */
  enabledChannels: string[]
  onEnabledChannelsChange: (channels: string[]) => void
  enabledProductTypes: string[]
  onEnabledProductTypesChange: (types: string[]) => void

  /** Saved views state */
  views: SavedView[]
  activeViewId: string
  onSelectView: (id: string) => void
  onSaveAsView: (name: string) => void
  onDeleteView: (id: string) => void
}

export default function ColumnSelector({
  allFields,
  visibleColumnIds,
  onVisibleChange,
  enabledChannels,
  onEnabledChannelsChange,
  enabledProductTypes,
  onEnabledProductTypesChange,
  views,
  activeViewId,
  onSelectView,
  onSaveAsView,
  onDeleteView,
}: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [savePromptOpen, setSavePromptOpen] = useState(false)
  const [savePromptName, setSavePromptName] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const visibleSet = useMemo(() => new Set(visibleColumnIds), [visibleColumnIds])

  // Close on outside click + Esc
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        panelRef.current?.contains(t) ||
        triggerRef.current?.contains(t)
      ) {
        return
      }
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Group fields by category
  const fieldsByCategory = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? allFields.filter(
          (f) =>
            f.label.toLowerCase().includes(q) || f.id.toLowerCase().includes(q)
        )
      : allFields

    const groups = new Map<string, FieldDef[]>()
    for (const f of filtered) {
      let arr = groups.get(f.category)
      if (!arr) {
        arr = []
        groups.set(f.category, arr)
      }
      arr.push(f)
    }
    return groups
  }, [allFields, search])

  function toggleField(id: string) {
    if (visibleSet.has(id)) {
      onVisibleChange(visibleColumnIds.filter((x) => x !== id))
    } else {
      // Append in registry order (allFields ordering)
      const indexById = new Map(allFields.map((f, i) => [f.id, i]))
      const next = [...visibleColumnIds, id].sort(
        (a, b) => (indexById.get(a) ?? 99) - (indexById.get(b) ?? 99)
      )
      onVisibleChange(next)
    }
  }

  function toggleCategorySection(categoryId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  function toggleChannel(channelId: string) {
    const isOn = enabledChannels.includes(channelId)
    if (isOn) {
      // Disable: remove channel + remove its fields from visible
      onEnabledChannelsChange(enabledChannels.filter((c) => c !== channelId))
      const channelFieldIds = allFields
        .filter((f) => f.channel === channelId)
        .map((f) => f.id)
      onVisibleChange(visibleColumnIds.filter((x) => !channelFieldIds.includes(x)))
    } else {
      // Enable: add channel. Smart defaults for the new fields will be
      // added once the parent fetches them and we rerun the effect to
      // include them.
      onEnabledChannelsChange([...enabledChannels, channelId])
      // Smart defaults: pre-add the configured ones (parent will fetch
      // the actual field defs and the IDs we add here will be valid
      // once the new fields land).
      const opt = CHANNEL_OPTIONS.find((o) => o.id === channelId)
      if (opt) {
        const next = [...visibleColumnIds]
        for (const id of opt.smartDefaults) {
          if (!next.includes(id)) next.push(id)
        }
        onVisibleChange(next)
      }
    }
  }

  function toggleProductType(typeId: string) {
    const isOn = enabledProductTypes.includes(typeId)
    if (isOn) {
      onEnabledProductTypesChange(enabledProductTypes.filter((t) => t !== typeId))
      const attrIds = allFields
        .filter((f) => f.productTypes?.includes(typeId))
        .map((f) => f.id)
      onVisibleChange(visibleColumnIds.filter((x) => !attrIds.includes(x)))
    } else {
      onEnabledProductTypesChange([...enabledProductTypes, typeId])
      const opt = CATEGORY_TYPE_OPTIONS.find((o) => o.id === typeId)
      if (opt) {
        const next = [...visibleColumnIds]
        for (const id of opt.smartDefaults) {
          if (!next.includes(id)) next.push(id)
        }
        onVisibleChange(next)
      }
    }
  }

  function handleResetToDefault() {
    onSelectView(DEFAULT_VIEWS[0].id)
  }

  function handleSaveSubmit() {
    const name = savePromptName.trim()
    if (!name) return
    onSaveAsView(name)
    setSavePromptName('')
    setSavePromptOpen(false)
  }

  const channelCategoryFields = useMemo(
    () => allFields.filter((f) => f.channel || f.category === 'category'),
    [allFields]
  )
  const visibleChannelCategoryCount = visibleColumnIds.filter((id) =>
    channelCategoryFields.some((f) => f.id === id)
  ).length

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        variant="secondary"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        Columns
        <span className="ml-1 text-xs text-slate-500 tabular-nums">
          {visibleColumnIds.length}/{allFields.length}
        </span>
      </Button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-1 w-[360px] max-h-[640px] bg-white border border-slate-200 rounded-lg shadow-lg z-30 flex flex-col"
          role="dialog"
          aria-label="Column selector"
        >
          {/* Header — search */}
          <div className="px-3 py-2 border-b border-slate-200 flex-shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fields"
                className="w-full h-7 pl-7 pr-2 text-base border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                autoFocus
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* Saved views section */}
            <Section title="Saved Views">
              <ul className="space-y-0.5">
                {views.map((v) => (
                  <li
                    key={v.id}
                    className={cn(
                      'group flex items-center justify-between px-2 py-1 rounded text-base cursor-pointer',
                      v.id === activeViewId
                        ? 'bg-blue-50 text-blue-700'
                        : 'hover:bg-slate-50 text-slate-700'
                    )}
                    onClick={() => onSelectView(v.id)}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className={cn(
                          'w-3 h-3 rounded-full border flex-shrink-0',
                          v.id === activeViewId
                            ? 'bg-blue-600 border-blue-600'
                            : 'border-slate-300'
                        )}
                      />
                      <span className="truncate">{v.name}</span>
                      <span className="text-xs text-slate-400 flex-shrink-0">
                        {v.columnIds.length}
                      </span>
                    </span>
                    {!isDefaultView(v.id) && (
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-600"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDeleteView(v.id)
                        }}
                        title="Delete view"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {savePromptOpen ? (
                <div className="mt-1 flex items-center gap-1">
                  <input
                    type="text"
                    value={savePromptName}
                    onChange={(e) => setSavePromptName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleSaveSubmit()
                      } else if (e.key === 'Escape') {
                        setSavePromptOpen(false)
                        setSavePromptName('')
                      }
                    }}
                    placeholder="View name"
                    className="flex-1 h-6 px-2 text-base border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={handleSaveSubmit}
                    disabled={!savePromptName.trim()}
                    className="h-6 px-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSavePromptOpen(false)
                      setSavePromptName('')
                    }}
                    className="h-6 w-6 flex items-center justify-center text-slate-400 hover:text-slate-700"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setSavePromptOpen(true)}
                  className="mt-1 flex items-center gap-1.5 px-2 py-1 text-sm text-slate-500 hover:text-slate-900 w-full"
                >
                  <Save className="w-3 h-3" />
                  Save current as new view
                </button>
              )}
            </Section>

            {/* Field categories */}
            {CATEGORY_ORDER.map(({ id, label }) => {
              const fields = fieldsByCategory.get(id) ?? []
              if (fields.length === 0) return null
              const sectionCollapsed = collapsed.has(id)
              const visibleInSection = fields.filter((f) => visibleSet.has(f.id)).length
              return (
                <Section
                  key={id}
                  title={
                    <button
                      type="button"
                      onClick={() => toggleCategorySection(id)}
                      className="flex items-center gap-1 hover:text-slate-900"
                    >
                      {sectionCollapsed ? (
                        <ChevronRight className="w-3 h-3" />
                      ) : (
                        <ChevronDown className="w-3 h-3" />
                      )}
                      <span>{label}</span>
                      <span className="text-xs text-slate-400 tabular-nums">
                        {visibleInSection}/{fields.length}
                      </span>
                    </button>
                  }
                >
                  {!sectionCollapsed && (
                    <ul className="space-y-0.5">
                      {fields.map((f) => (
                        <FieldRow
                          key={f.id}
                          field={f}
                          checked={visibleSet.has(f.id)}
                          onToggle={() => toggleField(f.id)}
                        />
                      ))}
                    </ul>
                  )}
                </Section>
              )
            })}

            {/* Channel section */}
            <Section title="Channel Fields">
              <ul className="space-y-0.5">
                {CHANNEL_OPTIONS.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer"
                    onClick={() => toggleChannel(c.id)}
                  >
                    <input
                      type="checkbox"
                      checked={enabledChannels.includes(c.id)}
                      onChange={() => toggleChannel(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-3 h-3 rounded border-slate-300 text-blue-600"
                    />
                    <span className="text-base text-slate-700">{c.label}</span>
                  </li>
                ))}
              </ul>
              {enabledChannels.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {allFields
                    .filter((f) => f.channel && enabledChannels.includes(f.channel))
                    .map((f) => (
                      <FieldRow
                        key={f.id}
                        field={f}
                        checked={visibleSet.has(f.id)}
                        onToggle={() => toggleField(f.id)}
                        indented
                      />
                    ))}
                </ul>
              )}
            </Section>

            {/* Category fields */}
            <Section title="Category Fields">
              <ul className="space-y-0.5">
                {CATEGORY_TYPE_OPTIONS.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer"
                    onClick={() => toggleProductType(c.id)}
                  >
                    <input
                      type="checkbox"
                      checked={enabledProductTypes.includes(c.id)}
                      onChange={() => toggleProductType(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-3 h-3 rounded border-slate-300 text-blue-600"
                    />
                    <span className="text-base text-slate-700">{c.label}</span>
                  </li>
                ))}
              </ul>
              {enabledProductTypes.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {allFields
                    .filter(
                      (f) =>
                        f.category === 'category' &&
                        f.productTypes?.some((pt) => enabledProductTypes.includes(pt))
                    )
                    .map((f) => (
                      <FieldRow
                        key={f.id}
                        field={f}
                        checked={visibleSet.has(f.id)}
                        onToggle={() => toggleField(f.id)}
                        indented
                      />
                    ))}
                </ul>
              )}
              {visibleChannelCategoryCount > 0 && (
                <p className="mt-1 px-2 text-xs text-amber-700">
                  Channel and category fields are read-only until D.3 ships their
                  write logic.
                </p>
              )}
            </Section>
          </div>

          {/* Footer */}
          <div className="px-3 py-2 border-t border-slate-200 flex items-center justify-between flex-shrink-0">
            <button
              type="button"
              onClick={handleResetToDefault}
              className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
            >
              <RotateCcw className="w-3 h-3" />
              Reset to Default
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm text-slate-700 hover:text-slate-900 px-2 py-1"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="px-3 py-2 border-b border-slate-100 last:border-b-0">
      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 flex items-center justify-between">
        <span>{title}</span>
      </div>
      {children}
    </div>
  )
}

function FieldRow({
  field,
  checked,
  onToggle,
  indented,
}: {
  field: FieldDef
  checked: boolean
  onToggle: () => void
  indented?: boolean
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer',
        indented && 'ml-4'
      )}
      onClick={onToggle}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        className="w-3 h-3 rounded border-slate-300 text-blue-600"
      />
      <span className="text-base text-slate-700 flex-1 truncate">{field.label}</span>
      {!field.editable && (
        <span
          className="flex items-center gap-0.5 text-xs text-slate-400"
          title={field.helpText ?? 'Read-only'}
        >
          <Lock className="w-2.5 h-2.5" />
          Read-only
        </span>
      )}
    </li>
  )
}
