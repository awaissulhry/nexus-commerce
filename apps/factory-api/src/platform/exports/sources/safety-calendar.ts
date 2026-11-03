import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { addDays } from '@nexus/factory-domain/safety/calendar/rules'
import { businessDate, isBusinessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { readCalendar } from '../../../modules/safety/calendar/calendar'
import type { CalendarItemOut } from '../../../modules/safety/calendar/contract'
import { defineExportSource } from '../source'

/**
 * Plant › Health & safety › Safety calendar (`/plant/calendar`, the List mode of SCR-267; B-W2b-120; design "⋯ Export
 * calendar"): every EHS deadline of the window as the list shows it, through the calendar's own read (safety.view over its
 * companies and sites; every source of modules/safety/calendar/sources). The address is the list's: `?from=&to=` (default
 * today − 35 days … today + 365, 400 days, and what is still late from before it), `?siteId=`, `?tile=overdue|dueSoon`. Health visits stay counts and INAIL reports counts
 * per incident (no person, ever); appointments name their appointee as the organisation register does. No money.
 */

type Query = { readonly from: BusinessDate; readonly to: BusinessDate; readonly siteId?: string; readonly tile?: 'overdue' | 'dueSoon' }

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))

/** The item's sentence in the file's language (the words of its kind; an unknown later kind: its title, else "Deadline"). */
function sentence(row: CalendarItemOut, words: (code: string) => string): string {
  const params: Record<string, string | number> = { ...row.params, count: row.count ?? 1 }
  if (row.kind === 'MACHINE_CHECK') params.check = words('lang') === 'it' ? (row.params.checkIt ?? '') : (row.params.checkEn ?? '')
  if (row.params.role) params.role = words(`role.${row.params.role}`)
  if (row.params.kind) params.type = words(`type.${row.params.kind}`)
  const known = words(`kind.${row.kind}${row.count !== null && row.count !== 1 ? '_other' : ''}`)
  if (!known.startsWith('kind.')) return fill(known, params)
  return row.params.title ?? words('kind.OTHER')
}

