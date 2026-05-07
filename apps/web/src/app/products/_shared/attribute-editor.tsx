'use client'

import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { type ChannelGroup } from '../[id]/list-wizard/components/ChannelGroupsManager'

// Mirrors UnionField on the backend (apps/api/src/services/listing-
// wizard/schema-parser.service.ts). Kept as plain interfaces here so
// the frontend doesn't have to import from the API package.
export type FieldKind =
  | 'text'
  | 'longtext'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'string_array'
  | 'unsupported'

/** L.2 — string_array values are stored as JSON-encoded string[]
 *  in the same `Record<string, Primitive>` shape so existing storage
 *  paths don't fork. The UI parses on read, stringifies on write. */
export type Primitive = string | number | boolean

export interface UnionField {
  id: string
  label: string
  description?: string
  kind: FieldKind
  required: boolean
  wrapped: boolean
  options?: Array<{ value: string; label: string }>
  defaultValue?: string | number | boolean
  examples?: string[]
  maxLength?: number
  minLength?: number
  unsupportedReason?: string
  maxItems?: number
  requiredFor: string[]
  optionalFor: string[]
  notUsedIn: string[]
  currentValue?: string | number | boolean
  overrides: Record<string, string | number | boolean>
  divergent?: boolean
  variantEligible: boolean
}

export interface UnionVariation {
  id: string
  sku: string
  attributes: Record<string, string>
}

export interface UnionManifest {
  channels: Array<{ platform: string; marketplace: string; productType: string }>
  schemaVersionByChannel: Record<string, string>
  fetchedAtByChannel: Record<string, string>
  fields: UnionField[]
  channelsMissingSchema: Array<{
    channelKey: string
    reason: 'no_product_type' | 'fetch_failed' | 'unsupported_channel'
    detail?: string
  }>
  variations: UnionVariation[]
  optionalFieldCount: number
  includesAllOptional: boolean
}

/** Maps the Amazon field id to the ContentField name the
 *  /generate-content endpoint expects. */
export const AI_FIELD_MAP: Record<
  string,
  'title' | 'bullets' | 'description' | 'keywords'
> = {
  item_name: 'title',
  bullet_point: 'bullets',
  product_description: 'description',
  generic_keyword: 'keywords',
}
export const AI_SUPPORTED_FIELDS = new Set(Object.keys(AI_FIELD_MAP))

// ── helpers ─────────────────────────────────────────────────────

export function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (typeof v === 'number') return Number.isNaN(v)
  return false
}

export function currentLength(v: unknown): number {
  if (typeof v === 'string') return v.length
  return 0
}

export function formatValue(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

export function parseStringArray(value: string | undefined): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  // L.2 storage convention: JSON-encoded string[]. Tolerant of older
  // single-string values (treat as a one-entry array) so wizards
  // saved before this commit still render.
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => typeof s === 'string') as string[]
    }
  } catch {
    /* fall through */
  }
  return [value]
}

/** M.3 — flag a master product whose variants don't share the same
 *  attribute axes. Triggers when EITHER:
 *    (a) the union of attribute keys across all variants > 4
 *    (Amazon's variation themes max out around 3-4 axes), OR
 *    (b) at least two variants have non-overlapping key sets, i.e.
 *    a variant carries keys that another variant doesn't and vice
 *    versa.
 *  Empty / single-variant masters are always considered consistent. */
export function computeVariantSpan(
  variations: UnionVariation[],
): { suspicious: boolean; uniqueKeyCount: number } {
  if (variations.length < 2) {
    return { suspicious: false, uniqueKeyCount: 0 }
  }
  const allKeys = new Set<string>()
  const keysPerVariant: string[][] = []
  for (const v of variations) {
    const keys = Object.keys(v.attributes).filter(
      (k) => v.attributes[k]!.length > 0,
    )
    keysPerVariant.push(keys)
    for (const k of keys) allKeys.add(k)
  }
  const uniqueKeyCount = allKeys.size

  if (uniqueKeyCount > 4) {
    return { suspicious: true, uniqueKeyCount }
  }

  for (let i = 0; i < keysPerVariant.length; i++) {
    const ki = new Set(keysPerVariant[i])
    for (let j = i + 1; j < keysPerVariant.length; j++) {
      const kj = new Set(keysPerVariant[j])
      const inIonly = [...ki].some((k) => !kj.has(k))
      const inJonly = [...kj].some((k) => !ki.has(k))
      if (inIonly && inJonly) {
        return { suspicious: true, uniqueKeyCount }
      }
    }
  }
  return { suspicious: false, uniqueKeyCount }
}

// ── field grouping ──────────────────────────────────────────────
//
// Amazon productType schemas can surface 200-400 optional fields once
// `Show all optional` is on. A flat list is unscannable, so we bucket
// fields into a fixed taxonomy via prefix / substring rules. The order
// here also drives the on-screen render order — Identity first because
// it's where every listing starts; Other last as the catch-all.
//
// We don't try to lift Amazon's `propertyGroups` out of the schema
// (it's not consistently populated across productTypes); a curated
// heuristic is more reliable in practice.

interface FieldGroupDef {
  name: string
  match: (id: string) => boolean
}

