import { PACKAGING_KINDS, PACKAGING_NAME_MAX, PALLET_KINDS, packagingTypeProblems, type PackagingKind, type PalletKind } from '@nexus/factory-domain/shipping/packaging/rules'
import { words, type Read, type Words } from '../../shipments/queue/shared/depth'
import type { DispatchAbilities } from '../../shipments/pickup/dispatch'
import type { PackagingDefault, PackagingType, PickItem, TypeBody } from './api'

/**
 * Packaging, pure (SCR-657; design warehouse.shipping sec sp-packaging "Carton and pallet types (LOG-008)": "name · inner size
 * · tare · max weight · pallet type · default per style or size run"): the type's form and its problems in this screen's words
 * (the domain's own rules, factory-domain shipping/packaging/rules.ts, read by field), the bodies, what holds each action.
 */

export { PACKAGING_KINDS, PACKAGING_NAME_MAX, PALLET_KINDS }

export interface TypeForm {
  readonly kind: PackagingKind
  readonly name: string
  readonly length: string
  readonly width: string
  readonly height: string
  readonly tare: string
  readonly maxWeight: string
  readonly palletKind: PalletKind | ''
  /** Cost grain only. */
  readonly cost: string
  readonly currency: string
}

export type TypeField = 'name' | 'length' | 'width' | 'height' | 'tare' | 'maxWeight' | 'palletKind' | 'cost'

const FIELD_OF: Readonly<Record<string, TypeField>> = { name: 'name', innerLengthCm: 'length', innerWidthCm: 'width', innerHeightCm: 'height', tareKg: 'tare', maxWeightKg: 'maxWeight', palletKind: 'palletKind', costPerUnit: 'cost', costCurrency: 'cost' }

const decimal = (value: string): string | null => (value.trim() === '' ? null : value.trim().replace(',', '.'))

export function typeFormOf(type: PackagingType | null, kind: PackagingKind = 'CARTON', currency = 'EUR'): TypeForm {
  return {
    kind: type?.kind ?? kind,
    name: type?.name ?? '',
    length: type?.innerLengthCm ?? '',
    width: type?.innerWidthCm ?? '',
    height: type?.innerHeightCm ?? '',
    tare: type?.tareKg ?? '',
    maxWeight: type?.maxWeightKg ?? '',
    palletKind: type?.palletKind ?? (kind === 'PALLET' ? 'EUR' : ''),
    cost: type?.cost?.perUnit ?? '',
    currency: type?.cost?.currency ?? currency,
  }
}

/** Every problem of the form, by field, in this screen's words (the domain's own rules). */
export function typeProblems(form: TypeForm, withCost: boolean): Partial<Record<TypeField, Words>> {
  const issues = packagingTypeProblems(form.kind, {
    name: form.name,
    innerLengthCm: decimal(form.length),
    innerWidthCm: decimal(form.width),
    innerHeightCm: decimal(form.height),
    tareKg: decimal(form.tare),
    maxWeightKg: decimal(form.maxWeight),
    palletKind: form.kind === 'PALLET' ? (form.palletKind || null) : null,
    costPerUnit: withCost ? decimal(form.cost) : null,
    costCurrency: withCost && decimal(form.cost) ? form.currency.trim().toUpperCase() : null,
  })
  const problems: Partial<Record<TypeField, Words>> = {}
  for (const issue of issues) {
    const field = FIELD_OF[issue.path.split('/').pop() ?? '']
    if (field && !problems[field]) problems[field] = words(`packaging.problem.${field}`, { max: PACKAGING_NAME_MAX })
  }
  return problems
}