export const safetyCalendar = defineExportSource<Query, CalendarItemOut>({
  listKey: 'plant.calendar',
  permission: SAFETY_VIEW,
  query(address) {
    const today = businessDate(new Date())
    const from = address.get('from') ?? ''
    const to = address.get('to') ?? ''
    const siteId = address.get('siteId') ?? ''
    const tile = address.get('tile') ?? ''
    return {
      from: isBusinessDate(from) ? from : addDays(today, -35),
      to: isBusinessDate(to) ? to : addDays(today, 365),
      ...(/^[0-9a-f-]{36}$/i.test(siteId) ? { siteId } : {}),
      ...(tile === 'overdue' || tile === 'dueSoon' ? { tile } : {}),
    }
  },
  async read(caller, query) {
    const answer = await readCalendar(caller, { from: query.from, to: query.to, late: true, ...(query.siteId ? { siteId: query.siteId } : {}) })
    const wanted = query.tile === 'overdue' ? 'OVERDUE' : query.tile === 'dueSoon' ? 'DUE_SOON' : null
    return { rows: wanted ? answer.items.filter((item) => item.state === wanted) : answer.items, next: null }
  },
  idOf: (row) => row.key,
  columns: {
    dueOn: { value: (row) => row.dueOn },
    what: { value: (row, words) => sentence(row, words) },
    site: { value: (row, words) => (row.site ? `${row.site.code} · ${row.site.name}` : fill(words('site.company'), { company: row.company.name })) },
    owner: { value: (row) => row.owner },
    evidence: { value: (row, words) => (row.evidence === null ? null : words(row.evidence.onFile ? 'evidence.onFile' : row.evidence.required ? 'evidence.missing' : 'evidence.none')) },
    state: { value: (row, words) => words(`state.${row.state}`) },
    keptOn: { value: (row, words) => words(`page.${row.source.page ?? 'none'}`) },
  },
  words: {
    it: {
      lang: 'it',
      'kind.DEADLINE': '{title}',
      'kind.DVR_REVIEW': 'Revisione della valutazione dei rischi: {assessment}',
      'kind.TRAINING_REFRESHER': 'Aggiornamento formazione {course}: 1 persona',
      'kind.TRAINING_REFRESHER_other': 'Aggiornamento formazione {course}: {count} persone',
      'kind.RLS_TRAINING': 'Aggiornamento annuale RLS ({course}): 1 persona',
      'kind.RLS_TRAINING_other': 'Aggiornamento annuale RLS ({course}): {count} persone',
      'kind.HEALTH_VISIT': '1 visita medica',
      'kind.HEALTH_VISIT_other': '{count} visite mediche',
      'kind.MACHINE_CHECK': 'Verifica periodica {check}: {asset}',
      'kind.INAIL_REPORT': 'Denuncia INAIL per {incident}',
      'kind.INAIL_REPORT_other': '{count} denunce INAIL per {incident}',
      'kind.APPOINTMENT_END': 'Fine incarico {role}: {person}',
      'kind.RLS_NOTICE': 'Comunicazione {role} all’INAIL: {person}',
      'kind.OTHER': 'Scadenza',
      'role.EMPLOYER': 'Datore di lavoro',
      'role.RSPP': 'RSPP',
      'role.ASPP': 'ASPP',
      'role.DOCTOR': 'Medico competente',
      'role.RLS': 'RLS',
      'role.RLST': 'RLS territoriale',
      'role.SUPERVISOR': 'Preposto',
      'role.MANAGER': 'Dirigente',
      'role.FIRST_AID': 'Addetto al primo soccorso',
      'role.FIRE_EMERGENCY': 'Addetto antincendio ed emergenze',
      'type.DRILL': 'Prova di evacuazione',
      'type.MEETING': 'Riunione periodica',
      'type.INSPECTION': 'Ispezione',
      'type.RENEWAL': 'Rinnovo',
      'type.AUTHORITY_REPORT': 'Comunicazione a un ente',
      'type.OTHER': 'Altro',
      'state.OVERDUE': 'Scaduta',
      'state.DUE_SOON': 'Entro 30 giorni',
      'state.PLANNED': 'In programma',
      'state.TO_CONFIRM': 'Termine da confermare',
      'state.DONE': 'Fatta',
      'state.CANCELLED': 'Annullata',
      'evidence.onFile': 'Evidenza caricata',
      'evidence.missing': 'Evidenza richiesta, mancante',
      'evidence.none': 'Nessuna evidenza richiesta',
      'site.company': 'Tutta l’azienda ({company})',
      'page.plant.calendar': 'Scadenzario sicurezza',
      'page.plant.preventive': 'Manutenzione programmata e verifiche',
      'page.plant.risk': 'Valutazione dei rischi (DVR)',
      'page.plant.health': 'Sorveglianza sanitaria',
      'page.plant.incidents': 'Infortuni e mancati infortuni',
      'page.people.skills': 'Competenze e formazione',
      'page.none': '—',
    },
    en: {
      lang: 'en',
      'kind.DEADLINE': '{title}',
      'kind.DVR_REVIEW': 'Risk assessment review: {assessment}',
      'kind.TRAINING_REFRESHER': '{course} refresher: 1 person',
      'kind.TRAINING_REFRESHER_other': '{course} refresher: {count} people',
      'kind.RLS_TRAINING': 'RLS yearly training ({course}): 1 person',
      'kind.RLS_TRAINING_other': 'RLS yearly training ({course}): {count} people',
      'kind.HEALTH_VISIT': '1 health visit',
      'kind.HEALTH_VISIT_other': '{count} health visits',
      'kind.MACHINE_CHECK': 'Statutory check {check}: {asset}',
      'kind.INAIL_REPORT': 'INAIL report for {incident}',
      'kind.INAIL_REPORT_other': '{count} INAIL reports for {incident}',
      'kind.APPOINTMENT_END': '{role} term ends: {person}',
      'kind.RLS_NOTICE': '{role} notice to INAIL: {person}',
      'kind.OTHER': 'Deadline',
      'role.EMPLOYER': 'Employer',
      'role.RSPP': 'RSPP',
      'role.ASPP': 'ASPP',
      'role.DOCTOR': 'Occupational doctor',
      'role.RLS': 'RLS',
      'role.RLST': 'Territorial RLS',
      'role.SUPERVISOR': 'Supervisor',
      'role.MANAGER': 'Manager',
      'role.FIRST_AID': 'First-aid team member',
      'role.FIRE_EMERGENCY': 'Fire and emergency team member',
      'type.DRILL': 'Evacuation drill',
      'type.MEETING': 'Periodic safety meeting',
      'type.INSPECTION': 'Inspection',
      'type.RENEWAL': 'Renewal',
      'type.AUTHORITY_REPORT': 'Report to an authority',
      'type.OTHER': 'Other',
      'state.OVERDUE': 'Overdue',
      'state.DUE_SOON': 'Due within 30 days',
      'state.PLANNED': 'Planned',
      'state.TO_CONFIRM': 'Deadline to confirm',
      'state.DONE': 'Done',
      'state.CANCELLED': 'Cancelled',
      'evidence.onFile': 'Evidence on file',
      'evidence.missing': 'Evidence asked, missing',
      'evidence.none': 'No evidence asked',
      'site.company': 'Whole company ({company})',
      'page.plant.calendar': 'Safety calendar',
      'page.plant.preventive': 'Preventive & statutory checks',
      'page.plant.risk': 'Risk assessment',
      'page.plant.health': 'Health surveillance',
      'page.plant.incidents': 'Incidents',
      'page.people.skills': 'Skills & training',
      'page.none': '—',
    },
  },
})
