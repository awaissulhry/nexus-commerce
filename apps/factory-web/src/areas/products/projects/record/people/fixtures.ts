import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { ProjectPeople } from '../../api'
import { NO_MANAGE } from '../../model'
import { peopleBlockOf, type AddDialogModel, type PeopleBlockModel, type PeopleFacts } from './model'
import { PeopleBlock } from './view/PeopleBlock'

/**
 * SCR-701-people — a project's People (B-TH-250), made-up people only: our team at the factory, Brand Alpha's portal people (the
 * project's outside company), a contact invited by link. Every case is the pure view with the model the container builds.
 */

const NOW = Date.parse('2026-11-17T10:00:00.000Z')
const ME = 'u0000000-0000-4000-8000-000000000001'
const LEAD = 'u0000000-0000-4000-8000-000000000002'

const alpha = { id: 'a1a1a1a1-0000-4000-8000-0000000000a1', code: 'BRAND-ALPHA', name: 'Brand Alpha', roles: ['CUSTOMER'] }
const marco = { id: LEAD, name: 'Marco Neri' }

const project = (over: Partial<PeopleFacts['project']> = {}): PeopleFacts['project'] => ({
  number: 'PRJ-26-012',
  party: alpha,
  lead: marco,
  status: 'ACTIVE',
  may: { manage: true, post: true, moves: ['HOLD', 'CLOSE'] },
  ...over,
})

const facts = (over: Partial<PeopleFacts> = {}, projectOver: Partial<PeopleFacts['project']> = {}): PeopleFacts => ({ project: project(projectOver), meId: ME, offline: false, busy: false, ...over })

const team: ProjectPeople['office']['people'] = [
  { userId: LEAD, name: 'Marco Neri', lead: true, me: false, reason: 'CREATOR', addedBy: null, muted: false, since: '2026-10-02T08:30:00.000Z' },
  { userId: ME, name: 'Giulia Ferri', lead: false, me: true, reason: 'ADDED', addedBy: marco, muted: false, since: '2026-10-02T08:31:00.000Z' },
  { userId: 'u0000000-0000-4000-8000-000000000003', name: 'Paolo Conti', lead: false, me: false, reason: 'MENTIONED', addedBy: null, muted: true, since: '2026-10-20T14:05:00.000Z' },
  { userId: 'u0000000-0000-4000-8000-000000000004', name: 'Sara Galli', lead: false, me: false, reason: 'CHOSE', addedBy: null, muted: false, since: '2026-11-03T09:12:00.000Z' },
]

const withCustomer: ProjectPeople = {
  office: { count: team.length, people: team },
  outside: {
    count: 2,
    people: [
      { userId: 'p0000000-0000-4000-8000-0000000000a1', name: 'Anna Alfieri', reason: 'ADDED', addedBy: marco, since: '2026-10-05T10:00:00.000Z' },
      { userId: 'p0000000-0000-4000-8000-0000000000a2', name: 'Arturo Albani', reason: 'ADDED', addedBy: { id: ME, name: 'Giulia Ferri' }, since: '2026-11-10T16:20:00.000Z' },
    ],
  },
  invited: {
    count: 2,
    people: [
      { shareId: 's0000000-0000-4000-8000-0000000000a1', name: 'Alma Alfieri', email: 'alma.alfieri@brand-alpha.example', until: '2027-03-12T23:00:00.000Z', permissions: ['view', 'comment'] },
      { shareId: 's0000000-0000-4000-8000-0000000000a2', name: null, email: 'studio@designer.example', until: '2026-11-15T23:00:00.000Z', permissions: ['view'] },
    ],
  },
}

const officeOnlyPeople: ProjectPeople = { office: { count: 3, people: team.slice(0, 3) }, outside: { count: 0, people: [] }, invited: { count: 0, people: [] } }
const onlyMePeople: ProjectPeople = { office: { count: 1, people: [{ ...team[1]!, reason: 'CREATOR', addedBy: null, lead: false }] }, outside: { count: 0, people: [] }, invited: { count: 0, people: [] } }

