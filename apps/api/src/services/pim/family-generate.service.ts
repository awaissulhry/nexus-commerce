/**
 * VP.2 — "Generate combinations": the Cartesian product of the chosen axis values, minus what already exists.
 *
 * Spec `docs/2026-09-11-variants-page-spec.md` §3.4; FINAL contract `docs/vp2-contracts.md` §5.
 *
 * The whole design is a dry run followed by a commit of the SAME plan. The modal's summary box is literally
 * the dry run's answer, so an operator never reads a count the server did not compute — and the run that
 * creates rows walks the same function with `dryRun: false`.
 *
 * Two rules are load-bearing and are enforced here rather than in the route:
 *
 *  1. **A SKU collision refuses by NAME and never renames.** An operator who asked for `GALE-JACKET-RED-M`
 *     and silently got `GALE-JACKET-RED-M-2` has a catalogue they can no longer reason about, and the second
 *     SKU will be discovered by a channel, not by a person.
 *  2. **The whole run refuses, or the whole run commits.** A partially created family is the state nobody can
 *     clean up, because it looks exactly like a family someone half-built on purpose.
 */
import prisma from '../../db.js'
import { createHash } from 'node:crypto'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { ProductRelationshipError, relationshipTransaction } from './product-relationship.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { resolveFamilyRoot, buildFamilyAxes, axisValuesOf, FAMILY_MEMBER_SELECT, type FamilyAxis } from './family-projection.service.js'

export interface GenerateInput {
  productId: string
  /** The PARENT's `Product.version`, as the family read reported it. */
  version: number
  /** Axis key to the value codes to include, IN the order the operator arranged them. */
  axisValues: Record<string, string[]>
  skuPattern: string
  valueCodes?: Record<string, Record<string, string>>
  copyFrom?: 'nearest-sibling'
  dryRun: boolean
  previewToken?: string
}

export interface GeneratePlanRow {
  sku: string
  axisValues: Record<string, string>
  copiesFrom: { id: string; sku: string } | null
}

export interface GenerateSkipped {
  axisValues: Record<string, string>
  reason: 'exists' | 'sku_collision'
  sku?: string
  existingSku?: string
}

/**
 * A value whose generated code does NOT appear in the SKUs of the siblings that already carry it.
 *
 * 🔴 Why this exists. Spec §3.4's preview line reads `Codes: Nero → BLACK`, and nothing in this system can
 * produce that: `FieldValueMap` — the one value-mapping store — holds **0 rows** (measured 2026-09-11), and
 * `SizeScaleMap`'s 23 rows are EU-to-alpha size conversion, not colour codes. So `{axis.code}` uppercases the
 * value (`Nero → NERO`) because there is nothing else to derive from, while this family's existing SKUs say
 * `BLACK`. Generating would silently mix two conventions in one family.
 *
 * Inferring `BLACK` from sibling SKU text is exactly the guess this lane refuses elsewhere, and VP.3 measured
 * the cost of that class of inference on the same family within the hour. So the mismatch is REPORTED, with
 * the sibling that proves it, and the operator edits the pattern.
 */
export interface SkuConventionWarning {
  axisKey: string
  value: string
  /** What `{axis.code}` produces for it. */
  code: string
  /** A sibling that already carries this value and whose SKU does not contain that code. */
  exampleSku: string
}

export interface GenerateDryRun {
  dryRun: true
  previewToken: string
  plan: GeneratePlanRow[]
  skipped: GenerateSkipped[]
  counts: { combinations: number; existing: number; willCreate: number }
  /** Every axis VALUE this run would introduce — the modal's tinted "new" tags. */
  newValues: Record<string, string[]>
  /** Empty when every code matches how the family already spells it. Never blocks; it informs. */
  skuConventionWarnings: SkuConventionWarning[]
  /**
   * Spec §3.4's `Codes: Nero → BLACK` line, SERVER-STATED — axis key → value → the code `{axis.code}` produces.
   *
   * It exists so the dialog never computes a code of its own. A preview that renders one SKU while Create
   * produces another is a preview that lies, and a label on it mitigates rather than removes that. Every
   * string in the preview now has one author: `plan[].sku` for the SKUs, this for the codes line.
   * Present only for axes whose `.code` token is actually in the pattern.
   */
  codes: Record<string, Record<string, string>>
}

