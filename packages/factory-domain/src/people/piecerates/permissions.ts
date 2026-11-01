import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Piece rates and the legal switch of piece pay (B-W2b-34; apps/factory-api modules/people/piecerates; features MES-254,
 * MES-255, MES-262; design people.piecerates "Legal switch", "Rate table", pop-ups "New rate version", "Publish rates",
 * "Start piece pay"; c.c. arts. 2100-2101; W2b plan §3 GATE-PIECE-PAY), in the people area. Each is checked with can()
 * against the table's or the site's company and site. A pay figure (a rate per minute or per piece) is shown only to a
 * caller who also holds the pay grain (`money.pay`, auth/grains): HR and the worker.
 *
 *   people.piecerates.view    the rate tables, their versions (status, days, why changed, who has read them), the
 *                             publications and the legal switch with its preconditions; without the pay grain the
 *                             operations and standard minutes only (administrator, production manager; owner and
 *                             read-only through the registry)
 *   people.piecerates.manage  tables, new rate versions and their rates, publishing a version to the workers and putting
 *                             it in force, confirming a provisional rate, recording a signed paper copy, the switch's
 *                             preconditions. No template lists it: typing a rate needs the pay grain (HR), and the Owner
 *                             holds it through every office permission.
 *   people.piecerates.switch  "Start piece pay" at a site (a fresh code) once every precondition is on record, and
 *                             stopping it (never asks). No template lists it: the Owner's decision (GATE-PIECE-PAY).
 */
export const PEOPLE_PIECERATES_DEFINITIONS = definePermissions('people', {
  'piecerates.view': {
    risk: 'read',
    description:
      'See the piece-rate tables of a site: each version of the rates with its days, status (provisional until, confirmed, superseded) and why it changed, its publications to the workers and who has read them, and the legal switch of piece pay with what it still needs. The rates themselves only with the pay grain.',
  },
  'piecerates.manage': {
    risk: 'write',
    description:
      'Keep the piece-rate tables: make a new version of the rates with a reason (never an edit of rates in force), publish it to the workers on the floor or on paper before it applies, put it in force, confirm a provisional rate after its trial, record a signed paper copy, and record what piece pay rests on (the CCNL and its article, the worker notice, the impact assessment, the labour consultant, the scheme).',
  },
  'piecerates.switch': {
    risk: 'stepUp',
    description:
      'Start piece pay at a site from a day, once every legal precondition is on record (asks for a fresh code), or stop it (never asks). Pay earned in an earlier window stays payable.',
  },
})

export const PEOPLE_PIECERATES_VIEW = 'people.piecerates.view' satisfies Permission
export const PEOPLE_PIECERATES_MANAGE = 'people.piecerates.manage' satisfies Permission
export const PEOPLE_PIECERATES_SWITCH = 'people.piecerates.switch' satisfies Permission

export const PEOPLE_PIECERATES_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_PIECERATES_VIEW, PEOPLE_PIECERATES_MANAGE, PEOPLE_PIECERATES_SWITCH])
