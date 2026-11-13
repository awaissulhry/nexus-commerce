import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { isPictureType } from '@nexus/factory-domain/product/images/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { brokenWords, effectivePicks, picksWords, ruleWords, type NameFacts } from '@nexus/factory-domain/product/options/rules'
import type { ConfiguratorStyleView } from '@nexus/factory-domain/sales/configurator/contracts'
import { CONFIGURATOR_LIMITS, type ValuePrice } from '@nexus/factory-domain/sales/configurator/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { mainPictures } from '../../product/images/main-picture'
import { readStyle } from '../../product/styles/store'
import { GROUP_COLUMNS, namesOf, OFFER_COLUMNS, RULE_COLUMNS, ruleFactsOf, VALUE_COLUMNS, valueNames, type Db } from '../../product/options/store'

/**
 * A style's configurator (B-W2b-340; SAL-136, SAL-139, SAL-249): what a quote or order line, or the people who keep the
 * options ("Test a combination" on Products › Options & rules), choose from —
 *
 *   groups     the style's ACTIVE offers in their order: each group's kind, what the style asks (picks), its default, its
 *              values (archived ones too, marked, so a line that chose one still names it) with the surcharge per value
 *              (the library's PRICE effect, money.price) and "outside the certificate" (a CERTIFICATE effect and its note),
 *              and the ACTIVE rules of the group in words (the preview, and what the person reads when it is broken)
 *   choices    the panel colours of the colour library (ACTIVE, the company's and every company's) and the leathers by
 *              article and colour (ACTIVE LEATHER materials and their ACTIVE colours) a choice may take (SAL-139)
 *   picture    the chosen colourway's first picture, else the style's main picture (B-W2b-236), shown through
 *              GET /product/pictures/:fileId (product.styles.view)
 *
 * A read: nothing is written.
 */

const text = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))

