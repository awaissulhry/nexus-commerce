import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as customsEvents } from '@nexus/factory-domain/shipping-customs/events'
import { eoriOf } from '@nexus/factory-domain/shipping/customs/rules'
import { SHIPPING_SETTINGS_MANAGE, SHIPPING_SETTINGS_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { assertMay, mayOn, officeContextOf } from '../access'

/**
 * The customs settings (B-W2b-409; LOG-095 "each company's EORI on customs documents"; LOG-097 the broker pack's switch; design
 * Warehouse › Shipping "EORI"). Office only:
 *
 *   GET  /shipping/companies/:companyId/customs     shipping.settings.view over the company: its EORI and each of its sites'
 *                                                   broker-pack switch (with the versions to write them)
 *   PUT  /shipping/companies/:companyId/eori        shipping.settings.manage over the company: the EORI (upper case, no spaces;
 *                                                   null: none), audited from → to, customs.settings_changed
 *   PUT  /shipping/sites/:siteId/broker-pack        shipping.settings.manage over the site: the broker's pack sent by link on or
 *                                                   off (OFF by default, the Owner's rule of 11-13); switching it ON sends papers
 *                                                   to a third party from then on, so it asks a fresh step-up (the route's)
 */

const settingsChanged = customsEvents.find((event) => event.type === 'customs.settings_changed')!

/** GET …/companies/:companyId/customs. */
export async function getCustomsSettings(caller: CommandCaller, companyId: string) {
  const context = officeContextOf(caller)
  const company = isUuid(companyId) ? await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: { id: true, legalName: true, eori: true, version: true } })) : null
  assertMay(context, SHIPPING_SETTINGS_VIEW, SHIPPING_SETTINGS_VIEW, company ? { companyId: company.id } : null, 'Company')
  return caller.withClient(async (db) => {
    const sites = await db.site.findMany({ where: { companyId: company!.id }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    const settings = new Map((sites.length === 0 ? [] : await db.shippingSettings.findMany({ where: { id: { in: sites.map((site) => site.id) } }, select: { id: true, brokerPackOn: true, version: true } })).map((row) => [row.id, row]))
    return {
      company: { id: company!.id, name: company!.legalName, eori: company!.eori, version: company!.version, mayManage: mayOn(context, SHIPPING_SETTINGS_MANAGE, { companyId: company!.id }) },
      sites: sites
        .filter((site) => mayOn(context, SHIPPING_SETTINGS_VIEW, { companyId: company!.id, siteId: site.id }))
        .map((site) => {
          const row = settings.get(site.id)
          return { siteId: site.id, code: site.code, name: site.name, hasSettings: row !== undefined, brokerPackOn: row?.brokerPackOn ?? false, version: row?.version ?? null, mayManage: mayOn(context, SHIPPING_SETTINGS_MANAGE, { companyId: company!.id, siteId: site.id }) }
        }),
    }
  })
}

/** PUT …/companies/:companyId/eori. */
export async function setEori(caller: CommandCaller, companyId: string, body: { readonly eori: string | null; readonly version: number }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const company = isUuid(companyId) ? await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  assertMay(context, SHIPPING_SETTINGS_VIEW, SHIPPING_SETTINGS_MANAGE, company ? { companyId: company.id } : null, 'Company')
  const eori = body.eori === null || body.eori.trim() === '' ? null : eoriOf(body.eori)
  if (body.eori !== null && body.eori.trim() !== '' && eori === null) {
    throw new ValidationError("An EORI is the country's two letters, then 1 to 15 letters or digits (IT then the VAT number, for an Italian company).", [{ path: 'body/eori', message: 'Not an EORI.' }])
  }
  const { result } = await command(caller, { name: 'shipping.setEori', idempotencyKey, input: { companyId, eori, version: body.version }, record: { type: 'Company', id: companyId, expectedVersion: body.version } }, async (tools) => {
    const before = await tools.tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { eori: true } })
    if (before.eori === eori) {
      tools.audit({ action: 'shipping.setEori', recordType: 'Company', recordId: companyId, companyId, after: { eori, unchanged: true } })
      return { changed: false }
    }
    await tools.tx.company.update({ where: { id: companyId }, data: { eori, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'shipping.setEori', recordType: 'Company', recordId: companyId, companyId, before: { eori: before.eori }, after: { eori } })
    tools.emit(eventFor(settingsChanged, { subject: companyId, companyId, payload: { companyId, siteId: null, what: 'EORI', on: null } }))
    return { changed: true }
  })
  return { ...result, settings: await getCustomsSettings(caller, companyId) }
}

/** PUT …/sites/:siteId/broker-pack: ON asks `stepUp()` (a fresh code) first; OFF asks none. */
export async function switchBrokerPack(caller: CommandCaller, siteId: string, body: { readonly on: boolean; readonly version: number }, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((db) => db.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })) : null
  assertMay(context, SHIPPING_SETTINGS_VIEW, SHIPPING_SETTINGS_MANAGE, site ? { companyId: site.companyId, siteId: site.id } : null, 'Site')
  const settings = await caller.withClient((db) => db.shippingSettings.findUnique({ where: { id: site!.id }, select: { brokerPackOn: true } }))
  if (!settings) throw new NotFoundError('This site has no shipping settings yet: save them first.')
  if (body.on && !settings.brokerPackOn) stepUp()
  const { result } = await command(caller, { name: 'shipping.switchBrokerPack', idempotencyKey, input: { siteId, ...body }, record: { type: 'ShippingSettings', id: site!.id, expectedVersion: body.version } }, async (tools) => {
    const before = await tools.tx.shippingSettings.findUniqueOrThrow({ where: { id: site!.id }, select: { brokerPackOn: true } })
    if (before.brokerPackOn === body.on) {
      tools.audit({ action: 'shipping.switchBrokerPack', recordType: 'ShippingSettings', recordId: site!.id, companyId: site!.companyId, siteId: site!.id, after: { brokerPackOn: body.on, unchanged: true } })
      return { changed: false }
    }
    await tools.tx.shippingSettings.update({ where: { id: site!.id }, data: { brokerPackOn: body.on }, select: { id: true } })
    tools.audit({ action: 'shipping.switchBrokerPack', recordType: 'ShippingSettings', recordId: site!.id, companyId: site!.companyId, siteId: site!.id, before: { brokerPackOn: before.brokerPackOn }, after: { brokerPackOn: body.on } })
    tools.emit(eventFor(settingsChanged, { subject: site!.id, companyId: site!.companyId, siteId: site!.id, payload: { companyId: site!.companyId, siteId: site!.id, what: 'BROKER_PACK', on: body.on } }))
    return { changed: true }
  })
  return { ...result, settings: await getCustomsSettings(caller, site!.companyId) }
}
