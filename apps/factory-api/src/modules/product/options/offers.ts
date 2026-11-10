import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { OfferBody, OfferView, StyleOptionsView, WithdrawBody } from '@nexus/factory-domain/product/options/contracts'
import { effectivePicks, offerPicksProblems, picksWords, type OptionGroupKind } from '@nexus/factory-domain/product/options/rules'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { requireEditRule } from '../lifecycle/edit-rule'
import { mayWrite } from '../materials/store'
import { assertMayWrite, lockStyle, readStyle } from '../styles/store'
import { contextOf, GROUP_COLUMNS, invalid, lockGroupShared, lockValuesShared, namesOf, OFFER_COLUMNS, optionsGuarded, prefixed, type Db } from './store'

/**
 * A style's options (B-W2b-229; PRD-206; design products.options › Option group › Styles "Styles that offer this group,
 * with their own min and max", and the style's link to its option-dependent lines and steps, PRD-081, PRD-128):
 *
 *   GET  /product/styles/:styleId/options                     product.styles.view: the groups the style offers (its own
 *                                                             minimum and maximum, place, default) with their values, the
 *                                                             BOM lines and routing steps of its revisions only for options
 *   PUT  /product/styles/:styleId/options/:groupId            product.styles.manage: offer a group, or change the offer
 *                                                             ({version: null} for a new offer, else the offer's version)
 *   POST /product/styles/:styleId/options/:groupId/withdraw   product.styles.manage: the style stops offering it — removed
 *                                                             when no line or step of the style is for one of its values,
 *                                                             else archived (they keep it; a copy clears them)
 *
 * A change of the style's spec: the style row FOR UPDATE, B-W2b-221's edit rule (SPEC), the group FOR SHARE, the default
 * value FOR SHARE, then the offer. Every rule of the database's StyleOptionGroup_check is said first in words. One command,
 * an audit row on the offer, W1's style.updated (field `optionGroups`).
 */

const STYLE_HEAD = { id: true, code: true, name: true, companyId: true, status: true } as const satisfies Prisma.StyleSelect

/** "LINER: YES" — a value as the style's lines and steps name it (B-W2b-225's routing in depth reads them too). */
export async function optionLabelsOf(db: Db, valueIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(valueIds)]
  if (ids.length === 0) return new Map()
  const values = await db.optionValue.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, groupId: true } })
  const groups = new Map((await db.optionGroup.findMany({ where: { id: { in: [...new Set(values.map((value) => value.groupId))] } }, select: { id: true, code: true } })).map((group) => [group.id, group.code]))
  return new Map(values.map((value) => [value.id, `${groups.get(value.groupId) ?? '?'}: ${value.code}`]))
}