const NAMES = ['Ada', 'Bruno', 'Carla', 'Dario', 'Elena', 'Fabio', 'Gaia', 'Ivo', 'Luca', 'Marta']
const many: ProjectPeople = {
  office: {
    count: 312,
    people: [
      team[0]!,
      team[1]!,
      ...Array.from({ length: 198 }, (_, index) => ({
        userId: `u1000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: `${NAMES[index % NAMES.length]} Esempio ${index + 1}`,
        lead: false,
        me: false,
        reason: 'ADDED' as const,
        addedBy: marco,
        muted: false,
        since: '2026-10-10T09:00:00.000Z',
      })),
    ],
  },
  outside: { count: 0, people: [] },
  invited: { count: 0, people: [] },
}

const dialog = (over: Partial<AddDialogModel>): AddDialogModel => ({ kind: 'team', q: '', choices: [], problem: null, mayAddOutside: true, busy: null, notice: null, offline: false, ...over })

/** The two models the project page's design cases show in its side column (SCR-701). */
export const PEOPLE_DEMO: { customer: PeopleBlockModel; officeOnly: PeopleBlockModel } = {
  customer: peopleBlockOf({ people: withCustomer, facts: facts(), now: NOW }),
  officeOnly: peopleBlockOf({ people: officeOnlyPeople, facts: facts({}, { party: null }), now: NOW }),
}

export const designScreen = defineDesignScreen<PeopleBlockModel>({
  screen: 'SCR-701-people',
  title: 'Project people',
  view: PeopleBlock,
  cases: [
    { id: 'customer', label: 'With a customer', model: PEOPLE_DEMO.customer, note: 'Our team (Lead, why, muted, since), Brand Alpha’s portal people with their company on every row, invited by link (one ended).' },
    { id: 'office-only', label: 'Office only', model: PEOPLE_DEMO.officeOnly, note: 'No outside group and no outside add: an office-only project has no outside people.' },
    { id: 'only-you', label: 'Only you', model: peopleBlockOf({ people: onlyMePeople, facts: facts({}, { party: null, lead: { id: ME, name: 'Giulia Ferri' } }), now: NOW }), note: '“Only you. Add a colleague.”; the lead neither leaves nor is taken out.' },
    { id: 'many', label: '312 people', model: peopleBlockOf({ people: many, facts: facts({}, { party: null }), now: NOW }), note: 'The first 200 and the exact count (312).' },
    {
      id: 'add-colleague',
      label: 'Add a colleague',
      model: peopleBlockOf({
        people: withCustomer,
        facts: facts(),
        now: NOW,
        dialog: dialog({ kind: 'team', choices: [{ userId: 'u0000000-0000-4000-8000-000000000005', name: 'Elisa Moro' }, { userId: 'u0000000-0000-4000-8000-000000000006', name: 'Tommaso Riva' }] }),
      }),
    },
    {
      id: 'add-outside',
      label: 'Add Brand Alpha people',
      model: peopleBlockOf({ people: withCustomer, facts: facts(), now: NOW, dialog: dialog({ kind: 'outside', choices: [{ userId: 'p0000000-0000-4000-8000-0000000000a3', name: 'Alessia Amato' }] }) }),
      note: 'Only the project’s outside company’s portal people, as the API offers them.',
    },
    { id: 'nobody-left', label: 'Nobody left to add', model: peopleBlockOf({ people: withCustomer, facts: facts(), now: NOW, dialog: dialog({ kind: 'team', choices: [] }) }) },
    {
      id: 'refused',
      label: 'Refused in words',
      model: peopleBlockOf({
        people: withCustomer,
        facts: facts(),
        now: NOW,
        dialog: dialog({ kind: 'outside', choices: [{ userId: 'p0000000-0000-4000-8000-0000000000a3', name: 'Alessia Amato' }], notice: { key: 'refusal.MEMBER_OTHER_PARTY', tone: 'danger' } }),
      }),
      note: 'The API’s refusal said from its code, naming no other company.',
    },
    {
      id: 'remove',
      label: 'Take a person out',
      model: peopleBlockOf({ people: withCustomer, facts: facts(), now: NOW, confirm: { kind: 'remove', row: peopleBlockOf({ people: withCustomer, facts: facts(), now: NOW }).outside!.rows[0]!, busy: false, notice: null } }),
    },
    {
      id: 'read-only',
      label: 'Read only',
      model: peopleBlockOf({ people: withCustomer, facts: facts({}, { may: { manage: false, post: false, moves: [] } }), now: NOW }),
      note: `Every add and take-out held with why (${NO_MANAGE.key}, the right in words).`,
    },
    { id: 'closed', label: 'Closed project', model: peopleBlockOf({ people: withCustomer, facts: facts({}, { status: 'CLOSED' }), now: NOW }), note: 'A closed project takes no people until it is reopened.' },
    { id: 'offline', label: 'Offline', model: peopleBlockOf({ people: withCustomer, facts: facts({ offline: true }), now: NOW }) },
  ],
})
