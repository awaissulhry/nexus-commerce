/**
 * P6 (docs/attributes/PLAN.md §4.4) — everything one dropdown may offer, and where each value comes from.
 *
 * The open dropdown shows three sources, each labelled: the business's own options, the values of every channel the
 * attribute feeds (for the coordinates the caller is showing), and "use / save your own text" (the client). This
 * service answers the first two in one call: a value both the business and a channel have is ONE choice with two
 * sources (matched ignoring case and accents — `nero` and `Nero` are the same choice). `strictIn` names the channels
 * that accept only their own list, so the client can say "eBay IT will not accept this" next to a typed value.
 *
 * Reads only. A channel field feeds the attribute when its mapping rule's source IS the attribute (an operator rule,
 * a direct link or a concept link — the same rule publishing uses).
 */
import prisma from '../../db.js'
import { conceptFieldToken } from '@nexus/shared/attribute-concepts'
import { optionModeFrom, type OptionMode } from '@nexus/shared/attributes'
import { getFieldCatalogue } from './mapping/field-catalogue.service.js'

export interface ChoiceCoordinate { channel: string; marketplace: string; productType?: string | null }
export interface Choice {
  value: string
  label: string
  /** `business`, or a coordinate label such as `EBAY IT`. */
  sources: string[]
  /** Coordinates whose list is CLOSED and contains this value. */
  strictIn: string[]
  synonyms?: string[]
}
export interface AttributeChoices {
  attribute: { code: string; label: string; optionMode: OptionMode }
  choices: Choice[]
  channels: Array<{ coordinate: string; fieldKey: string; label: string; mode: OptionMode; options: number }>
  /** Coordinates that could not be read (no cached rules, unknown market) — said, never hidden. */
  unavailable: Array<{ coordinate: string; reason: string }>
}

export class ChoicesError extends Error {}

export async function attributeChoices(code: string, coordinates: ChoiceCoordinate[]): Promise<AttributeChoices> {
  const attribute = await prisma.customAttribute.findFirst({
    where: { code }, select: { code: true, label: true, validation: true, options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
  })
  if (!attribute) throw new ChoicesError(`attribute "${code}" not found`)
  const byToken = new Map<string, Choice>()
  const add = (value: string, label: string, source: string, strict: boolean, synonyms?: string[]) => {
    const token = conceptFieldToken(value) || value
    const existing = byToken.get(token)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
      if (strict && !existing.strictIn.includes(source)) existing.strictIn.push(source)
      return
    }
    byToken.set(token, { value, label, sources: [source], strictIn: strict ? [source] : [], ...(synonyms?.length ? { synonyms } : {}) })
  }
  for (const option of attribute.options) if (!option.archivedAt) add(option.code, option.label, 'business', false, option.synonyms)

  const channels: AttributeChoices['channels'] = []
  const unavailable: AttributeChoices['unavailable'] = []
  for (const coordinate of coordinates) {
    const label = `${coordinate.channel.toUpperCase()} ${coordinate.marketplace}`
    try {
      const catalogue = await getFieldCatalogue({ channel: coordinate.channel, marketplace: coordinate.marketplace, productType: coordinate.productType ?? null })
      for (const field of catalogue.fields) {
        if (field.rule?.source !== code || !field.options?.length) continue
        const mode: OptionMode = field.selectionOnly ? 'strict' : 'open'
        channels.push({ coordinate: label, fieldKey: field.fieldKey, label: field.label, mode, options: field.options.length })
        for (const option of field.options) add(option, field.optionLabels?.[option] ?? option, label, mode === 'strict')
      }
    } catch (error) {
      unavailable.push({ coordinate: label, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  const validation = attribute.validation && typeof attribute.validation === 'object' ? attribute.validation as Record<string, unknown> : {}
  return {
    attribute: { code: attribute.code, label: attribute.label, optionMode: optionModeFrom(validation.optionMode) ?? 'open' },
    choices: [...byToken.values()],
    channels,
    unavailable,
  }
}