export interface GenerateResult {
  dryRun: false
  created: Array<{ id: string; sku: string }>
  version: number
}

export class SkuCollisionError extends Error {
  readonly code = 'sku_collision'
  readonly statusCode = 409
  constructor(readonly collisions: Array<{ sku: string; existingProductId: string }>) {
    super(
      collisions.length === 1
        ? `The SKU ${collisions[0].sku} already exists. Change the pattern — this never renames a SKU for you.`
        : `${collisions.length} of these SKUs already exist (${collisions.slice(0, 3).map((c) => c.sku).join(', ')}${collisions.length > 3 ? ', …' : ''}). Change the pattern — this never renames a SKU for you.`,
    )
    this.name = 'SkuCollisionError'
  }
}

export class GenerateRequestError extends Error {
  readonly code = 'bad_generate_request'
  readonly statusCode = 400
  constructor(message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'GenerateRequestError'
  }
}

/**
 * `{<axis>.code}` — the value as a SKU-safe short code.
 *
 * Uppercased, accents folded, every run of non-alphanumerics collapsed to one dash, edges trimmed. `Nero`
 * becomes `NERO`, `Taglia unica` becomes `TAGLIA-UNICA`, `42.5` becomes `42-5`. The preview line in the modal
 * shows the result before anything is created, so the operator judges the codes rather than trusting them.
 */