const IDENTITY_IDS = new Set([
  'item_name',
  'brand',
  'manufacturer',
  'model_number',
  'manufacturer_part_number',
  'part_number',
  'gtin',
  'externally_assigned_product_identifier',
  'product_identifier',
  'asin',
  'merchant_suggested_asin',
  'supplier_declared_dg_hz_regulation',
])

const MARKETING_IDS = new Set([
  'bullet_point',
  'product_description',
  'generic_keyword',
  'search_terms',
  'special_feature',
  'product_site_launch_date',
  'subject_character',
])

const VARIATION_IDS = new Set([
  'color',
  'color_name',
  'pattern_name',
  'style',
  'style_name',
  'material_type',
  'material',
  'fabric_type',
  'item_form',
  'shape',
  'finish_type',
  'closure_type',
])

const AUDIENCE_IDS = new Set([
  'target_audience_keyword',
  'target_gender',
  'age_range_description',
  'recommended_uses_for_product',
  'sport_type',
  'occasion_type',
  'department_name',
])

const CATEGORISATION_IDS = new Set([
  'recommended_browse_nodes',
  'item_type_keyword',
  'item_type_name',
  'department',
  'category',
  'website_shipping_weight',
])

const FULFILLMENT_IDS = new Set([
  'list_price',
  'msrp',
  'business_price',
  'condition_type',
  'condition_note',
  'fulfillment_availability',
  'merchant_shipping_group',
  'manufacturer_minimum_age_recommended',
  'package_level',
])

const FIELD_GROUPS: FieldGroupDef[] = [
  { name: 'Identity', match: (id) => IDENTITY_IDS.has(id) },
  { name: 'Marketing copy', match: (id) => MARKETING_IDS.has(id) },
  {
    name: 'Variation attributes',
    match: (id) =>
      VARIATION_IDS.has(id) ||
      /^(size|apparel_size|shoe_size|footwear_size)/.test(id),
  },
  { name: 'Audience', match: (id) => AUDIENCE_IDS.has(id) },
  { name: 'Categorisation', match: (id) => CATEGORISATION_IDS.has(id) },
  {
    name: 'Pricing & fulfillment',
    match: (id) =>
      FULFILLMENT_IDS.has(id) ||
      /^(list_price|msrp|business_price|condition|fulfillment|shipping|package_quantity)/.test(
        id,
      ),
  },
  {
    name: 'Physical attributes',
    match: (id) =>
      /(weight|dimension|length|width|height|depth|girth|capacity|volume)/.test(
        id,
      ) && !/expir/.test(id),
  },
  {
    name: 'Compliance & safety',
    match: (id) =>
      /(cpsia|country_of_origin|ce_marked|fcc|hazardous|ghs|battery|cosmetic|warning|safety|recall|warranty|import|export|tariff|customs|regulation|certification|expiration|expir)/.test(
        id,
      ),
  },
]

const OTHER_GROUP = 'Other attributes'

/** Picks the bucket name for a given field id. Returns 'Other
 *  attributes' when no rule matches — every field always lands in
 *  some group so the UI never drops fields. */
export function groupForFieldId(id: string): string {
  for (const g of FIELD_GROUPS) {
    if (g.match(id)) return g.name
  }
  return OTHER_GROUP
}

/** Groups a flat field list into the FIELD_GROUPS order. Empty
 *  buckets are dropped so the UI doesn't render headers without
 *  rows. Within a group, original field order is preserved. */
export function groupFields(
  fields: UnionField[],
): Array<{ name: string; fields: UnionField[] }> {
  const map = new Map<string, UnionField[]>()
  for (const f of fields) {
    const g = groupForFieldId(f.id)
    const arr = map.get(g) ?? []
    arr.push(f)
    map.set(g, arr)
  }
  const order = [...FIELD_GROUPS.map((g) => g.name), OTHER_GROUP]
  return order
    .filter((name) => (map.get(name)?.length ?? 0) > 0)
    .map((name) => ({ name, fields: map.get(name)! }))
}

/** Collapsible section that wraps a slice of FieldCards. Auto-
 *  expanded when the caller signals there's something inside that
 *  needs attention (required-here field, value already saved, etc).
 *  Header surfaces field count + required / unfilled chips so the
 *  user can scan without expanding. */