/** The PRICE effects of the values, as frozenSurcharges reads them. */
export async function valuePrices(db: Db, valueIds: readonly string[]): Promise<ValuePrice[]> {
  if (valueIds.length === 0) return []
  const rows = await db.optionEffect.findMany({ where: { valueId: { in: [...new Set(valueIds)] }, kind: 'PRICE' }, select: { valueId: true, priceDelta: true, currency: true, pricePct: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return rows.map((row) => ({ valueId: row.valueId, amount: text(row.priceDelta), currency: row.currency, pct: text(row.pricePct) }))
}

/** The picture of a colourway: its first (seq, then the oldest), else the style's main picture; a picture a browser shows. */
async function pictureOf(db: Db, styleId: string, colourwayId: string | null): Promise<ConfiguratorStyleView['picture']> {
  if (colourwayId !== null) {
    const own = await db.styleImage.findMany({ where: { styleId, colourwayId }, select: { fileId: true }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 10 })
    if (own.length > 0) {
      const files = await db.storedFile.findMany({ where: { id: { in: own.map((row) => row.fileId) }, status: 'AVAILABLE' }, select: { id: true, originalName: true, contentType: true } })
      const byId = new Map(files.map((file) => [file.id, file]))
      for (const row of own) {
        const file = byId.get(row.fileId)
        if (file && isPictureType(file.contentType)) return { fileId: file.id, name: file.originalName, contentType: file.contentType, source: 'COLOURWAY' }
      }
    }
  }
  const main = (await mainPictures(db, [styleId])).get(styleId)
  return main ? { fileId: main.fileId, name: main.name, contentType: main.contentType, source: 'STYLE' } : null
}

/** The panel colours and leathers a choice may take (the company's and every company's). */
async function choicesOf(db: Db, companyId: string | null): Promise<ConfiguratorStyleView['choices']> {
  const ofCompany = companyId === null ? [{ companyId: null }] : [{ companyId: null }, { companyId }]
  const colours = await db.colour.findMany({ where: { status: 'ACTIVE', OR: ofCompany }, select: { id: true, code: true, name: true, nameI18n: true, hex: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: CONFIGURATOR_LIMITS.colours })
  const leathers = await db.item.findMany({
    where: { kind: 'LEATHER', status: 'ACTIVE', OR: ofCompany },
    select: { id: true, code: true, name: true, colours: { where: { status: 'ACTIVE' }, select: { id: true, code: true, name: true, colour: { select: { hex: true } } }, orderBy: [{ code: 'asc' }, { id: 'asc' }] } },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
    take: CONFIGURATOR_LIMITS.leathers,
  })
  return {
    colours: colours.map((row) => ({ id: row.id, code: row.code, name: row.name, nameI18n: namesOf(row.nameI18n), hex: row.hex })),
    leathers: leathers.map((row) => ({ id: row.id, code: row.code, name: row.name, colours: row.colours.map((colour) => ({ id: colour.id, code: colour.code, name: colour.name, hex: colour.colour?.hex ?? null })) })),
  }
}

/** The configurator of a style, for a line of `companyId` in `colourway` (null: none chosen, the bench). */
export async function styleConfiguratorOf(
  db: Db,
  style: { readonly id: string; readonly code: string; readonly name: string; readonly companyId: string | null; readonly status: string },
  colourway: { readonly id: string; readonly code: string; readonly name: string } | null,
  companyId: string | null,
): Promise<ConfiguratorStyleView> {
  const offers = await db.styleOptionGroup.findMany({ where: { styleId: style.id, status: 'ACTIVE' }, select: OFFER_COLUMNS, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  const groupIds = offers.map((offer) => offer.groupId)
  const groups = new Map((groupIds.length === 0 ? [] : await db.optionGroup.findMany({ where: { id: { in: groupIds } }, select: GROUP_COLUMNS })).map((group) => [group.id, group]))
  const values = groupIds.length === 0 ? [] : await db.optionValue.findMany({ where: { groupId: { in: groupIds } }, select: VALUE_COLUMNS, orderBy: [{ seq: 'asc' }, { code: 'asc' }, { id: 'asc' }] })
  const effects = values.length === 0 ? [] : await db.optionEffect.findMany({ where: { valueId: { in: values.map((value) => value.id) }, kind: { in: ['PRICE', 'CERTIFICATE'] } }, select: { valueId: true, kind: true, priceDelta: true, currency: true, pricePct: true, note: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const rules = groupIds.length === 0 ? [] : await db.optionRule.findMany({ where: { groupId: { in: groupIds }, status: 'ACTIVE' }, select: RULE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const names = await valueNames(db, [...values.map((value) => value.id), ...rules.flatMap((rule) => [rule.otherValueId, ...(rule.valueId ? [rule.valueId] : [])])])
  const groupNames = new Map<string, NameFacts & { readonly code: string }>([...groups.values()].map((group) => [group.id, { code: group.code, name: group.name, nameI18n: namesOf(group.nameI18n) }]))
  const groupOf = (groupId: string) => groupNames.get(groupId) ?? [...names.values()].find((value) => value.groupId === groupId)?.group
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status },
    colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
    picture: await pictureOf(db, style.id, colourway?.id ?? null),
    groups: offers.flatMap((offer) => {
      const group = groups.get(offer.groupId)
      if (!group) return []
      const picks = effectivePicks(group, offer)
      return [
        {
          groupId: group.id,
          code: group.code,
          name: group.name,
          nameI18n: namesOf(group.nameI18n),
          kind: group.kind,
          minPicks: picks.minPicks,
          maxPicks: picks.maxPicks,
          picks: { ...picksWords(picks) },
          defaultValueId: offer.defaultValueId,
          values: values
            .filter((value) => value.groupId === group.id)
            .map((value) => {
              const price = effects.find((effect) => effect.valueId === value.id && effect.kind === 'PRICE')
              const certificate = effects.find((effect) => effect.valueId === value.id && effect.kind === 'CERTIFICATE')
              return {
                id: value.id,
                code: value.code,
                name: value.name,
                nameI18n: namesOf(value.nameI18n),
                status: value.status,
                freeText: value.freeText,
                freeTextMaxLength: value.freeTextMaxLength,
                freeTextPattern: value.freeTextPattern,
                outsideCertificate: certificate !== undefined,
                certificateNote: certificate?.note ?? null,
                surcharge: asMoney('price', price ? { delta: price.priceDelta === null ? null : text(price.priceDelta), currency: price.currency, percent: price.pricePct === null ? null : text(price.pricePct) } : null),
              }
            }),
          rules: rules
            .filter((rule) => rule.groupId === group.id)
            .map((rule) => {
              const facts = ruleFactsOf(rule)
              return {
                ruleId: rule.id,
                valueId: rule.valueId,
                kind: rule.kind,
                otherValueId: rule.otherValueId,
                severity: rule.severity,
                words: { ...ruleWords(facts, (id) => names.get(id), groupOf) },
                broken: { ...brokenWords(facts, (id) => names.get(id), groupOf) },
              }
            }),
          // B-W2b-374 (XF3:05): the picker a chosen value offers.
          takes: group.takes,
        },
      ]
    }),
    choices: await choicesOf(db, companyId),
  }
}

/** GET /sales/configurator/styles/:styleId (product.styles.view): the bench's read ("Test a combination"). */
export async function styleConfigurator(caller: CommandCaller, styleId: string, query: { readonly colourwayId?: string | undefined }) {
  const style = await readStyle(caller, styleId)
  return caller.withClient(async (db) => {
    const colourway = query.colourwayId ? (isUuid(query.colourwayId) ? await db.colourway.findFirst({ where: { id: query.colourwayId, styleId: style.id }, select: { id: true, code: true, name: true } }) : null) : null
    if (query.colourwayId && !colourway) throw new NotFoundError('Colourway not found.')
    const row = await db.style.findUniqueOrThrow({ where: { id: style.id }, select: { id: true, code: true, name: true, companyId: true, status: true } })
    return styleConfiguratorOf(db, row, colourway, row.companyId)
  })
}