export function skuCode(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const TOKEN = /\{([^{}]+)\}/g

/**
 * Render one SKU from the pattern. An UNKNOWN token is refused by name rather than left in the string: a SKU
 * containing a literal `{colour}` would be created, accepted and then found on a marketplace.
 */
export function renderSku(pattern: string, parentSku: string, values: Record<string, string>, axes: FamilyAxis[], codes: Record<string, Record<string, string>> = {}): string {
  const byCanonical = new Map(axes.map((axis) => [canonicalVariantAxis(axis.key), axis.key]))
  const unknown: string[] = []
  const out = pattern.replace(TOKEN, (_match, rawToken: string) => {
    const token = String(rawToken).trim()
    if (token.toLowerCase() === 'parent') return parentSku
    const isCode = token.toLowerCase().endsWith('.code')
    const name = isCode ? token.slice(0, -'.code'.length) : token
    const axisKey = byCanonical.get(canonicalVariantAxis(name))
    if (!axisKey) { unknown.push(token); return '' }
    const value = values[axisKey] ?? ''
    return isCode ? codes[axisKey]?.[value] ?? skuCode(value) : value
  })
  if (unknown.length > 0) {
    throw new GenerateRequestError(
      `The SKU pattern uses ${unknown.map((t) => `{${t}}`).join(', ')}, which ${unknown.length === 1 ? 'is not an axis of this family' : 'are not axes of this family'}.`,
      { unknownTokens: unknown, axes: axes.map((axis) => axis.key) },
    )
  }
  return out.trim()
}

/**
 * The sibling a new combination copies its title, price and stock from: the existing child that shares the
 * MOST axis values with it. Ties break by axis order (a match on the first axis is worth more than a match on
 * the second), then by SKU, so the same tuple always picks the same sibling and a dry run predicts the commit.
 */
export function nearestSibling(
  target: Record<string, string>,
  siblings: Array<{ id: string; sku: string; values: Record<string, string> }>,
  axes: FamilyAxis[],
): { id: string; sku: string } | null {
  let best: { id: string; sku: string; score: number } | null = null
  for (const sibling of siblings) {
    let score = 0
    axes.forEach((axis, index) => {
      if (sibling.values[axis.key] && sibling.values[axis.key] === target[axis.key]) score += axes.length - index
    })
    if (score === 0) continue
    if (!best || score > best.score || (score === best.score && sibling.sku < best.sku)) {
      best = { id: sibling.id, sku: sibling.sku, score }
    }
  }
  if (best) return { id: best.id, sku: best.sku }
  // No axis value in common with anyone: fall back to the lowest SKU, so "copy from the nearest sibling" still
  // means a real row rather than an empty record the operator has to fill from nothing.
  const first = [...siblings].sort((a, b) => a.sku.localeCompare(b.sku))[0]
  return first ? { id: first.id, sku: first.sku } : null
}

export async function generateCombinations(input: GenerateInput): Promise<GenerateDryRun | GenerateResult> {
  const root = await resolveFamilyRoot(input.productId)
  if (!Number.isSafeInteger(input.version) || input.version < 0) {
    throw new GenerateRequestError('A family version is required.')
  }
  if (typeof input.skuPattern !== 'string' || !input.skuPattern.trim()) {
    throw new GenerateRequestError('A SKU pattern is required, for example {parent}-{Colore.code}-{Taglia.code}.')
  }
  if (!input.axisValues || typeof input.axisValues !== 'object' || Array.isArray(input.axisValues)) {
    throw new GenerateRequestError('Send the values to combine, keyed by axis.')
  }

  const children = await prisma.product.findMany({
    where: { parentId: root.id, deletedAt: null },
    select: FAMILY_MEMBER_SELECT,
    orderBy: { sku: 'asc' },
  })
  const parentRow = await prisma.product.findUniqueOrThrow({ where: { id: root.id }, select: FAMILY_MEMBER_SELECT })
  const previewToken = createHash('sha256').update(JSON.stringify({ parent: parentRow, children, axisValues: input.axisValues, skuPattern: input.skuPattern, valueCodes: input.valueCodes ?? {} })).digest('hex')
  if (!input.dryRun && input.previewToken !== previewToken) throw new ProductRelationshipError('This family or plan changed after preview. Check the combinations again before creating.')
  const declared = (root.variationAxes ?? []) as string[]
  const axes = buildFamilyAxes(declared, [parentRow, ...children])
  if (axes.length === 0) {
    throw new GenerateRequestError('This family has no axes yet. Add an axis before generating combinations.')
  }

  for (const key of Object.keys(input.axisValues)) {
    if (!axes.some((axis) => axis.key === key)) {
      throw new GenerateRequestError(`"${key}" is not an axis of this family.`, { axes: axes.map((axis) => axis.key) })
    }
  }
  if (input.valueCodes !== undefined) {
    if (!input.valueCodes || typeof input.valueCodes !== 'object' || Array.isArray(input.valueCodes)) throw new GenerateRequestError('Value codes must be keyed by axis and value.')
    for (const [axis, values] of Object.entries(input.valueCodes)) {
      if (!axes.some(a => a.key === axis) || !values || typeof values !== 'object' || Array.isArray(values)) throw new GenerateRequestError(`Invalid value codes for ${axis}.`)
      for (const code of Object.values(values)) if (typeof code !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(code)) throw new GenerateRequestError('SKU codes must contain 1–64 letters, numbers, dots, underscores or hyphens.')
    }
  }
  const chosen = axes.map((axis) => {
    const raw = input.axisValues[axis.key]
    const values = Array.isArray(raw) ? raw.map((v) => String(v).trim()).filter(Boolean) : []
    if (values.length === 0) {
      throw new GenerateRequestError(`Choose at least one value for ${axis.key}.`, { axisKey: axis.key })
    }
    const unique = [...new Set(values)]
    if (unique.length !== values.length) {
      throw new GenerateRequestError(`${axis.key} has the same value twice.`, { axisKey: axis.key })
    }
    return { axis, values: unique }
  })

  const combinations = chosen.reduce((n, entry) => n * entry.values.length, 1)
  if (combinations > 2000) {
    throw new GenerateRequestError(
      `That is ${combinations} combinations. Generate at most 2000 in one run so the result stays reviewable.`,
      { combinations },
    )
  }

  // Existing tuples, read through the SAME union-of-stores derivation the family read uses, so "20 exist" here
  // and "20 of 20 combinations exist" in the band are the same sentence about the same data.
  const siblings = children.map((child) => ({ id: child.id, sku: child.sku, values: axisValuesOf(child, undefined, axes).values }))
  // JSON, not a joined string: two values containing a space would otherwise produce the same key
  // (`['Nero A','B']` and `['Nero','A B']` both join to "Nero A B"), and the collision would read as a
  // combination that already exists.
  const tupleKey = (values: Record<string, string>) => JSON.stringify(axes.map((axis) => values[axis.key] ?? ''))
  const existingTuples = new Set(siblings.filter((s) => axes.every((axis) => s.values[axis.key])).map((s) => tupleKey(s.values)))

  const existingValues = new Map(axes.map((axis) => [axis.key, new Set(siblings.map((s) => s.values[axis.key]).filter(Boolean))]))
  const newValues: Record<string, string[]> = {}
  for (const entry of chosen) {
    const known = existingValues.get(entry.axis.key) ?? new Set<string>()
    const fresh = entry.values.filter((value) => !known.has(value))
    if (fresh.length > 0) newValues[entry.axis.key] = fresh
  }

  // Every tuple, in axis order, first axis varying slowest — the order the modal previews and the order rows
  // are created in, so the preview's "first new SKU" is genuinely the first one created.
  const tuples: Array<Record<string, string>> = []
  const walk = (index: number, acc: Record<string, string>) => {
    if (index === chosen.length) { tuples.push({ ...acc }); return }
    for (const value of chosen[index].values) walk(index + 1, { ...acc, [chosen[index].axis.key]: value })
  }
  walk(0, {})

  const plan: GeneratePlanRow[] = []
  const skipped: GenerateSkipped[] = []
  const wantedSkus: string[] = []
  for (const values of tuples) {
    if (existingTuples.has(tupleKey(values))) { skipped.push({ axisValues: values, reason: 'exists' }); continue }
    const sku = renderSku(input.skuPattern, root.sku, values, axes, input.valueCodes)
    if (!sku) throw new GenerateRequestError('The SKU pattern produced an empty SKU. Add {parent} or an axis token.')
    plan.push({ sku, axisValues: values, copiesFrom: nearestSibling(values, siblings, axes) })
    wantedSkus.push(sku)
  }

  // Collisions, against the WHOLE catalogue rather than the family: a SKU is unique platform-wide, and a
  // collision with a product in another family is exactly the one an operator cannot see from this page.
  const duplicateInRun = wantedSkus.filter((sku, index) => wantedSkus.indexOf(sku) !== index)
  const taken = wantedSkus.length > 0
    ? await prisma.product.findMany({ where: { sku: { in: wantedSkus } }, select: { id: true, sku: true } })
    : []
  const collisions = [
    ...taken.map((row) => ({ sku: row.sku, existingProductId: row.id })),
    ...[...new Set(duplicateInRun)].map((sku) => ({ sku, existingProductId: '(twice in this run)' })),
  ]

  // Does the code we would generate match how this family already spells that value in its SKUs? Checked only
  // for values a sibling ALREADY carries, because those are the only ones with evidence to check against.
  // Which axes does the pattern actually take a CODE for? Derived ONCE and used by both the warnings and the
  // codes map. Warning about an axis whose token is absent describes a code that will never appear in any
  // generated SKU — noise dressed as a finding, and caught by the positive control that expected silence.
  const codedAxesForPattern = new Set<string>()
  for (const [, rawToken] of input.skuPattern.matchAll(/\{([^{}]+)\}/g)) {
    const token = String(rawToken).trim()
    if (!token.toLowerCase().endsWith('.code')) continue
    const name = token.slice(0, -'.code'.length)
    const hit = axes.find((axis) => canonicalVariantAxis(axis.key) === canonicalVariantAxis(name))
    if (hit) codedAxesForPattern.add(hit.key)
  }

  const skuConventionWarnings: SkuConventionWarning[] = []
  if (codedAxesForPattern.size > 0) {
    for (const entry of chosen) {
      if (!codedAxesForPattern.has(entry.axis.key)) continue
      for (const value of entry.values) {
        const carriers = siblings.filter((sib) => sib.values[entry.axis.key] === value)
        if (carriers.length === 0) continue
        const code = input.valueCodes?.[entry.axis.key]?.[value] ?? skuCode(value)
        if (!code) continue
        const matches = carriers.some((sib) => sib.sku.toUpperCase().includes(code))
        if (!matches) {
          skuConventionWarnings.push({ axisKey: entry.axis.key, value, code, exampleSku: carriers[0].sku })
        }
      }
    }
  }

  const codes: Record<string, Record<string, string>> = {}
  for (const entry of chosen) {
    if (!codedAxesForPattern.has(entry.axis.key)) continue
    codes[entry.axis.key] = Object.fromEntries(entry.values.map((value) => [value, input.valueCodes?.[entry.axis.key]?.[value] ?? skuCode(value)]))
  }

  if (input.dryRun) {
    const collidingSkus = new Set(collisions.map((c) => c.sku))
    const clean = plan.filter((row) => !collidingSkus.has(row.sku))
    for (const row of plan) {
      if (collidingSkus.has(row.sku)) {
        skipped.push({
          axisValues: row.axisValues,
          reason: 'sku_collision',
          sku: row.sku,
          existingSku: row.sku,
        })
      }
    }
    return {
      dryRun: true,
      previewToken,
      plan: clean,
      skipped,
      counts: { combinations, existing: existingTuples.size, willCreate: clean.length },
      newValues,
      skuConventionWarnings,
      codes,
    }
  }

  if (collisions.length > 0) throw new SkuCollisionError(collisions)
  if (plan.length === 0) {
    throw new GenerateRequestError('Every combination in this run already exists. Nothing would be created.')
  }

  const sourceById = new Map(children.map((child) => [child.id, child]))

  const created = await relationshipTransaction(async (tx) => {
    const fresh = await tx.product.findFirst({
      where: { id: root.id, deletedAt: null, parentId: null },
      select: { version: true, sku: true },
    })
    if (!fresh || fresh.version !== input.version) {
      throw new ProductRelationshipError('This family changed after you reviewed it. Reload it and generate again.')
    }
    const freshChildren = await tx.product.findMany({ where: { parentId: root.id, deletedAt: null }, select: FAMILY_MEMBER_SELECT, orderBy: { sku: 'asc' } })
    if (JSON.stringify(freshChildren) !== JSON.stringify(children)) throw new ProductRelationshipError('A variant changed after preview. Check the combinations again before creating.')
    // Re-checked INSIDE the transaction: a sibling session could have taken one of these SKUs between the dry
    // run and this commit, and the unique index would then fail the insert with a message about a constraint
    // rather than about the SKU an operator chose.
    const late = await tx.product.findMany({ where: { sku: { in: wantedSkus } }, select: { id: true, sku: true } })
    if (late.length > 0) throw new SkuCollisionError(late.map((row) => ({ sku: row.sku, existingProductId: row.id })))

    const out: Array<{ id: string; sku: string }> = []
    for (const row of plan) {
      const source = row.copiesFrom ? sourceById.get(row.copiesFrom.id) ?? null : null
      // Axis values are written the way the EXISTING "Add a child" verb writes them
      // (`product-relationship.service.ts:59-64`): both the legacy bag and `categoryAttributes.variations`.
      // One writer's shape, not a second one — the eBay push reads `variations`, and the sheet reads the bag.
      const axisPairs: Record<string, string> = {}
      for (const axis of axes) {
        const value = row.axisValues[axis.key]
        if (value) axisPairs[axis.storedKey] = value
      }
      const sourceCategory = (source?.categoryAttributes ?? {}) as Record<string, unknown>
      const copiedCategory = { ...sourceCategory }
      for (const [key, value] of Object.entries(axisPairs)) {
        const canonical = canonicalVariantAxis(key)
        for (const existing of Object.keys(copiedCategory)) if (canonicalVariantAxis(existing) === canonical) copiedCategory[existing] = value
      }
      const child = await tx.product.create({
        data: {
          sku: row.sku,
          name: source?.name ?? parentRow.name ?? row.sku,
          parentId: root.id,
          isParent: false,
          // DRAFT, always: spec §3.4. A generated row is a proposal until someone looks at it, and a row born
          // ACTIVE is a row a channel can pick up before anyone has read it.
          status: 'DRAFT',
          productType: source?.productType ?? parentRow.productType ?? null,
          basePrice: source?.basePrice ?? parentRow.basePrice ?? null,
          totalStock: source?.totalStock ?? 0,
          variantAttributes: axisPairs as never,
          categoryAttributes: { ...copiedCategory, variations: axisPairs } as never,
        },
        select: { id: true, sku: true },
      })
      out.push(child)
    }
    await tx.product.update({ where: { id: root.id }, data: { isParent: true, version: { increment: 1 } } })
    const { productEventService } = await import('../product-event.service.js')
    await productEventService.emitTx(tx, {
      aggregateId: root.id,
      aggregateType: 'Product',
      eventType: 'PRODUCT_UPDATED',
      data: { generatedVariants: out.map((child) => child.sku) },
      metadata: { source: 'OPERATOR' },
    })
    await productReadCacheService.refreshInTransaction(tx, [root.id, ...out.map((child) => child.id)])
    return out
  })

  return { dryRun: false, created, version: input.version + 1 }
}
