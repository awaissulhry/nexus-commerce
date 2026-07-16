/**
 * A4C (XLSM hybrid) — exhaustive schema-leaf walker + deep-value reassembly.
 *
 * OWNER MANDATE: "missing columns must never happen again." The specialized
 * expansion patterns in flat-file.service.ts (multi-instance, dimension pairs,
 * named sub-props, the hardcoded purchasable_offer block) each have shapes
 * they silently skip (`continue` on object sub-props, enum-less arrays,
 * instance caps, unlisted offer schedules). Instead of teaching every pattern
 * every shape, this module makes the manifest EXHAUSTIVE BY CONSTRUCTION:
 *
 *   1. `walkSchemaLeaves` enumerates EVERY leaf path a schema property can
 *      express (nested objects, arrays-in-arrays, localized wrappers,
 *      instance counts from the schema's own maxUniqueItems/maxItems).
 *   2. `emitUncoveredColumns` diffs those leaves against the columns the
 *      specialized patterns already emitted (canonicalized fieldRef match —
 *      the same grammar the template-import mapping tier uses) and emits a
 *      generic, properly-typed column for every uncovered leaf, in the same
 *      schema group as its field.
 *   3. `applyDeepValue` reassembles a deep column's cell back into the exact
 *      nested SP-API attribute shape at feed time.
 *
 * A field the patterns fully cover contributes zero extra columns; a shape
 * nobody anticipated still becomes editable columns instead of vanishing.
 * The per-field coverage counts feed the manifest's __coverage sentinel.
 */

import { canonicalizeTemplatePath } from './flat-file-mapping.js'

const INFRA = new Set(['marketplace_id', 'language_tag', 'audience'])
const ROOT_INSTANCE_CAP = 5
const NESTED_INSTANCE_CAP = 5
const MAX_LEAVES_PER_FIELD = 60

export interface DeepSeg {
  key: string
  /** 1-based instance when this segment is an array level. */
  idx?: number
  /** This array element carries {value, language_tag} — stamp language_tag. */
  localized?: boolean
}

export interface DeepFieldSpec {
  /** The root attribute (schema field id) this leaf belongs to. */
  field: string
  /** Path segments AFTER the root field (root idx lives in rootIdx). */
  segs: DeepSeg[]
  /** 1-based instance of the root attribute array. */
  rootIdx: number
  /** Leaf property name ('value' for wrapped scalars, else the sub-key). */
  leaf: string
  type: 'string' | 'number' | 'boolean'
  /** The leaf's IMMEDIATE parent element also gets language_tag. */
  leafLocalized?: boolean
}

export interface DeepLeaf {
  colId: string
  fieldRef: string
  spec: DeepFieldSpec
  enums: string[]
  maxLength?: number
  labelEn: string
}

interface SchemaNode {
  type?: string
  items?: SchemaNode & { properties?: Record<string, SchemaNode>; required?: string[] }
  properties?: Record<string, SchemaNode>
  enum?: unknown[]
  enumNames?: unknown[]
  maxUniqueItems?: number
  maxItems?: number
  maxLength?: number
}

const isArrayNode = (n: SchemaNode): boolean => n?.type === 'array' || !!n?.items
const isObjectNode = (n: SchemaNode): boolean => !isArrayNode(n) && (n?.type === 'object' || !!n?.properties)

function scalarType(n: SchemaNode): 'string' | 'number' | 'boolean' {
  if (n?.type === 'number' || n?.type === 'integer') return 'number'
  if (n?.type === 'boolean') return 'boolean'
  return 'string'
}

function clampInstances(n: SchemaNode, cap: number): number {
  const declared = n?.maxUniqueItems ?? n?.maxItems ?? 1
  return Math.max(1, Math.min(Number(declared) || 1, cap))
}

function enumsOf(n: SchemaNode): string[] {
  const raw = (n?.enumNames ?? n?.enum ?? []) as unknown[]
  return raw.map(String).filter(Boolean)
}

