import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CheckBody, CheckView } from '@nexus/factory-domain/product/options/contracts'
import {
  bomChanges,
  checkConfiguration,
  effectivePicks,
  effectWords,
  summariseEffects,
  type CheckOffer,
  type ChosenPick,
  type ConfigurationCheck,
  type EffectFacts,
  type EffectsSummary,
  type OptionGroupKind,
} from '@nexus/factory-domain/product/options/rules'
import type { CommandCaller } from '../../../core/command'
import type { RequestContext } from '../../../core/context'
import { readStyle } from '../styles/store'
import { contextOf, effectFactsOf, effectRefsOf, GROUP_COLUMNS, namesOf, OFFER_COLUMNS, readEffects, RULE_COLUMNS, ruleFactsOf, seesPrice, VALUE_COLUMNS, valueNames, type Db } from './store'

/**
 * THE check of a choice of options on a style (B-W2b-229; PRD-207, PRD-206, PRD-211, PRD-208), for W2b-5's configurator:
 *
 *   POST /product/styles/:styleId/options/check   {picks: [{valueId, text?}], revisionId?, useDefaults?}   product.styles.view
 *
 * `checkStyleOptions(db, styleId, picks)` reads the style's ACTIVE offers (their groups, what the style asks of each, their
 * values), the ACTIVE rules of those groups and the chosen values' effects, and answers factory-domain's `checkConfiguration`
 * (blocks and warnings in words, the values taken with the style's defaults), what the choice does (`summariseEffects`: BOM
 * effects, operations and minutes, the price surcharges — money.price — and "outside the certificate") and what it does to the
 * revision's lines (`bomChanges`). A read: nothing is written. A quote or an order line calls the same function in W2b-5.
 */

export interface StyleOptionsCheck {
  readonly check: ConfigurationCheck
  readonly effects: readonly EffectFacts[]
  readonly summary: EffectsSummary
}

