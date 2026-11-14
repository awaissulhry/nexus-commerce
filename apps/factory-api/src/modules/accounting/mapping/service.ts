import { keysOf, keyWords, MAPPING_KINDS, MAPPING_WORDS, mappingInForce, type MappingKind } from '@nexus/factory-domain/accounting/mapping/keys'
import type { AddMappingBody, ChangeMappingBody, MappingAnswer, MappingQuery, MappingRowView, SettingsBody, SettingsView } from '@nexus/factory-domain/accounting/mapping/contracts'
import { ACCOUNTING_JOURNALS_SWITCH, ACCOUNTING_MAPPING_MANAGE } from '@nexus/factory-domain/accounting/mapping/permissions'
import { ACCOUNTING_VIEW } from '@nexus/factory-domain/accounting/permissions'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { accountingClock, accountingCommand, companyFor, companyRef, dateOf, officeOf, peopleNames, type Reader } from '../store'
import { bridgeRefusal, journalsSettingsOf, MAPPING_SELECT, mappingRowsOf, SETTINGS_SELECT, storedOf, taxCodesOf, type StoredMapping } from './store'

/**
 * The account mapping in one place and the journals switch (B-W2b-408; FIN-151, FIN-152; design finance.accounting
 * "Account mapping (W2b)", Finance › Settings "Account mapping"; GATE-ACCOUNTANT):
 *
 *   GET    /accounting/mapping?companyId&kind     every key Nexus posts (and every key a row names), with the row in force
 *                                                 today, the rows from a later day and the rows before; the switch
 *   POST   /accounting/mapping                    a key mapped to an account from a day (today or later; a key's first row
 *                                                 may start earlier: it fills what had no account)
 *   PATCH  /accounting/mapping/:id                its account or note, only before its first day
 *   DELETE /accounting/mapping/:id?version        removed, only before its first day
 *   GET    /accounting/settings?companyId         the journals switch in force (company row, tenant-wide row, off)
 *   PUT    /accounting/settings                   switched on or off (accounting.journals.switch, a fresh code: the route)
 * The database holds the same rules for every login (fixed from the first day, one row per key and day); its refusals
 * come back in words. Every write is a command: audited, an Idempotency-Key, an event.
 */

const today = (): string => businessDate(accountingClock().now())

const refused = (code: string, message: string): DomainError => new DomainError('conflict', message, [{ path: `problem/${code}`, message }])

function rowView(row: StoredMapping, names: ReadonlyMap<string, string>, day: string): MappingRowView {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    accountCode: row.accountCode,
    validFrom: row.validFrom,
    note: row.note,
    fixed: row.validFrom <= day,
    createdAt: toUtcIso(row.createdAt),
    createdBy: row.createdById ? { id: row.createdById, name: names.get(row.createdById) ?? null } : null,
    version: row.version,
  }
}

const SETTINGS_WORDS = {
  on: "The journals carry their entries with the mapped accounts (sales, purchases, payments, cost of goods sold and variances): the accountant's software imports them.",
  off: "Waits for the accountant: the journals go without mapped entries until a person switches them on, once the accountant has confirmed the mapping (GATE-ACCOUNTANT).",
}

async function settingsViewOf(db: Reader, context: OfficeContext, companyId: string): Promise<SettingsView> {
  const settings = await journalsSettingsOf(db, companyId)
  return {
    companyId,
    settingsId: settings.own?.id ?? null,
    version: settings.own?.version ?? null,
    journalsOn: settings.journalsOn,
    from: settings.from,
    words: settings.journalsOn ? SETTINGS_WORDS.on : SETTINGS_WORDS.off,
    can: { switch: can(actorOf(context), ACCOUNTING_JOURNALS_SWITCH, { companyId }) },
  }
}

/** GET /accounting/mapping: the company's mapping, key by key. */
export async function mappingOf(caller: CommandCaller, query: MappingQuery): Promise<MappingAnswer> {
  const context = officeOf(caller)
  const company = await companyFor(caller, query.companyId, ACCOUNTING_VIEW)
  const day = today()
  return caller.withClient(async (db) => {
    const [rows, codes] = await Promise.all([mappingRowsOf(db, company.id), taxCodesOf(db, company.id)])
    const names = await peopleNames(
      db,
      rows.map((row) => row.createdById),
    )
    const kinds: readonly MappingKind[] = query.kind ? [query.kind] : MAPPING_KINDS
    const keys = kinds.flatMap((kind) => {
      const posted = keysOf(kind, codes)
      const named = [...new Set(rows.filter((row) => row.kind === kind).map((row) => row.key))].filter((key) => !posted.includes(key)).sort()
      return [...posted, ...named].map((key) => {
        const mine = rows.filter((row) => row.kind === kind && row.key === key)
        const current = mappingInForce(mine, kind, key, day)
        return {
          kind,
          key,
          words: keyWords(kind, key, codes),
          posted: posted.includes(key),
          current: current ? rowView(current, names, day) : null,
          upcoming: mine.filter((row) => row.validFrom > day).map((row) => rowView(row, names, day)),
          earlier: mine.filter((row) => row.validFrom <= day && row.id !== current?.id).map((row) => rowView(row, names, day)).reverse(),
        }
      })
    })
    return {
      company: companyRef(company),
      today: day,
      keys,
      unmapped: keys.filter((entry) => entry.posted && entry.current === null).length,
      journals: await settingsViewOf(db, context, company.id),
      can: { manage: can(actorOf(context), ACCOUNTING_MAPPING_MANAGE, { companyId: company.id }) },
      words: MAPPING_WORDS,
    }
  })
}