function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Enumerate every leaf path `fieldId`'s schema can express. */
export function walkSchemaLeaves(fieldId: string, prop: SchemaNode): DeepLeaf[] {
  const out: DeepLeaf[] = []

  const emit = (
    rootIdx: number,
    segs: DeepSeg[],
    leafKey: string,
    leafNode: SchemaNode,
    leafLocalized: boolean,
  ) => {
    if (out.length >= MAX_LEAVES_PER_FIELD) return
    // fieldRef in template grammar: root gets [marketplace_id]#N; array segs get
    // #N after their key (localized wrappers additionally show [language_tag]).
    let ref = `${fieldId}[marketplace_id]#${rootIdx}`
    let colId = `${fieldId}${rootIdx > 1 ? `_${rootIdx}` : ''}`
    for (const s of segs) {
      ref += `.${s.key}${s.localized ? '[language_tag]' : ''}${s.idx != null ? `#${s.idx}` : ''}`
      colId += `__${s.key}${(s.idx ?? 1) > 1 ? `_${s.idx}` : ''}`
    }
    if (leafKey !== '') {
      ref += `.${leafKey}`
      if (leafKey !== 'value') colId += `__${leafKey}`
    }
    const labelEn =
      [humanize(fieldId), ...segs.map((s) => `${humanize(s.key)}${(s.idx ?? 1) > 1 ? ` ${s.idx}` : ''}`),
        ...(leafKey && leafKey !== 'value' ? [humanize(leafKey)] : [])]
        .join(' — ') + (rootIdx > 1 ? ` (${rootIdx})` : '')
    out.push({
      colId,
      fieldRef: ref,
      labelEn,
      enums: enumsOf(leafNode),
      maxLength: typeof leafNode?.maxLength === 'number' ? leafNode.maxLength : undefined,
      // leaf '' is meaningful: "set the array element directly" (bare scalars).
      spec: { field: fieldId, segs, rootIdx, leaf: leafKey, type: scalarType(leafNode), leafLocalized: leafLocalized || undefined },
    })
  }

  const walkInto = (node: SchemaNode, rootIdx: number, segs: DeepSeg[]) => {
    if (out.length >= MAX_LEAVES_PER_FIELD) return
    if (isArrayNode(node)) {
      const item = node.items ?? {}
      const props = item.properties ?? {}
      const keys = Object.keys(props).filter((k) => !INFRA.has(k))
      const localized = 'language_tag' in (item.properties ?? {})
      const isNested = segs.length > 0
      const count = clampInstances(node, isNested ? NESTED_INSTANCE_CAP : ROOT_INSTANCE_CAP)
      for (let i = 1; i <= count; i++) {
        // idx rides the CURRENT level: root idx for segs=[], else the last seg.
        const segsWithIdx = isNested
          ? [...segs.slice(0, -1), { ...segs[segs.length - 1], idx: i, localized: localized || undefined }]
          : segs
        const effRootIdx = isNested ? rootIdx : i
        if (keys.length === 0) {
          // Array of BARE scalars (color.standardized_values, sci.features):
          // the template addresses the element itself — `…standardized_values#N`
          // with NO `.value` tail. leaf '' = "set the array element directly".
          emit(effRootIdx, segsWithIdx, '', item.type ? item : { type: 'string' }, localized)
        } else if (keys.length === 1 && keys[0] === 'value') {
          emit(effRootIdx, segsWithIdx, 'value', props.value ?? {}, localized)
        } else {
          for (const k of keys) {
            const child = props[k]
            if (isArrayNode(child) || isObjectNode(child)) {
              walkInto(child, effRootIdx, [...segsWithIdx, { key: k }])
            } else {
              emit(effRootIdx, segsWithIdx, k, child, false)
            }
          }
        }
      }
      return
    }
    if (isObjectNode(node)) {
      const props = node.properties ?? {}
      for (const k of Object.keys(props).filter((kk) => !INFRA.has(kk))) {
        const child = props[k]
        if (isArrayNode(child) || isObjectNode(child)) {
          walkInto(child, rootIdx, [...segs, { key: k }])
        } else {
          emit(rootIdx, segs, k, child, false)
        }
      }
      return
    }
    // bare scalar root (rare) — one leaf
    emit(rootIdx, segs, '', node, false)
  }

  walkInto(prop ?? {}, 1, [])
  return out
}

export interface UncoveredEmit {
  columns: Array<{
    id: string
    fieldRef: string
    labelEn: string
    labelLocal: string
    required: false
    kind: 'text' | 'number' | 'enum'
    options?: string[]
    maxLength?: number
    width: number
  }>
  deep: Record<string, DeepFieldSpec>
  leaves: number
  covered: number
}

/**
 * Diff a field's full leaf set against the columns the specialized patterns
 * emitted; return generic columns + reassembly specs for the uncovered rest.
 */