/** The facts the check reads for a style (the ACTIVE offers, their values, the ACTIVE rules of their groups). */
export async function checkFactsOf(db: Db, styleId: string): Promise<{ offers: CheckOffer[]; rules: ReturnType<typeof ruleFactsOf>[]; otherValueIds: string[] }> {
  const offerRows = await db.styleOptionGroup.findMany({ where: { styleId, status: 'ACTIVE' }, select: OFFER_COLUMNS, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }] })
  const groupIds = offerRows.map((offer) => offer.groupId)
  const groups = new Map((groupIds.length === 0 ? [] : await db.optionGroup.findMany({ where: { id: { in: groupIds } }, select: GROUP_COLUMNS })).map((group) => [group.id, group]))
  const values = groupIds.length === 0 ? [] : await db.optionValue.findMany({ where: { groupId: { in: groupIds } }, select: VALUE_COLUMNS, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  const offers: CheckOffer[] = offerRows.flatMap((offer) => {
    const group = groups.get(offer.groupId)
    if (!group) return []
    return [
      {
        groupId: group.id,
        code: group.code,
        name: group.name,
        nameI18n: namesOf(group.nameI18n),
        kind: group.kind as OptionGroupKind,
        picks: effectivePicks(group, offer),
        defaultValueId: offer.defaultValueId,
        values: values
          .filter((value) => value.groupId === group.id)
          .map((value) => ({ id: value.id, code: value.code, name: value.name, nameI18n: namesOf(value.nameI18n), status: value.status, freeText: value.freeText, freeTextMaxLength: value.freeTextMaxLength, freeTextPattern: value.freeTextPattern })),
      },
    ]
  })
  const rules = (groupIds.length === 0 ? [] : await db.optionRule.findMany({ where: { groupId: { in: groupIds }, status: 'ACTIVE' }, select: RULE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(ruleFactsOf)
  const offered = new Set(values.map((value) => value.id))
  return { offers, rules, otherValueIds: [...new Set(rules.map((rule) => rule.otherValueId).filter((id) => !offered.has(id)))] }
}

/** THE check (W2b-5 calls it inside its quote or order line's command, or here in a read). */
export async function checkStyleOptions(db: Db, styleId: string, picks: readonly ChosenPick[], options: { readonly useDefaults?: boolean } = {}): Promise<StyleOptionsCheck> {
  const facts = await checkFactsOf(db, styleId)
  const others = await valueNames(db, facts.otherValueIds)
  const check = checkConfiguration({ offers: facts.offers, rules: facts.rules, picks, useDefaults: options.useDefaults ?? true, otherValues: [...others.values()] })
  const chosen = check.chosen.map((entry) => entry.valueId)
  const effects = (await readEffects(db, chosen)).map(effectFactsOf)
  return { check, effects, summary: summariseEffects(new Set(chosen), effects) }
}

/** The revision the BOM changes are read on: the one named (of the style), else the draft, else the released one. */
async function revisionFor(db: Db, styleId: string, revisionId: string | undefined) {
  if (revisionId !== undefined) {
    const row = isUuid(revisionId) ? await db.styleRevision.findFirst({ where: { id: revisionId, styleId }, select: { id: true, revision: true, status: true } }) : null
    if (!row) throw new NotFoundError('Revision not found.')
    return row
  }
  return (
    (await db.styleRevision.findFirst({ where: { styleId, status: 'DRAFT' }, select: { id: true, revision: true, status: true }, orderBy: { revision: 'desc' } })) ??
    (await db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED' }, select: { id: true, revision: true, status: true }, orderBy: { revision: 'desc' } }))
  )
}

export async function checkViewOf(db: Db, style: { readonly id: string; readonly code: string }, body: CheckBody, context: RequestContext): Promise<CheckView> {
  const { check, effects, summary } = await checkStyleOptions(db, style.id, body.picks, { useDefaults: body.useDefaults })
  const revision = await revisionFor(db, style.id, body.revisionId)
  const lines = revision ? await db.bomLine.findMany({ where: { revisionId: revision.id }, select: { id: true, seq: true, itemId: true, optionValueId: true } }) : []
  const changes = revision ? bomChanges(lines, new Set(check.chosen.map((entry) => entry.valueId)), effects) : null
  const refs = await effectRefsOf(db, [...effects, ...(changes?.replaced ?? []).map((entry) => ({ itemId: entry.itemId, targetItemId: null, operationId: null }))])
  const names = await valueNames(
    db,
    check.chosen.map((entry) => entry.valueId),
  )
  const ref = (effect: EffectFacts) => ({
    effectId: effect.id,
    valueId: effect.valueId,
    kind: effect.kind,
    words: {
      ...effectWords(effect, {
        item: effect.itemId ? (refs.items.get(effect.itemId)?.code ?? null) : null,
        target: effect.targetItemId ? (refs.items.get(effect.targetItemId)?.code ?? null) : null,
        operation: effect.operationId ? (refs.operations.get(effect.operationId)?.code ?? null) : null,
      }),
    },
  })
  const price = seesPrice(context)
  const notes: { it: string; en: string }[] = []
  const code = (itemId: string) => refs.items.get(itemId)?.code ?? '?'
  for (const clash of summary.clashes) notes.push({ it: `${clash.effectIds.length} opzioni cambiano lo stesso materiale ${code(clash.targetItemId)}.`, en: `${clash.effectIds.length} options change the same material ${code(clash.targetItemId)}.` })
  for (const missing of changes?.targetsMissing ?? []) notes.push({ it: `Nessuna riga della revisione usa ${code(missing.targetItemId)}: l'effetto non tocca niente.`, en: `No line of the revision takes ${code(missing.targetItemId)}: the effect changes nothing.` })
  for (const twice of changes?.definedTwice ?? []) notes.push({ it: `${code(twice.itemId)} è sia una riga per l'opzione sia un effetto della libreria: messo due volte.`, en: `${code(twice.itemId)} is both an option line and a library effect: put in twice.` })
  return {
    style: { id: style.id, code: style.code },
    ok: check.ok,
    blocks: check.blocks.map((finding) => ({ ...finding, message: { ...finding.message } })),
    warnings: check.warnings.map((finding) => ({ ...finding, message: { ...finding.message } })),
    chosen: check.chosen.map((entry) => ({ ...entry, code: names.get(entry.valueId)?.code ?? '?', groupCode: names.get(entry.valueId)?.group.code ?? '?' })),
    effects: {
      bom: [...summary.added, ...summary.replaced, ...summary.removed].map(ref),
      operations: summary.operations.map(ref),
      minutes: summary.minutes.map(ref),
      minutesAdded: summary.minutesAdded,
      operationsAtStandard: summary.operationsAtStandard,
      ...(price ? { price: asMoney('price', summary.price ? { byCurrency: summary.price.byCurrency.map((entry) => ({ ...entry })), percent: summary.price.percent } : null) } : {}),
      outsideCertificate: summary.outsideCertificate,
      certificateNotes: summary.certificateNotes.map((entry) => ({ ...entry })),
    },
    bom:
      revision && changes
        ? {
            revision: { ...revision },
            optionLinesTaken: [...changes.optionLinesTaken],
            optionLinesLeftOut: [...changes.optionLinesLeftOut],
            removed: changes.removed.map((entry) => ({ ...entry })),
            replaced: changes.replaced.map((entry) => ({ lineId: entry.lineId, seq: entry.seq, effectId: entry.effectId, item: { ...(refs.items.get(entry.itemId) ?? { id: entry.itemId, code: '?', name: '' }) } })),
            added: changes.added.map(ref),
            notes,
          }
        : null,
  }
}

/** POST /product/styles/:styleId/options/check */
export async function checkOptions(caller: CommandCaller, styleId: string, body: CheckBody): Promise<CheckView> {
  const style = await readStyle(caller, styleId)
  return caller.withClient((client) => checkViewOf(client, { id: style.id, code: style.code }, body, contextOf(caller)))
}