export function FieldGroupSection({
  name,
  count,
  requiredCount,
  unsatisfiedCount,
  filledCount,
  defaultExpanded,
  expanded: expandedProp,
  onExpandedChange,
  headerAction,
  children,
}: {
  name: string
  count: number
  requiredCount?: number
  unsatisfiedCount?: number
  filledCount?: number
  defaultExpanded: boolean
  /** U.4 — controlled expansion. When provided, the parent owns
   *  the open/close state, which is needed for "jump to field"
   *  flows that must force a collapsed group open. When omitted
   *  the section is uncontrolled and uses defaultExpanded. */
  expanded?: boolean
  onExpandedChange?: (next: boolean) => void
  /** Right-side slot in the header (e.g. a "Copy from sibling"
   *  dropdown for the edit page). Click events here don't bubble to
   *  the toggle. */
  headerAction?: React.ReactNode
  children: React.ReactNode
}) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)
  const isControlled = expandedProp !== undefined
  const expanded = isControlled ? expandedProp : internalExpanded
  const setExpanded = (next: boolean | ((prev: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(expanded) : next
    if (!isControlled) setInternalExpanded(value)
    onExpandedChange?.(value)
  }
  return (
    <div
      className={cn(
        'border rounded-lg bg-white overflow-hidden',
        (unsatisfiedCount ?? 0) > 0 ? 'border-amber-200' : 'border-slate-200',
      )}
    >
      <div className="flex items-stretch justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          className="flex-1 flex items-center gap-2 flex-wrap min-w-0 px-4 py-2.5 hover:bg-slate-50 text-left"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          )}
          <span className="text-md font-semibold text-slate-900">
            {name}
          </span>
          <span className="text-sm text-slate-500 tabular-nums">
            {count} field{count === 1 ? '' : 's'}
          </span>
          {(requiredCount ?? 0) > 0 && (
            <span className="text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">
              {requiredCount} required
            </span>
          )}
          {(unsatisfiedCount ?? 0) > 0 && (
            <span className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
              {unsatisfiedCount} unfilled
            </span>
          )}
          {(filledCount ?? 0) > 0 && (
            <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
              {filledCount} filled
            </span>
          )}
        </button>
        {headerAction && (
          <div
            className="flex items-center px-2"
            onClick={(e) => e.stopPropagation()}
          >
            {headerAction}
          </div>
        )}
      </div>
      {expanded && (
        <div className="border-t border-slate-100 p-3 space-y-3 bg-slate-50/30">
          {children}
        </div>
      )}
    </div>
  )
}

// ── leaf components ─────────────────────────────────────────────

export function FieldCard({
  id,
  highlight,
  field,
  viewMode,
  baseValue,
  onBaseChange,
  overrides,
  onOverrideChange,
  variations,
  variantValues,
  onVariantChange,
  variantsExpanded,
  onToggleVariants,
  expanded,
  onToggleExpanded,
  unsatisfiedChannels,
  onAIGenerate,
  aiBusy,
  onTranslate,
  translateBusy,
  channelGroups,
  allChannelKeys,
  onApplyToChannels,
}: {
  /** U.4 — DOM id used as scroll target for "Jump to next" navigation. */
  id?: string
  /** U.4 — when true, draws a brief outline pulse to point the user at
   *  the field after a jump. Caller toggles back off after the pulse. */
  highlight?: boolean
  field: UnionField
  viewMode: 'base' | { channelKey: string }
  baseValue: Primitive | undefined
  onBaseChange: (v: Primitive) => void
  overrides: Record<string, Primitive | undefined>
  onOverrideChange: (channelKey: string, v: Primitive | undefined) => void
  variations: UnionVariation[]
  variantValues: Record<string, Primitive | undefined>
  onVariantChange: (variationId: string, v: Primitive | undefined) => void
  variantsExpanded: boolean
  onToggleVariants: () => void
  expanded: boolean
  onToggleExpanded: () => void
  unsatisfiedChannels: string[]
  onAIGenerate?: () => void
  aiBusy?: boolean
  onTranslate?: (fieldId: string, channelKey: string) => void
  translateBusy?: Set<string>
  channelGroups?: ChannelGroup[]
  allChannelKeys?: string[]
  onApplyToChannels?: (
    fieldId: string,
    sourceChannelKey: string,
    targetKeys: string[],
  ) => void
}) {
  const supportsAI = AI_SUPPORTED_FIELDS.has(field.id)
  const isChannelView = typeof viewMode === 'object'
  const activeChannelKey = isChannelView ? viewMode.channelKey : null
  const isRequiredHere =
    activeChannelKey !== null && field.requiredFor.includes(activeChannelKey)
  const isOptionalHere =
    activeChannelKey !== null && field.optionalFor.includes(activeChannelKey)
  const channelOverrideValue = activeChannelKey
    ? overrides[activeChannelKey]
    : undefined
  const channelInherits =
    isChannelView && isEmpty(channelOverrideValue) && !isEmpty(baseValue)
  const hasUnsatisfied = unsatisfiedChannels.length > 0
  const overrideCount = Object.values(overrides).filter(
    (v) => !isEmpty(v),
  ).length
  const variantOverrideCount = Object.values(variantValues).filter(
    (v) => !isEmpty(v),
  ).length
  // Per-variant override available on EVERY field when there are
  // variants, not just the curated variant-eligible set. We keep the
  // eligibility flag as a label so the UI can warn when the user is
  // overriding something Amazon wouldn't accept per variant.
  const showVariantSection = variations.length > 0

  return (
    <div
      id={id}
      tabIndex={-1}
      className={cn(
        'border rounded-lg bg-white px-4 py-3 scroll-mt-32 outline-none transition-shadow',
        hasUnsatisfied ? 'border-amber-200' : 'border-slate-200',
        highlight && 'ring-2 ring-blue-400 ring-offset-2 shadow-md',
      )}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3 flex-wrap">
        <label className="text-md font-medium text-slate-900">
          {field.label}
          {(viewMode === 'base'
            ? field.requiredFor.length > 0
            : isRequiredHere) && <span className="text-rose-600 ml-0.5">*</span>}
          <span className="ml-2 text-sm font-mono font-normal text-slate-400">
            {field.id}
          </span>
        </label>
        <div className="flex items-center gap-1.5 flex-wrap">
          {viewMode === 'base' ? (
            <>
              {field.requiredFor.length > 0 && (
                <ChannelTagGroup
                  tone="required"
                  channels={field.requiredFor}
                />
              )}
              {field.optionalFor.length > 0 && (
                <ChannelTagGroup
                  tone="optional"
                  channels={field.optionalFor}
                />
              )}
            </>
          ) : (
            <span
              className={cn(
                'text-xs uppercase tracking-wide font-medium px-1.5 py-0.5 border rounded',
                isRequiredHere
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : isOptionalHere
                  ? 'bg-slate-50 text-slate-600 border-slate-200'
                  : 'bg-slate-50 text-slate-400 border-slate-200',
              )}
            >
              {isRequiredHere
                ? 'Required'
                : isOptionalHere
                ? 'Optional'
                : 'Not used'}
            </span>
          )}
        </div>
      </div>
      {field.description && (
        <p className="text-base text-slate-500 mb-2">{field.description}</p>
      )}
      {field.divergent && (
        <p className="text-sm text-amber-700 mb-2">
          Heads-up: this field's metadata differs across channels (different
          enum values or length limits). Use overrides per channel if the
          merged shape doesn't fit one of them.
        </p>
      )}

      {supportsAI && onAIGenerate && (
        <div className="mb-2 flex items-center justify-end">
          <button
            type="button"
            onClick={onAIGenerate}
            disabled={aiBusy}
            className="inline-flex items-center gap-1 h-6 px-2 text-sm font-medium text-blue-700 border border-blue-200 rounded hover:bg-blue-50 disabled:opacity-40"
            title={`Generate ${field.label} with AI for the first selected channel`}
          >
            {aiBusy ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            AI generate
          </button>
        </div>
      )}

      {viewMode === 'base' ? (
        <FieldInput field={field} value={baseValue} onChange={onBaseChange} />
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <FieldInput
              field={field}
              value={channelOverrideValue}
              onChange={(v) => onOverrideChange(activeChannelKey!, v)}
              placeholder={
                channelInherits
                  ? `Inherits base: ${formatValue(baseValue)}`
                  : '— (leave empty to use base)'
              }
            />
          </div>
          <OverrideMenu
            channelKey={activeChannelKey!}
            hasBase={!isEmpty(baseValue)}
            otherChannels={Object.entries(overrides)
              .filter(([k, v]) => k !== activeChannelKey && !isEmpty(v))
              .map(([k]) => k)}
            otherValues={Object.fromEntries(
              Object.entries(overrides)
                .filter(([k, v]) => k !== activeChannelKey && !isEmpty(v))
                .map(([k, v]) => [k, v as Primitive]),
            )}
            hasValue={!isEmpty(channelOverrideValue)}
            currentValue={channelOverrideValue}
            channelGroups={channelGroups ?? []}
            allChannelKeys={allChannelKeys ?? []}
            supportsTranslate={
              AI_SUPPORTED_FIELDS.has(field.id) && !isEmpty(baseValue)
            }
            translateBusy={
              translateBusy?.has(`${field.id}:${activeChannelKey}`) ?? false
            }
            onCopyFromBase={() => {
              if (!isEmpty(baseValue)) {
                onOverrideChange(activeChannelKey!, baseValue as Primitive)
              }
            }}
            onCopyFrom={(sourceKey) => {
              const v = overrides[sourceKey]
              if (!isEmpty(v)) {
                onOverrideChange(activeChannelKey!, v as Primitive)
              }
            }}
            onApplyToChannels={(targetKeys) =>
              onApplyToChannels?.(field.id, activeChannelKey!, targetKeys)
            }
            onTranslate={() => onTranslate?.(field.id, activeChannelKey!)}
            onClear={() => onOverrideChange(activeChannelKey!, undefined)}
          />
        </div>
      )}

      {field.examples && field.examples.length > 0 && field.kind !== 'enum' && (
        <p className="mt-1.5 text-sm text-slate-400">
          Examples: {field.examples.join(', ')}
        </p>
      )}
      {field.maxLength && field.kind !== 'enum' && (
        <p className="mt-1 text-sm text-slate-400">
          {currentLength(
            viewMode === 'base' ? baseValue : channelOverrideValue,
          )}{' '}
          / {field.maxLength} characters
        </p>
      )}

      {viewMode === 'base' && field.requiredFor.length > 1 && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="text-base text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            Override per channel
            {overrideCount > 0 && (
              <span className="text-xs font-medium text-blue-700 bg-blue-50 px-1 py-0.5 rounded">
                {overrideCount}
              </span>
            )}
          </button>
          {expanded && (
            <div className="mt-2 space-y-2">
              {field.requiredFor.map((channelKey) => {
                const ov = overrides[channelKey]
                const isUnsatisfied =
                  unsatisfiedChannels.includes(channelKey)
                const otherFilled = Object.entries(overrides)
                  .filter(([k, v]) => k !== channelKey && !isEmpty(v))
                  .map(([k]) => k)
                return (
                  <div
                    key={channelKey}
                    className={cn(
                      'flex items-center gap-2',
                      isUnsatisfied && 'bg-amber-50/40 -mx-2 px-2 rounded',
                    )}
                  >
                    <span className="text-sm font-mono text-slate-600 w-24 flex-shrink-0">
                      {channelKey}
                    </span>
                    <FieldInput
                      field={field}
                      value={ov}
                      onChange={(v) => onOverrideChange(channelKey, v)}
                      placeholder={
                        isEmpty(baseValue)
                          ? '— (leave empty to use base)'
                          : `Inherits: ${formatValue(baseValue)}`
                      }
                      compact
                    />
                    <OverrideMenu
                      channelKey={channelKey}
                      hasBase={!isEmpty(baseValue)}
                      otherChannels={otherFilled}
                      otherValues={Object.fromEntries(
                        otherFilled.map((k) => [k, overrides[k] as Primitive]),
                      )}
                      hasValue={!isEmpty(ov)}
                      currentValue={ov}
                      channelGroups={channelGroups ?? []}
                      allChannelKeys={allChannelKeys ?? []}
                      supportsTranslate={
                        AI_SUPPORTED_FIELDS.has(field.id) &&
                        !isEmpty(baseValue)
                      }
                      translateBusy={
                        translateBusy?.has(`${field.id}:${channelKey}`) ?? false
                      }
                      onCopyFromBase={() => {
                        if (!isEmpty(baseValue)) {
                          onOverrideChange(channelKey, baseValue as Primitive)
                        }
                      }}
                      onCopyFrom={(sourceKey) => {
                        const v = overrides[sourceKey]
                        if (!isEmpty(v)) {
                          onOverrideChange(channelKey, v as Primitive)
                        }
                      }}
                      onApplyToChannels={(targetKeys) =>
                        onApplyToChannels?.(field.id, channelKey, targetKeys)
                      }
                      onTranslate={() => onTranslate?.(field.id, channelKey)}
                      onClear={() => onOverrideChange(channelKey, undefined)}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {showVariantSection && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onToggleVariants}
              className="text-base text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
            >
              {variantsExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              Override per variation
              {variantOverrideCount > 0 && (
                <span className="text-xs font-medium text-purple-700 bg-purple-50 px-1 py-0.5 rounded">
                  {variantOverrideCount} of {variations.length}
                </span>
              )}
              {!field.variantEligible ? (
                <span
                  className="text-xs uppercase tracking-wide font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded"
                  title="Amazon rejects per-variant values on this field. Override at your own risk — Shopify and other channels may accept it."
                >
                  not Amazon-eligible
                </span>
              ) : (
                <span className="text-xs text-slate-400 italic">
                  (variant-eligible)
                </span>
              )}
            </button>
            {variantsExpanded && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    for (const v of variations) {
                      const master = v.attributes[field.id.toLowerCase()]
                      if (
                        master &&
                        master.length > 0 &&
                        isEmpty(variantValues[v.id])
                      ) {
                        onVariantChange(v.id, master as Primitive)
                      }
                    }
                  }}
                  title="Fill empty variant slots with each variant's master attribute value"
                  className="text-sm text-blue-600 hover:underline"
                >
                  Pull master values
                </button>
                {variantOverrideCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      for (const v of variations) {
                        if (!isEmpty(variantValues[v.id])) {
                          onVariantChange(v.id, undefined)
                        }
                      }
                    }}
                    title="Clear every per-variant override for this field"
                    className="text-sm text-slate-500 hover:text-slate-900 hover:underline"
                  >
                    Clear all
                  </button>
                )}
              </div>
            )}
          </div>
          {variantsExpanded && (
            <div className="mt-2 space-y-1.5">
              {!field.variantEligible && (
                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-1">
                  Amazon's listing model treats this field as product-
                  level, so per-variant values are rejected at submit
                  time. Shopify accepts more variant-level shapes; the
                  override stays in wizard state regardless.
                </div>
              )}
              {variations.map((v) => {
                const seedFromMaster = v.attributes[field.id.toLowerCase()]
                const value = variantValues[v.id]
                const otherFilled = variations
                  .filter(
                    (other) =>
                      other.id !== v.id && !isEmpty(variantValues[other.id]),
                  )
                  .map((other) => other.id)
                return (
                  <div key={v.id} className="flex items-center gap-2">
                    <div className="w-32 flex-shrink-0 min-w-0">
                      <div className="font-mono text-sm text-slate-700 truncate">
                        {v.sku}
                      </div>
                      <div className="text-xs text-slate-500 truncate">
                        {Object.entries(v.attributes)
                          .map(([k, val]) => `${k}: ${val}`)
                          .join(' · ') || '—'}
                      </div>
                    </div>
                    <div className="flex-1 flex items-center gap-1">
                      <div className="flex-1">
                        <FieldInput
                          field={field}
                          value={value}
                          onChange={(val) => onVariantChange(v.id, val)}
                          placeholder={
                            seedFromMaster
                              ? `Master: ${seedFromMaster}`
                              : isEmpty(baseValue)
                              ? '— (leave empty to use base)'
                              : `Inherits: ${formatValue(baseValue)}`
                          }
                          compact
                        />
                      </div>
                      {!isEmpty(value) && (
                        <VariantBroadcastMenu
                          variantId={v.id}
                          variations={variations}
                          otherFilledIds={otherFilled}
                          variantValues={variantValues}
                          onBroadcast={(targetIds) => {
                            for (const t of targetIds) {
                              onVariantChange(t, value as Primitive)
                            }
                          }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function FieldInput({
  field,
  value,
  onChange,
  placeholder,
  compact = false,
}: {
  field: UnionField
  value: Primitive | undefined
  onChange: (v: Primitive) => void
  placeholder?: string
  compact?: boolean
}) {
  if (field.kind === 'unsupported') {
    return (
      <div className="text-base text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        Can't render this field automatically yet.
        {field.unsupportedReason ? ` (${field.unsupportedReason})` : ''}
      </div>
    )
  }

  if (field.kind === 'enum') {
    const v = (value ?? '') as string
    return (
      <select
        value={v}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full px-2 text-md border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white',
          compact ? 'h-7' : 'h-8',
        )}
      >
        <option value="">— Select —</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    )
  }

  if (field.kind === 'boolean') {
    const v = Boolean(value)
    return (
      <label className="flex items-center gap-2 text-md text-slate-700">
        <input
          type="checkbox"
          checked={v}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        {v ? 'Yes' : 'No'}
      </label>
    )
  }

  if (field.kind === 'string_array') {
    const arr = parseStringArray(value as string | undefined)
    const max = Math.max(field.maxItems ?? 5, 1)
    const slots: string[] = []
    for (let i = 0; i < max; i++) slots.push(arr[i] ?? '')
    return (
      <div className="space-y-1.5">
        {slots.map((slot, idx) => (
          <div key={idx} className="flex items-start gap-2">
            <span className="text-xs font-mono text-slate-400 mt-2 flex-shrink-0">
              {idx + 1}.
            </span>
            <textarea
              value={slot}
              maxLength={field.maxLength}
              rows={compact ? 1 : 2}
              placeholder={
                idx === 0 && placeholder ? placeholder : `Entry ${idx + 1}`
              }
              onChange={(e) => {
                const next = slots.slice()
                next[idx] = e.target.value
                while (next.length > 0 && next[next.length - 1] === '') {
                  next.pop()
                }
                onChange(next.length === 0 ? '' : JSON.stringify(next))
              }}
              className="flex-1 px-2 py-1 text-md border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            {field.maxLength && (
              <span className="text-xs font-mono text-slate-400 mt-2 tabular-nums w-12 text-right flex-shrink-0">
                {slot.length}/{field.maxLength}
              </span>
            )}
          </div>
        ))}
      </div>
    )
  }

  if (field.kind === 'number') {
    const v = value === undefined ? '' : String(value)
    return (
      <input
        type="number"
        value={v}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') onChange('')
          else {
            const n = Number(raw)
            if (!Number.isNaN(n)) onChange(n)
          }
        }}
        className={cn(
          'w-full px-2 text-md border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
          compact ? 'h-7' : 'h-8',
        )}
      />
    )
  }

  if (field.kind === 'longtext') {
    const v = (value ?? '') as string
    return (
      <textarea
        value={v}
        onChange={(e) => onChange(e.target.value)}
        rows={compact ? 2 : 4}
        maxLength={field.maxLength}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 text-md border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
      />
    )
  }

  // text
  const v = (value ?? '') as string
  return (
    <input
      type="text"
      value={v}
      onChange={(e) => onChange(e.target.value)}
      maxLength={field.maxLength}
      placeholder={placeholder}
      className={cn(
        'w-full px-2 text-md border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500',
        compact ? 'h-7' : 'h-8',
      )}
    />
  )
}

export function ChannelTagGroup({
  tone,
  channels,
}: {
  tone: 'required' | 'optional'
  channels: string[]
}) {
  const toneClass =
    tone === 'required'
      ? 'bg-blue-50 text-blue-700 border-blue-200'
      : 'bg-slate-50 text-slate-600 border-slate-200'
  const label = tone === 'required' ? 'Required' : 'Optional'
  return (
    <div className="inline-flex items-center gap-1 flex-wrap">
      <span className="text-xs uppercase tracking-wide text-slate-500 font-medium">
        {label}:
      </span>
      {channels.map((c) => (
        <span
          key={c}
          className={cn(
            'inline-flex items-center text-xs font-mono font-medium px-1.5 py-0.5 border rounded',
            toneClass,
          )}
        >
          {c}
        </span>
      ))}
    </div>
  )
}

// M.1 — platform tabs at top, marketplace sub-tabs below.
export function AttributesTabStrip({
  channels,
  activeTab,
  onTabChange,
  unsatisfied,
}: {
  channels: Array<{ platform: string; marketplace: string }>
  activeTab: string
  onTabChange: (tab: string) => void
  unsatisfied: Array<{ id: string; channelKey: string }>
}) {
  const byPlatform = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const c of channels) {
      const arr = m.get(c.platform) ?? []
      arr.push(c.marketplace)
      m.set(c.platform, arr)
    }
    return Array.from(m.entries())
  }, [channels])

  const unsatisfiedByChannel = useMemo(() => {
    const counts = new Map<string, number>()
    for (const u of unsatisfied) {
      counts.set(u.channelKey, (counts.get(u.channelKey) ?? 0) + 1)
    }
    return counts
  }, [unsatisfied])

  const activePlatform = activeTab === 'base' ? null : activeTab.split(':')[0]

  return (
    <div className="border-b border-slate-200">
      <div className="flex items-end gap-1 overflow-x-auto">
        <TabButton
          label="Shared base"
          active={activeTab === 'base'}
          onClick={() => onTabChange('base')}
        />
        {byPlatform.map(([platform, marketplaces]) => {
          const isActive =
            activeTab !== 'base' && activeTab.startsWith(`${platform}:`)
          const total = marketplaces.reduce(
            (sum, m) =>
              sum + (unsatisfiedByChannel.get(`${platform}:${m}`) ?? 0),
            0,
          )
          return (
            <TabButton
              key={platform}
              label={platform}
              active={isActive}
              badge={total > 0 ? String(total) : undefined}
              onClick={() => {
                if (!isActive) {
                  const first = marketplaces[0]
                  if (first) onTabChange(`${platform}:${first}`)
                }
              }}
            />
          )
        })}
      </div>

      {activePlatform && (
        <div className="flex items-center gap-1 px-2 py-1.5 bg-slate-50 border-t border-slate-100 overflow-x-auto">
          {byPlatform
            .find(([p]) => p === activePlatform)?.[1]
            .map((m) => {
              const channelKey = `${activePlatform}:${m}`
              const isActive = activeTab === channelKey
              const count = unsatisfiedByChannel.get(channelKey) ?? 0
              return (
                <SubTabButton
                  key={m}
                  label={m}
                  active={isActive}
                  badge={count > 0 ? String(count) : undefined}
                  onClick={() => onTabChange(channelKey)}
                />
              )
            })}
        </div>
      )}
    </div>
  )
}

export function TabButton({
  label,
  active,
  badge,
  onClick,
}: {
  label: string
  active: boolean
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-2 text-base font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 flex-shrink-0',
        active
          ? 'border-blue-600 text-blue-700'
          : 'border-transparent text-slate-600 hover:text-slate-900',
      )}
    >
      {label}
      {badge && (
        <span
          className={cn(
            'text-xs font-mono px-1 rounded',
            active
              ? 'bg-amber-100 text-amber-700'
              : 'bg-amber-50 text-amber-600',
          )}
          title={`${badge} required field${badge === '1' ? '' : 's'} unsatisfied`}
        >
          {badge}
        </span>
      )}
    </button>
  )
}

export function SubTabButton({
  label,
  active,
  badge,
  onClick,
}: {
  label: string
  active: boolean
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 px-2 text-sm font-mono font-medium rounded inline-flex items-center gap-1.5 transition-colors flex-shrink-0',
        active
          ? 'bg-blue-100 text-blue-800'
          : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900',
      )}
    >
      {label}
      {badge && (
        <span className="text-xs bg-amber-100 text-amber-700 px-1 rounded">
          {badge}
        </span>
      )}
    </button>
  )
}

export function OverrideMenu({
  channelKey,
  hasBase,
  otherChannels,
  otherValues,
  hasValue,
  currentValue,
  channelGroups,
  allChannelKeys,
  supportsTranslate,
  translateBusy,
  onCopyFromBase,
  onCopyFrom,
  onApplyToChannels,
  onTranslate,
  onClear,
}: {
  channelKey: string
  hasBase: boolean
  otherChannels: string[]
  otherValues: Record<string, Primitive>
  hasValue: boolean
  currentValue?: Primitive
  channelGroups: ChannelGroup[]
  allChannelKeys: string[]
  supportsTranslate: boolean
  translateBusy: boolean
  onCopyFromBase: () => void
  onCopyFrom: (sourceKey: string) => void
  onApplyToChannels: (targetKeys: string[]) => void
  onTranslate: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title="Copy or translate"
        aria-label="Copy or translate"
        className="h-6 w-6 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
      >
        {translateBusy ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <span className="text-lg leading-none">⋯</span>
        )}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-slate-200 rounded shadow-md py-1 min-w-[200px] text-base">
            {hasBase && (
              <button
                type="button"
                onClick={() => {
                  onCopyFromBase()
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
              >
                Copy from base
              </button>
            )}
            {otherChannels.length > 0 && (
              <>
                <div className="px-3 py-0.5 text-xs uppercase tracking-wide text-slate-400">
                  Copy from
                </div>
                {otherChannels.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      onCopyFrom(k)
                      setOpen(false)
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                  >
                    <span className="font-mono text-sm">{k}</span>
                    <span className="block text-xs text-slate-500 truncate">
                      {String(otherValues[k]).slice(0, 40)}
                    </span>
                  </button>
                ))}
              </>
            )}
            {supportsTranslate && (
              <button
                type="button"
                onClick={() => {
                  onTranslate()
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-blue-700 inline-flex items-center gap-1.5"
              >
                <Sparkles className="w-3 h-3" />
                Translate from base for {channelKey.split(':')[1]}
              </button>
            )}
            {!isEmpty(currentValue) && (
              <>
                <div className="border-t border-slate-100 my-1" />
                <div className="px-3 py-0.5 text-xs uppercase tracking-wide text-slate-400">
                  Apply this value to
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onApplyToChannels(
                      allChannelKeys.filter((k) => k !== channelKey),
                    )
                    setOpen(false)
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                >
                  All other channels{' '}
                  <span className="text-xs text-slate-500">
                    ({allChannelKeys.length - 1})
                  </span>
                </button>
                {(() => {
                  const platform = channelKey.split(':')[0]
                  const samePlatform = allChannelKeys.filter(
                    (k) => k !== channelKey && k.startsWith(`${platform}:`),
                  )
                  if (samePlatform.length === 0) return null
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        onApplyToChannels(samePlatform)
                        setOpen(false)
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                    >
                      Other {platform} marketplaces{' '}
                      <span className="text-xs text-slate-500">
                        ({samePlatform.length})
                      </span>
                    </button>
                  )
                })()}
                {channelGroups
                  .filter(
                    (g) =>
                      g.channelKeys.length > 0 &&
                      g.channelKeys.some((k) => k !== channelKey),
                  )
                  .map((g) => {
                    const targets = g.channelKeys.filter(
                      (k) => k !== channelKey,
                    )
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => {
                          onApplyToChannels(targets)
                          setOpen(false)
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                      >
                        Group: {g.name}{' '}
                        <span className="text-xs text-slate-500">
                          ({targets.length})
                        </span>
                      </button>
                    )
                  })}
              </>
            )}
            {hasValue && (
              <button
                type="button"
                onClick={() => {
                  onClear()
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-rose-700 border-t border-slate-100 mt-1"
              >
                Clear override
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// P.4 — surface how stale the cached schema is for the active
// channel. Bands: < 24h (fresh, grey), < 7d (ok, slate), >= 7d
// (amber, suggest refresh).
export function SchemaAgeIndicator({
  fetchedAt,
  schemaVersion,
  channelKey,
}: {
  fetchedAt: string | undefined
  schemaVersion: string | undefined
  channelKey: string
}) {
  if (!fetchedAt) {
    return (
      <div className="mt-2 text-xs text-slate-400 px-1">
        Schema for <span className="font-mono">{channelKey}</span>: not yet
        fetched
      </div>
    )
  }
  const age = Date.now() - new Date(fetchedAt).getTime()
  const days = age / (1000 * 60 * 60 * 24)
  let tone = 'text-slate-500'
  let label = ''
  if (days < 1) {
    label = `fetched ${Math.max(1, Math.round(age / (1000 * 60 * 60)))}h ago`
    tone = 'text-slate-500'
  } else if (days < 7) {
    label = `fetched ${Math.round(days)}d ago`
    tone = 'text-slate-500'
  } else {
    label = `fetched ${Math.round(days)}d ago — consider refreshing`
    tone = 'text-amber-700'
  }
  return (
    <div className={cn('mt-2 text-xs px-1', tone)}>
      Schema for <span className="font-mono">{channelKey}</span>: {label}
      {schemaVersion && (
        <span className="ml-1 text-slate-400">· version {schemaVersion}</span>
      )}
    </div>
  )
}

// N.3 — broadcast a per-variant value to other variants in one click.
export function VariantBroadcastMenu({
  variantId,
  variations,
  otherFilledIds,
  variantValues,
  onBroadcast,
}: {
  variantId: string
  variations: UnionVariation[]
  otherFilledIds: string[]
  variantValues: Record<string, Primitive | undefined>
  onBroadcast: (targetIds: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const otherIds = variations
    .filter((v) => v.id !== variantId)
    .map((v) => v.id)
  const emptyOtherIds = otherIds.filter((id) => isEmpty(variantValues[id]))
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title="Apply this value to other variants"
        aria-label="Apply this value to other variants"
        className="h-7 w-7 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
      >
        <span className="text-lg leading-none">⋯</span>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-slate-200 rounded shadow-md py-1 min-w-[200px] text-base">
            <div className="px-3 py-0.5 text-xs uppercase tracking-wide text-slate-400">
              Apply this value to
            </div>
            <button
              type="button"
              onClick={() => {
                onBroadcast(otherIds)
                setOpen(false)
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
            >
              All other variants{' '}
              <span className="text-xs text-slate-500">
                ({otherIds.length})
              </span>
            </button>
            {emptyOtherIds.length > 0 &&
              emptyOtherIds.length !== otherIds.length && (
                <button
                  type="button"
                  onClick={() => {
                    onBroadcast(emptyOtherIds)
                    setOpen(false)
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
                >
                  Empty variants only{' '}
                  <span className="text-xs text-slate-500">
                    ({emptyOtherIds.length})
                  </span>
                </button>
              )}
            {otherFilledIds.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  onBroadcast(otherFilledIds)
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700"
              >
                Other variants with values{' '}
                <span className="text-xs text-slate-500">
                  ({otherFilledIds.length})
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