/** The body of a new type, or of a change (every field sent: null clears it; the cost only with the cost grain). */
export function typeBody(form: TypeForm, withCost: boolean): TypeBody {
  return {
    name: form.name.trim(),
    innerLengthCm: decimal(form.length),
    innerWidthCm: decimal(form.width),
    innerHeightCm: decimal(form.height),
    tareKg: decimal(form.tare),
    maxWeightKg: decimal(form.maxWeight),
    palletKind: form.kind === 'PALLET' ? (form.palletKind || null) : null,
    ...(withCost ? { cost: decimal(form.cost) ? { perUnit: decimal(form.cost)!, currency: form.currency.trim().toUpperCase() } : null } : {}),
  }
}

/** Why a packaging write is held (null: it may be made). */
export function manageHeld(can: Pick<DispatchAbilities, 'packaging'>, busy: boolean): Words | null {
  if (!can.packaging) return words('packaging.held.noRight')
  if (busy) return words('packaging.held.busy')
  return null
}

/** The inner size in words ("60 × 40 × 30 cm"), or null. */
export function innerSize(type: Pick<PackagingType, 'innerLengthCm' | 'innerWidthCm' | 'innerHeightCm'>, locale: string): string | null {
  if (!type.innerLengthCm || !type.innerWidthCm || !type.innerHeightCm) return null
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  return [type.innerLengthCm, type.innerWidthCm, type.innerHeightCm].map((value) => number.format(Number(value))).join(' × ')
}

/** A default's scope in words: the style, the size scale and its run. */
export function scopeOf(row: PackagingDefault): Words {
  if (row.style && row.sizeScale && row.fromSize) return words('packaging.scope.styleRun', { style: row.style.code, scale: row.sizeScale.code, from: row.fromSize, to: row.toSize ?? '' })
  if (row.style) return words('packaging.scope.style', { style: row.style.code, name: row.style.name })
  if (row.sizeScale && row.fromSize) return words('packaging.scope.run', { scale: row.sizeScale.code, from: row.fromSize, to: row.toSize ?? '' })
  return words('packaging.scope.scale', { scale: row.sizeScale?.code ?? '—' })
}

export interface DefaultForm {
  readonly packagingTypeId: string
  readonly styleId: string
  readonly sizeScaleId: string
  readonly fromSize: string
  readonly toSize: string
}

/** A new default's problem in words (the domain's rule: a style or a scale; a run both ends and its scale). */
export function defaultProblem(form: DefaultForm): Words | null {
  if (!form.packagingTypeId) return words('packaging.problem.type')
  if (!form.styleId && !form.sizeScaleId) return words('packaging.problem.scope')
  if ((form.fromSize.trim() === '') !== (form.toSize.trim() === '')) return words('packaging.problem.run')
  if (form.fromSize.trim() !== '' && !form.sizeScaleId) return words('packaging.problem.runScale')
  return null
}

export type PackagingDialog =
  | null
  | { readonly kind: 'type'; readonly typeId: string | null; readonly form: TypeForm; readonly tried: boolean }
  | { readonly kind: 'default'; readonly form: DefaultForm }
  | { readonly kind: 'defaultType'; readonly defaultId: string; readonly packagingTypeId: string }
  | { readonly kind: 'active'; readonly target: 'types' | 'defaults'; readonly ids: readonly string[]; readonly active: boolean }

export interface PackagingModel {
  readonly types: Read<readonly PackagingType[]>
  readonly defaults: Read<readonly PackagingDefault[]>
  /** B-W2b-F56: `view` (shipping.view) is what the types and defaults are read with; without it the card says so and reads nothing. */
  readonly can: Pick<DispatchAbilities, 'view' | 'packaging' | 'cost'>
  readonly dialog: PackagingDialog
  /** The styles and size scales a new default may name (read when its dialog opens). */
  readonly picks: Read<{ readonly styles: readonly PickItem[]; readonly scales: readonly PickItem[] }> | null
  readonly busy: boolean
  readonly problem: Words | null
  readonly done: Words | null
  /** Design cases: the starting selection of the types list. */
  readonly selected?: readonly string[]
}

export interface PackagingActions {
  onDialog?: (dialog: PackagingDialog) => void
  onGo?: () => void
  onRetry?: () => void
  onDismiss?: () => void
}
