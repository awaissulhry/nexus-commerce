import { isUuid } from '@nexus/factory-domain/core/ids'
import { actorOf } from '../../../core/context'
import { defineExportSource } from '../../exports/source'
import { fieldLineText } from '../../threads/timeline/field-lines'
import { AUDIT_AUDIENCES, AUDIT_VIEWS, RECORD_TYPE } from '../contract'
import { AUDIT_READ } from '../read'
import { contextOf, entryViewsOf, searchPage, searchWhere, type SearchQuery } from './search'
import type { SearchEntryView } from './contract'

/**
 * Admin › Data › Audit log (SCR-018, `/admin/audit`; B-W2b-399, PLT-077 "export the result"): the search as a file, through
 * the search's own read (audit.read over the rows, the caller's grains for money: a money field of a grain the person lacks
 * says it is hidden, never its value). The address is the page's (apps/factory-web areas/admin/audit model.ts paramsOf): `view`,
 * `who`, `surface`, `type`, `record`, `area` (an action's first word), `company`, `period` (24h, 7d, 30d, 90d back from when the
 * export is asked), and the search's own terms for the screens of B-W2b-413: `action`, `site`, `request`, `ip`, `from`, `to`.
 * Newest first, 50 000 rows at most (the export's limit).
 */

const PERIOD_MS: Readonly<Record<string, number>> = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 }
const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined => ((values as readonly string[]).includes(value ?? '') ? (value as T) : undefined)
const idOf = (value: string | null): string | undefined => (value && isUuid(value) ? value : undefined)

export const auditSearchExport = defineExportSource<SearchQuery, SearchEntryView>({
  listKey: 'admin.audit',
  permission: AUDIT_READ,
  query(address) {
    const period = PERIOD_MS[address.get('period') ?? '']
    const area = address.get('area')
    const action = address.get('action') ?? (area && /^[a-z][A-Za-z0-9]{0,40}$/.test(area) ? `${area}.` : null)
    const type = address.get('type')
    const request = address.get('request')
    return {
      ...(oneOf(AUDIT_VIEWS, address.get('view')) ? { view: oneOf(AUDIT_VIEWS, address.get('view')) } : {}),
      ...(idOf(address.get('who')) ? { actorId: idOf(address.get('who')) } : {}),
      ...(oneOf(AUDIT_AUDIENCES, address.get('surface')) ? { audience: oneOf(AUDIT_AUDIENCES, address.get('surface')) } : {}),
      ...(type && RECORD_TYPE.test(type) ? { recordType: type } : {}),
      ...(idOf(address.get('record')) ? { recordId: idOf(address.get('record')) } : {}),
      ...(action && /^[a-z][A-Za-z0-9.]{0,99}$/.test(action) ? { action } : {}),
      ...(idOf(address.get('company')) ? { companyId: idOf(address.get('company')) } : {}),
      ...(idOf(address.get('site')) ? { siteId: idOf(address.get('site')) } : {}),
      ...(request && request.length <= 100 ? { requestId: request } : {}),
      ...(address.get('ip') ? { ip: address.get('ip')!.trim().slice(0, 45) } : {}),
      ...(period ? { from: new Date(Date.now() - period).toISOString() } : address.get('from') ? { from: address.get('from')! } : {}),
      ...(address.get('to') ? { to: address.get('to')! } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const actor = actorOf(contextOf(caller))
    return caller.withClient(async (client) => {
      const where = await searchWhere(client, actor, query)
      const { rows, nextBefore } = await searchPage(client, where, cursor, limit)
      return { rows: await entryViewsOf(client, actor, rows), next: nextBefore }
    })
  },
  columns: {
    at: { value: (row) => ({ at: row.at }) },
    who: { value: (row, words) => row.actorName ?? (row.deviceName ? `${words(`surface.${row.audience}`)} · ${row.deviceName}` : words(`surface.${row.audience}`)) },
    surface: { value: (row, words) => words(`surface.${row.audience}`) },
    action: { value: (row) => row.action },
    record: { value: (row) => `${row.recordType} · ${row.recordId}` },
    changed: { value: (row, words) => row.lines.map((line) => fieldLineText(line, words('hidden'))).join('; ') },
    reason: { value: (row) => row.reason },
    request: { value: (row) => row.requestId },
  },
  words: {
    it: {
      'surface.OFFICE': 'Ufficio',
      'surface.FLOOR': 'Reparto',
      'surface.PARTNER': 'Portale',
      'surface.LINK': 'Link',
      'surface.SYSTEM': 'Sistema',
      hidden: 'nascosto',
    },
    en: {
      'surface.OFFICE': 'Office',
      'surface.FLOOR': 'Floor',
      'surface.PARTNER': 'Portal',
      'surface.LINK': 'Link',
      'surface.SYSTEM': 'System',
      hidden: 'hidden',
    },
  },
})
