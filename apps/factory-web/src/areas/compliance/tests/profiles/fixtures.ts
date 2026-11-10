import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { NOW, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../../quality/_shared/fixtures'
import { failedRead, ready, reading } from '../../../quality/_shared/model'
import { demoProfiles, PROFILES } from '../substances/_demo/fixtures'
import { ProfilesDesign, type ProfilesCase } from '../substances/_demo/designs/fixtures'
import { profilesAddressOf, profilesCan, type ProfilesAddress } from './model'
import type { ProfilesViewModel } from './view/ProfilesView'

/**
 * SCR-054-profiles — Compliance › Tests & substances › Material profiles (B-W2b-267; design compliance.tests sec:ts-profiles).
 * Made-up materials and suppliers only. The list with its columns (composition and tannage with their confirmations, required
 * tests, declarations present / asked / missing, PPE innocuousness per parameter, the evaluator's state with what keeps it
 * from complete in our words), the incomplete-profiles tile pressed, filters, a selection (Request declarations N, Evaluate
 * again N, CSV N), the empty, loading, failed and offline states, and the role cases. A row opens the material's Compliance tab
 * (its card is SCR-048-profile).
 */

const address = (over: Partial<ProfilesAddress> = {}): ProfilesAddress => ({ ...profilesAddressOf(null), ...over })

export function profilesModel(over: Partial<Omit<ProfilesViewModel, 'frame'>> = {}, role: RoleCase = 'owner', active: ProfilesCase['active'] = null): ProfilesCase {
  return {
    role,
    active,
    model: {
      prefix: PREFIX,
      can: profilesCan([...ROLE_PERMISSIONS[role]]),
      online: true,
      address: address(),
      list: ready(demoProfiles()),
      asOf: NOW,
      live: 'live',
      updates: 0,
      selected: [],
      notice: null,
      busy: false,
      keysOpen: false,
      ...over,
    },
  }
}

const incomplete = PROFILES.filter((row) => row.state === 'INCOMPLETE')

export const designScreen = defineDesignScreen<ProfilesCase>({
  screen: 'SCR-054-profiles',
  title: 'Tests & substances › Material profiles',
  view: ProfilesDesign,
  cases: [
    { id: 'list', label: 'Owner: every material with its profile', model: profilesModel(), note: 'The state is the evaluator’s: it changes with the evidence, never by hand. A row opens the material’s Compliance tab.' },
    { id: 'tile-incomplete', label: 'Tile pressed: materials with an incomplete profile', model: profilesModel({ address: address({ state: 'INCOMPLETE' }), list: ready(demoProfiles(incomplete)) }, 'owner', 'profilesIncomplete') },
    { id: 'filter-kind', label: 'Kind ▾ Leather', model: profilesModel({ address: address({ kind: 'LEATHER' }), list: ready(demoProfiles(PROFILES.filter((row) => row.material.kind === 'LEATHER'))) }) },
    { id: 'filtered-empty', label: 'No material matches these filters', model: profilesModel({ address: address({ q: 'zzz' }), list: ready(demoProfiles([])) }) },
    { id: 'empty', label: 'No materials yet', model: profilesModel({ list: ready({ ...demoProfiles([]), counts: { materials: 0, none: 0, incomplete: 0, complete: 0, blocked: 0 } }) }) },
    { id: 'selected', label: 'Selection: Request declarations for 2, Evaluate 2 again, CSV of 2', model: profilesModel({ selected: [PROFILES[0]!.material.id, PROFILES[3]!.material.id] }) },
    { id: 'notice', label: 'A receipt after Evaluate again', model: profilesModel({ notice: { key: 'done.evaluated', params: { count: 2, changed: 1 }, tone: 'success' } }) },
    { id: 'live-updates', label: 'Live: 3 profiles evaluated again behind Show', model: profilesModel({ updates: 3 }) },
    { id: 'loading', label: 'Loading', model: profilesModel({ list: reading(), asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer", model: profilesModel({ list: failedRead('problem.unavailable'), asOf: null, live: 'offline' }) },
    { id: 'offline', label: 'Offline: the bulk actions held with why', model: profilesModel({ online: false, live: 'offline', selected: [PROFILES[0]!.material.id] }) },
    { id: 'read-only', label: 'Read-only: reads every profile; asking and evaluating held with why', model: profilesModel({ selected: [PROFILES[0]!.material.id] }, 'readOnly') },
    { id: 'production', label: 'Production manager: reads (no lot tiles)', model: profilesModel({}, 'production') },
    { id: 'no-permission', label: 'Sales: no permission', model: profilesModel({}, 'sales') },
    { id: 'keys', label: 'The keys (?)', model: profilesModel({ keysOpen: true }) },
  ],
})
