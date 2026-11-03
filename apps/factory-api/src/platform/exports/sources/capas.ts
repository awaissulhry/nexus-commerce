import { QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import { CAPA_PRIORITIES, CAPA_TYPES, CAPA_VIEWS, type CapaPriority, type CapaType, type CapaView } from '@nexus/factory-domain/quality/capa/rules'
import { listCapas, type ListQuery } from '../../../modules/quality/capa/reads'
import { defineExportSource } from '../source'

/**
 * Quality › Problems › Corrective actions (`/quality/capa`, the list mode of SCR-146; B-W2b-108): the export of the list as
 * the screen shows it. The address is the list's: `?view=open|mine|overdue|closed|cancelled|all` (nothing: open),
 * `?type=CAPA|EIGHT_D`, `?priority=LOW|NORMAL|HIGH`, `?q=` (number, title or customer, at most 80 characters). Read through
 * the module's listCapas (quality.capa.view over its companies and customers), page by page with its cursor (200 a page).
 * No money; the owner is named as the list names them (an office person, inside the CAPA list); no figure per person.
 *
 * Registered in ./index.ts by the screen step (B-W2b-119) together with its page: the registry's test asks for a real
 * Office list page at `/quality/capa`, which this API step does not build.
 */

type Row = Awaited<ReturnType<typeof listCapas>>['capas'][number] & { readonly ownerName: string | null }

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))

export const capas = defineExportSource<ListQuery, Row>({
  listKey: 'quality.capa',
  permission: QUALITY_CAPA_VIEW,
  query(address) {
    const view = address.get('view') ?? ''
    const type = address.get('type') ?? ''
    const priority = address.get('priority') ?? ''
    const q = (address.get('q') ?? '').slice(0, 80).trim() || undefined
    return {
      view: (CAPA_VIEWS as readonly string[]).includes(view) ? (view as CapaView) : 'open',
      ...((CAPA_TYPES as readonly string[]).includes(type) ? { type: type as CapaType } : {}),
      ...((CAPA_PRIORITIES as readonly string[]).includes(priority) ? { priority: priority as CapaPriority } : {}),
      ...(q ? { q } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listCapas(caller, { ...query, ...(cursor ? { cursor } : {}), limit: Math.min(limit, 200) })
    const names = new Map(page.people.map((person) => [person.id, person.name]))
    return { rows: page.capas.map((row) => ({ ...row, ownerName: names.get(row.ownerId) ?? null })), next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    title: { value: (row) => row.title },
    type: { value: (row, words) => words(`type.${row.type}`) },
    sources: { value: (row) => [String(row.sources.count), ...row.sources.items.flatMap((item) => (item.label ? [item.label] : []))].join(' · ') },
    customer: { value: (row) => row.customer?.name ?? null },
    owner: { value: (row, words) => row.ownerName ?? words('common.unknownPerson') },
    stage: { value: (row, words) => words(`status.${row.status}`) },
    nextDue: { value: (row) => row.nextDue },
    actions: { value: (row, words) => fill(words('actions.openOverdue'), { open: row.actions.open, overdue: row.actions.overdue }) },
    priority: { value: (row, words) => words(`priority.${row.priority}`) },
    dueOn: { value: (row) => row.dueOn },
    age: { value: (row, words) => (row.ageDays === 0 ? words('age.today') : fill(words(`age.days_${row.ageDays === 1 ? 'one' : 'other'}`), { count: row.ageDays })) },
  },
  words: {
    it: {
      lang: 'it',
      'common.unknownPerson': "Un'altra persona",
      'type.CAPA': 'CAPA',
      'type.EIGHT_D': '8D',
      'status.PLAN': 'Pianificazione',
      'status.ACT': 'Attuazione',
      'status.CHECK': 'Verifica',
      'status.D1': 'D1 team',
      'status.D2': 'D2 problema',
      'status.D3': 'D3 contenimento',
      'status.D4': 'D4 causa radice',
      'status.D5': 'D5 azioni correttive',
      'status.D6': 'D6 azioni attuate',
      'status.D7': 'D7 prevenzione',
      'status.D8': 'D8 chiusura',
      'status.CLOSED': 'Chiusa',
      'status.CANCELLED': 'Annullata',
      'priority.LOW': 'Bassa',
      'priority.NORMAL': 'Normale',
      'priority.HIGH': 'Alta',
      'actions.openOverdue': '{open} aperte · {overdue} in ritardo',
      'age.today': 'Oggi',
      'age.days_one': '{count} giorno',
      'age.days_other': '{count} giorni',
    },
    en: {
      lang: 'en',
      'common.unknownPerson': 'Someone else',
      'type.CAPA': 'CAPA',
      'type.EIGHT_D': '8D',
      'status.PLAN': 'Plan',
      'status.ACT': 'Act',
      'status.CHECK': 'Check',
      'status.D1': 'D1 team',
      'status.D2': 'D2 problem',
      'status.D3': 'D3 containment',
      'status.D4': 'D4 root cause',
      'status.D5': 'D5 corrective actions',
      'status.D6': 'D6 actions in place',
      'status.D7': 'D7 prevention',
      'status.D8': 'D8 closure',
      'status.CLOSED': 'Closed',
      'status.CANCELLED': 'Cancelled',
      'priority.LOW': 'Low',
      'priority.NORMAL': 'Normal',
      'priority.HIGH': 'High',
      'actions.openOverdue': '{open} open · {overdue} overdue',
      'age.today': 'Today',
      'age.days_one': '{count} day',
      'age.days_other': '{count} days',
    },
  },
})