async function visibleRow(caller: CommandCaller, mappingId: string): Promise<StoredMapping & { companyId: string }> {
  const context = officeOf(caller)
  if (!isUuid(mappingId)) throw new NotFoundError('Account mapping row not found.')
  const row = await caller.withClient((db) => db.accountMapping.findUnique({ where: { id: mappingId }, select: MAPPING_SELECT }))
  if (!row || !can(actorOf(context), ACCOUNTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Account mapping row not found.')
  if (!can(actorOf(context), ACCOUNTING_MAPPING_MANAGE, { companyId: row.companyId })) throw new ForbiddenError()
  return { ...storedOf(row), companyId: row.companyId }
}

async function oneRowView(caller: CommandCaller, mappingId: string): Promise<MappingRowView> {
  return caller.withClient(async (db) => {
    const row = storedOf(await db.accountMapping.findUniqueOrThrow({ where: { id: mappingId }, select: MAPPING_SELECT }))
    return rowView(row, await peopleNames(db, [row.createdById]), today())
  })
}

/** POST /accounting/mapping: a key to an account from a day. */
export async function addMapping(caller: CommandCaller, body: AddMappingBody, idempotencyKey?: string): Promise<MappingRowView> {
  const context = officeOf(caller)
  const company = await companyFor(caller, body.companyId, ACCOUNTING_MAPPING_MANAGE)
  const day = today()
  const { codes, earlier } = await caller.withClient(async (db) => ({ codes: await taxCodesOf(db, company.id), earlier: (await mappingRowsOf(db, company.id)).filter((row) => row.kind === body.kind && row.key === body.key) }))
  if (!keysOf(body.kind, codes).includes(body.key)) {
    throw new ValidationError('Nexus posts no such key.', [{ path: 'body/key', message: `Nexus posts no ${body.kind} key "${body.key}": pick one of the keys the mapping lists.` }])
  }
  if (earlier.length > 0 && body.validFrom < day) {
    throw refused('BACKDATED', `${body.kind} ${body.key} is mapped already: a change starts today (${day}) or later, so what was handed over keeps its account.`)
  }
  if (earlier.some((row) => row.validFrom === body.validFrom)) throw refused('SAME_DAY', `${body.kind} ${body.key} has a row from ${body.validFrom} already: change that row (before its day) or pick another day.`)
  const mappingId = newId()
  try {
    await accountingCommand(caller, { name: 'accounting.addMapping', idempotencyKey, input: body }, async (tools) => {
      await tools.tx.accountMapping.create({
        data: { id: mappingId, companyId: company.id, kind: body.kind, key: body.key, accountCode: body.accountCode, validFrom: dateOf(body.validFrom), note: body.note ?? null, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId },
        select: { id: true },
      })
      tools.audit({ recordType: 'AccountMapping', recordId: mappingId, companyId: company.id, after: { kind: body.kind, key: body.key, accountCode: body.accountCode, validFrom: body.validFrom } })
      tools.emit({ type: 'account_mapping.changed', subject: mappingId, companyId: company.id, payload: { mappingId, kind: body.kind, key: body.key, validFrom: body.validFrom, change: 'ADDED' } })
      return { mappingId }
    })
  } catch (error) {
    throw bridgeRefusal(error)
  }
  return oneRowView(caller, mappingId)
}

/** PATCH /accounting/mapping/:id: its account or note, before its first day. */
export async function changeMapping(caller: CommandCaller, mappingId: string, body: ChangeMappingBody, idempotencyKey?: string): Promise<MappingRowView> {
  const row = await visibleRow(caller, mappingId)
  if (row.version !== body.version) throw new StaleVersionError('AccountMapping', mappingId, row.version, body.version)
  const day = today()
  if (row.validFrom <= day) throw refused('FIXED', `This row applies since ${row.validFrom}: it is fixed. A change is a new row from a later day.`)
  const accountCode = body.accountCode ?? row.accountCode
  const note = body.note === undefined ? row.note : body.note
  if (accountCode === row.accountCode && note === row.note) throw refused('NOTHING_CHANGES', 'Nothing changes: the row is already so.')
  try {
    await accountingCommand(caller, { name: 'accounting.changeMapping', idempotencyKey, input: { mappingId, ...body }, record: { type: 'AccountMapping', id: mappingId, expectedVersion: body.version } }, async (tools) => {
      await tools.tx.accountMapping.update({ where: { id: mappingId }, data: { accountCode, note, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'AccountMapping', recordId: mappingId, companyId: row.companyId, before: { accountCode: row.accountCode, note: row.note }, after: { accountCode, note } })
      tools.emit({ type: 'account_mapping.changed', subject: mappingId, companyId: row.companyId, payload: { mappingId, kind: row.kind, key: row.key, validFrom: row.validFrom, change: 'CHANGED' } })
      return { mappingId }
    })
  } catch (error) {
    throw bridgeRefusal(error)
  }
  return oneRowView(caller, mappingId)
}

/** DELETE /accounting/mapping/:id: removed, before its first day. */
export async function removeMapping(caller: CommandCaller, mappingId: string, version: number, idempotencyKey?: string): Promise<{ removed: string }> {
  const row = await visibleRow(caller, mappingId)
  if (row.version !== version) throw new StaleVersionError('AccountMapping', mappingId, row.version, version)
  if (row.validFrom <= today()) throw refused('FIXED', `This row applies since ${row.validFrom}: it is kept. A change is a new row from a later day.`)
  try {
    await accountingCommand(caller, { name: 'accounting.removeMapping', idempotencyKey, input: { mappingId, version }, record: { type: 'AccountMapping', id: mappingId, expectedVersion: version } }, async (tools) => {
      await tools.tx.accountMapping.delete({ where: { id: mappingId }, select: { id: true } })
      tools.audit({ recordType: 'AccountMapping', recordId: mappingId, companyId: row.companyId, before: { kind: row.kind, key: row.key, accountCode: row.accountCode, validFrom: row.validFrom }, after: null })
      tools.emit({ type: 'account_mapping.changed', subject: mappingId, companyId: row.companyId, payload: { mappingId, kind: row.kind, key: row.key, validFrom: row.validFrom, change: 'REMOVED' } })
      return { mappingId }
    })
  } catch (error) {
    throw bridgeRefusal(error)
  }
  return { removed: mappingId }
}

/** GET /accounting/settings: the company's journals switch in force. */
export async function journalsSettings(caller: CommandCaller, companyId: string): Promise<SettingsView> {
  const context = officeOf(caller)
  const company = await companyFor(caller, companyId, ACCOUNTING_VIEW)
  return caller.withClient((db) => settingsViewOf(db, context, company.id))
}

/**
 * PUT /accounting/settings: the journals switched on or off for the company (its own row made at the first change; the
 * route asks a fresh code first). Nothing changing is refused in words.
 */
export async function saveJournalsSettings(caller: CommandCaller, body: SettingsBody, idempotencyKey?: string): Promise<SettingsView> {
  const context = officeOf(caller)
  const company = await companyFor(caller, body.companyId, ACCOUNTING_JOURNALS_SWITCH)
  const before = await caller.withClient((db) => journalsSettingsOf(db, company.id))
  if (before.own && body.version !== undefined && before.own.version !== body.version) throw new StaleVersionError('AccountingSettings', before.own.id, before.own.version, body.version)
  if (before.journalsOn === body.journalsOn && before.from === 'COMPANY') throw refused('NOTHING_CHANGES', `Nothing changes: the journals are already ${body.journalsOn ? 'on' : 'off'}.`)
  await accountingCommand(
    caller,
    { name: 'accounting.switchJournals', idempotencyKey, input: body, ...(before.own ? { record: { type: 'AccountingSettings' as const, id: before.own.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } } : {}) },
    async (tools) => {
      const row = before.own
        ? await tools.tx.accountingSettings.update({ where: { id: before.own.id }, data: { journalsOn: body.journalsOn, updatedAt: tools.now }, select: SETTINGS_SELECT })
        : await tools.tx.accountingSettings.create({ data: { id: company.id, companyId: company.id, journalsOn: body.journalsOn, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: SETTINGS_SELECT })
      tools.audit({ recordType: 'AccountingSettings', recordId: row.id, companyId: company.id, before: { journalsOn: before.journalsOn, from: before.from }, after: { journalsOn: body.journalsOn }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'accounting_settings.changed', subject: row.id, companyId: company.id, payload: { settingsId: row.id, companyId: company.id, journalsOn: body.journalsOn } })
      return { settingsId: row.id }
    },
  )
  return caller.withClient((db) => settingsViewOf(db, context, company.id))
}