/** The style's options as the caller reads them. */
export async function styleOptionsOf(db: Db, styleId: string, context: RequestContext): Promise<StyleOptionsView> {
  const style = await db.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_HEAD })
  const offers = await db.styleOptionGroup.findMany({ where: { styleId }, select: OFFER_COLUMNS, orderBy: [{ status: 'asc' }, { seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
  const groupIds = [...new Set(offers.map((offer) => offer.groupId))]
  const groups = new Map((await db.optionGroup.findMany({ where: { id: { in: groupIds } }, select: GROUP_COLUMNS })).map((group) => [group.id, group]))
  const values = groupIds.length === 0 ? [] : await db.optionValue.findMany({ where: { groupId: { in: groupIds } }, select: { id: true, groupId: true, code: true, name: true, nameI18n: true, seq: true, freeText: true, status: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  const outside = new Set(
    values.length === 0 ? [] : (await db.optionEffect.findMany({ where: { kind: 'CERTIFICATE', valueId: { in: values.map((value) => value.id) } }, select: { valueId: true } })).map((row) => row.valueId),
  )
  const revisions = new Map((await db.styleRevision.findMany({ where: { styleId }, select: { id: true, revision: true, status: true } })).map((row) => [row.id, row]))
  const lines = await db.bomLine.findMany({ where: { styleId, optionValueId: { not: null } }, select: { id: true, revisionId: true, seq: true, itemId: true, optionValueId: true } })
  const steps = await db.routingOperation.findMany({ where: { styleId, appliesToOptionValueIds: { isEmpty: false } }, select: { id: true, revisionId: true, seq: true, code: true, name: true, appliesToOptionValueIds: true } })
  const items = new Map((lines.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true } })).map((item) => [item.id, item]))
  const labels = await optionLabelsOf(db, [...lines.map((line) => line.optionValueId!), ...steps.flatMap((step) => step.appliesToOptionValueIds)])
  const byRevision = (revisionId: string) => revisions.get(revisionId)?.revision ?? 0
  const offerViews: OfferView[] = offers.flatMap((offer) => {
    const group = groups.get(offer.groupId)
    if (!group) return []
    const effective = effectivePicks(group, offer)
    return [
      {
        id: offer.id,
        group: { id: group.id, code: group.code, name: group.name, nameI18n: namesOf(group.nameI18n), kind: group.kind, minPicks: group.minPicks, maxPicks: group.maxPicks, status: group.status },
        seq: offer.seq,
        minPicks: offer.minPicks,
        maxPicks: offer.maxPicks,
        effective: { ...effective },
        picks: { ...picksWords(effective) },
        defaultValueId: offer.defaultValueId,
        values: values
          .filter((value) => value.groupId === group.id)
          .map((value) => ({ id: value.id, code: value.code, name: value.name, nameI18n: namesOf(value.nameI18n), seq: value.seq, freeText: value.freeText, outsideCertificate: outside.has(value.id), status: value.status })),
        status: offer.status,
        version: offer.version,
        updatedAt: toUtcIso(offer.updatedAt),
      },
    ]
  })
  return {
    style: { ...style },
    offers: offerViews,
    lines: lines
      .sort((a, b) => byRevision(b.revisionId) - byRevision(a.revisionId) || a.seq - b.seq)
      .map((line) => ({
        revision: { ...revisions.get(line.revisionId)! },
        lineId: line.id,
        seq: line.seq,
        item: { ...(items.get(line.itemId) ?? { id: line.itemId, code: '?', name: '' }) },
        optionValueId: line.optionValueId!,
        option: labels.get(line.optionValueId!) ?? '?',
      })),
    steps: steps
      .sort((a, b) => byRevision(b.revisionId) - byRevision(a.revisionId) || a.seq - b.seq)
      .map((step) => ({
        revision: { ...revisions.get(step.revisionId)! },
        stepId: step.id,
        seq: step.seq,
        code: step.code,
        name: step.name,
        optionValueIds: [...step.appliesToOptionValueIds],
        options: step.appliesToOptionValueIds.map((id) => labels.get(id) ?? '?'),
      })),
    editable: style.status !== 'ARCHIVED' && mayWrite(actorOf(context), PRODUCT_STYLES_MANAGE, style.companyId),
  }
}

/** GET /product/styles/:styleId/options */
export async function readStyleOptions(caller: CommandCaller, styleId: string): Promise<StyleOptionsView> {
  await readStyle(caller, styleId)
  return caller.withClient((client) => styleOptionsOf(client, styleId, contextOf(caller)))
}

/** The style row FOR UPDATE, not archived, under its edit rule (a change of its spec). */
async function openStyle(tx: CommandTx, styleId: string): Promise<{ code: string; companyId: string | null }> {
  const style = await lockStyle(tx, styleId)
  if (style.status === 'ARCHIVED') throw new InvalidStateError('This style is archived: reactivate it before changing its options.')
  await requireEditRule(tx, styleId, 'SPEC')
  return style
}

const activeOffer = (tx: CommandTx, styleId: string, groupId: string) => tx.styleOptionGroup.findFirst({ where: { styleId, groupId, status: 'ACTIVE' }, select: OFFER_COLUMNS })

/** PUT /product/styles/:styleId/options/:groupId */
export async function offerGroup(caller: CommandCaller, styleId: string, groupId: string, body: OfferBody, idempotencyKey?: string): Promise<StyleOptionsView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  if (!isUuid(groupId)) throw new NotFoundError('Option group not found.')
  const { result } = await optionsGuarded(
    () =>
      command(caller, { name: 'product.options.offerGroup', idempotencyKey, input: { styleId, groupId, ...body } }, async (tools) => {
        const { tx, now } = tools
        const style = await openStyle(tx, styleId)
        const group = await tx.optionGroup.findUnique({ where: { id: groupId }, select: GROUP_COLUMNS })
        if (!group) throw new NotFoundError('Option group not found.')
        await lockGroupShared(tx, groupId)
        const offer = await activeOffer(tx, styleId, groupId)
        if (body.version === null && offer) throw new ConflictError(`Style ${style.code} offers ${group.code} already (version ${offer.version}): change that offer.`)
        if (body.version !== null && !offer) throw new ConflictError(`Style ${style.code} does not offer ${group.code}: offer it first (version null).`)
        if (body.version !== null && offer && offer.version !== body.version) throw new StaleVersionError('StyleOptionGroup', offer.id, offer.version, body.version)

        const issues: Issue[] = []
        if (!offer) {
          if (group.status === 'ARCHIVED') issues.push({ path: 'params/groupId', message: `Option group ${group.code} is archived: no style offers it anew.` })
          if (group.companyId !== null && group.companyId !== style.companyId) issues.push({ path: 'params/groupId', message: `Option group ${group.code} belongs to one company: only that company's styles offer it.` })
        }
        const next = {
          seq: body.seq ?? offer?.seq ?? ((await tx.styleOptionGroup.findFirst({ where: { styleId, status: 'ACTIVE' }, select: { seq: true }, orderBy: { seq: 'desc' } }))?.seq ?? 0) + 10,
          minPicks: body.minPicks === undefined ? (offer?.minPicks ?? null) : body.minPicks,
          maxPicks: body.maxPicks === undefined ? (offer?.maxPicks ?? null) : body.maxPicks,
          defaultValueId: body.defaultValueId === undefined ? (offer?.defaultValueId ?? null) : body.defaultValueId,
        }
        issues.push(...prefixed(offerPicksProblems(group.kind as OptionGroupKind, group, next)))
        if (next.defaultValueId !== null && next.defaultValueId !== (offer?.defaultValueId ?? null)) {
          await lockValuesShared(tx, [next.defaultValueId])
          const value = await tx.optionValue.findFirst({ where: { id: next.defaultValueId, groupId }, select: { code: true, status: true, freeText: true } })
          if (!value) issues.push({ path: 'body/defaultValueId', message: `Not an option of ${group.code}.` })
          else if (value.status !== 'ACTIVE') issues.push({ path: 'body/defaultValueId', message: `Option ${value.code} is archived.` })
          else if (value.freeText) issues.push({ path: 'body/defaultValueId', message: `Option ${value.code} wants a typed text: it cannot be taken by itself.` })
        }
        if (issues.length > 0) throw invalid(issues, 'offer')

        const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
        let offerId: string
        if (!offer) {
          offerId = newId()
          await tx.styleOptionGroup.create({ data: { id: offerId, styleId, groupId, ...next, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
          tools.audit({ recordType: 'StyleOptionGroup', recordId: offerId, companyId: style.companyId, after: { styleId, groupId, ...next } })
        } else {
          offerId = offer.id
          const before = { seq: offer.seq, minPicks: offer.minPicks, maxPicks: offer.maxPicks, defaultValueId: offer.defaultValueId }
          const changed = (Object.keys(next) as (keyof typeof next)[]).filter((field) => next[field] !== before[field])
          const { count } = await tx.styleOptionGroup.updateMany({ where: { id: offer.id, version: offer.version }, data: { ...next, version: offer.version + 1, updatedAt: now } })
          if (count !== 1) throw new StaleVersionError('StyleOptionGroup', offer.id, offer.version + 1, offer.version)
          tools.audit({
            recordType: 'StyleOptionGroup',
            recordId: offer.id,
            companyId: style.companyId,
            before: Object.fromEntries(changed.map((field) => [field, before[field]])),
            after: Object.fromEntries(changed.map((field) => [field, next[field]])),
          })
        }
        tools.emit({ type: 'style.updated', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, fields: ['optionGroups'] } })
        return styleOptionsOf(tx, styleId, tools.context)
      }),
    'The style offers this group already: change that offer.',
  )
  return result
}

/** POST /product/styles/:styleId/options/:groupId/withdraw */
export async function withdrawOffer(caller: CommandCaller, styleId: string, groupId: string, body: WithdrawBody, idempotencyKey?: string): Promise<{ withdrawn: 'REMOVED' | 'ARCHIVED'; words: { it: string; en: string }; options: StyleOptionsView }> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  if (!isUuid(groupId)) throw new NotFoundError('Option group not found.')
  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.withdrawOffer', idempotencyKey, input: { styleId, groupId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const style = await openStyle(tx, styleId)
      const offer = await activeOffer(tx, styleId, groupId)
      if (!offer) throw new NotFoundError('The style does not offer this group.')
      if (offer.version !== body.version) throw new StaleVersionError('StyleOptionGroup', offer.id, offer.version, body.version)
      const group = await tx.optionGroup.findUniqueOrThrow({ where: { id: groupId }, select: { code: true } })
      const valueIds = (await tx.optionValue.findMany({ where: { groupId }, select: { id: true } })).map((value) => value.id)
      const lines = valueIds.length === 0 ? 0 : await tx.bomLine.count({ where: { styleId, optionValueId: { in: valueIds } } })
      const steps = valueIds.length === 0 ? 0 : await tx.routingOperation.count({ where: { styleId, appliesToOptionValueIds: { hasSome: valueIds } } })
      let withdrawn: 'REMOVED' | 'ARCHIVED'
      let words: { it: string; en: string }
      if (lines === 0 && steps === 0) {
        await tx.styleOptionGroup.delete({ where: { id: offer.id }, select: { id: true } })
        withdrawn = 'REMOVED'
        words = { it: `${group.code} tolto da ${style.code}: nessuna riga o fase era per le sue opzioni.`, en: `${group.code} removed from ${style.code}: no line or step was for its options.` }
      } else {
        await tx.styleOptionGroup.update({ where: { id: offer.id }, data: { status: 'ARCHIVED', version: offer.version + 1, updatedAt: now }, select: { id: true } })
        withdrawn = 'ARCHIVED'
        words = {
          it: `${group.code} archiviato su ${style.code}: ${lines} righe di distinta e ${steps} fasi sono per le sue opzioni e le tengono (una copia in una nuova revisione le toglie).`,
          en: `${group.code} archived on ${style.code}: ${lines} BOM line(s) and ${steps} routing step(s) are for its options and keep them (a copy into a new revision clears them).`,
        }
      }
      tools.audit({ recordType: 'StyleOptionGroup', recordId: offer.id, companyId: style.companyId, before: { status: offer.status }, after: { status: withdrawn === 'REMOVED' ? null : 'ARCHIVED', withdrawn, lines, steps } })
      tools.emit({ type: 'style.updated', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, fields: ['optionGroups'] } })
      return { withdrawn, words, options: await styleOptionsOf(tx, styleId, tools.context) }
    }),
  )
  return result
}

/** The ACTIVE values of the groups a style offers ACTIVE, in the configurator's order (B-W2b-225's steps only for options). */
export async function offeredValuesOf(db: Db, styleId: string): Promise<{ id: string; label: string }[]> {
  const offers = await db.styleOptionGroup.findMany({ where: { styleId, status: 'ACTIVE' }, select: { groupId: true, seq: true }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }] })
  if (offers.length === 0) return []
  const groups = new Map((await db.optionGroup.findMany({ where: { id: { in: offers.map((offer) => offer.groupId) } }, select: { id: true, code: true } })).map((group) => [group.id, group.code]))
  const values = await db.optionValue.findMany({ where: { groupId: { in: offers.map((offer) => offer.groupId) }, status: 'ACTIVE' }, select: { id: true, code: true, groupId: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return offers.flatMap((offer) => values.filter((value) => value.groupId === offer.groupId).map((value) => ({ id: value.id, label: `${groups.get(offer.groupId) ?? '?'}: ${value.code}` })))
}