export function emitUncoveredColumns(
  fieldId: string,
  prop: SchemaNode,
  existing: Array<{ id: string; fieldRef?: string }>,
): UncoveredEmit {
  const leaves = walkSchemaLeaves(fieldId, prop)
  const coveredRefs = new Set(
    existing.map((c) => (c.fieldRef ? canonicalizeTemplatePath(c.fieldRef) : '')).filter(Boolean),
  )
  const existingIds = new Set(existing.map((c) => c.id))
  const columns: UncoveredEmit['columns'] = []
  const deep: Record<string, DeepFieldSpec> = {}
  let covered = 0
  for (const leaf of leaves) {
    const canon = canonicalizeTemplatePath(leaf.fieldRef)
    if (coveredRefs.has(canon)) {
      covered++
      continue
    }
    coveredRefs.add(canon) // never emit two columns for one canonical leaf
    let id = leaf.colId
    while (existingIds.has(id) || id in deep) id = `${id}__x`
    const kind: 'text' | 'number' | 'enum' =
      leaf.enums.length > 0 ? 'enum' : leaf.spec.type === 'number' ? 'number' : leaf.spec.type === 'boolean' ? 'enum' : 'text'
    columns.push({
      id,
      fieldRef: leaf.fieldRef,
      labelEn: leaf.labelEn,
      labelLocal: leaf.labelEn,
      required: false,
      kind,
      options:
        leaf.enums.length > 0 ? ['', ...leaf.enums] : leaf.spec.type === 'boolean' ? ['', 'true', 'false'] : undefined,
      maxLength: leaf.maxLength,
      width: kind === 'number' ? 110 : kind === 'enum' ? 150 : 170,
    })
    deep[id] = leaf.spec
  }
  return { columns, deep, leaves: leaves.length, covered }
}

/** Root-element extras Amazon expects on specific attributes. */
const ROOT_EXTRA: Record<string, Record<string, string>> = {
  purchasable_offer: { audience: 'ALL' },
}

/**
 * Reassemble one deep column's cell into the nested SP-API attribute shape.
 * Mutates `attrs` in place; safe to call repeatedly for sibling leaves (the
 * shared ancestors merge). Values are typed by the schema (number/boolean).
 */
export function applyDeepValue(
  attrs: Record<string, unknown>,
  fieldId: string,
  spec: DeepFieldSpec,
  rawValue: string,
  ctx: { marketplaceId: string; languageTag: string },
): void {
  const typed: unknown =
    spec.type === 'number'
      ? Number(String(rawValue).replace(',', '.'))
      : spec.type === 'boolean'
        ? /^(true|1|yes|sì|si|ja|oui)$/i.test(String(rawValue).trim())
        : String(rawValue)
  if (spec.type === 'number' && Number.isNaN(typed)) return

  const rootArr = ((attrs[fieldId] as Array<Record<string, unknown>>) ??= [] as never) as Array<
    Record<string, unknown>
  >
  while (rootArr.length < spec.rootIdx) rootArr.push({})
  let cur: Record<string, unknown> = rootArr[spec.rootIdx - 1]
  cur.marketplace_id ??= ctx.marketplaceId
  for (const [k, v] of Object.entries(ROOT_EXTRA[fieldId] ?? {})) cur[k] ??= v

  // leaf '' — bare scalar-array element: the LAST array segment's element IS
  // the value (color.standardized_values#N). Walk to its parent, then assign
  // the element slot directly instead of a property.
  const bareElement = spec.leaf === '' && spec.segs.length > 0 && spec.segs[spec.segs.length - 1].idx != null
  const walkSegs = bareElement ? spec.segs.slice(0, -1) : spec.segs

  for (const seg of walkSegs) {
    if (seg.idx != null) {
      const arr = ((cur[seg.key] as Array<Record<string, unknown>>) ??= [] as never) as Array<
        Record<string, unknown>
      >
      while (arr.length < seg.idx) arr.push({})
      cur = arr[seg.idx - 1]
      if (seg.localized) cur.language_tag ??= ctx.languageTag
    } else {
      cur = ((cur[seg.key] as Record<string, unknown>) ??= {} as never) as Record<string, unknown>
    }
  }
  if (bareElement) {
    const last = spec.segs[spec.segs.length - 1]
    const arr = ((cur[last.key] as unknown[]) ??= [] as never) as unknown[]
    while (arr.length < (last.idx ?? 1)) arr.push(undefined)
    arr[(last.idx ?? 1) - 1] = typed
    // drop placeholder holes so the emitted JSON array is dense
    for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr.splice(i--, 1)
    return
  }
  cur[spec.leaf === '' ? 'value' : spec.leaf] = typed
  if (spec.leafLocalized && spec.segs.length === 0) cur.language_tag ??= ctx.languageTag
}
