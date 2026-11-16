import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_GRAINS, demoRecord, demoRows, demoTask, demoVersions, versionsModel } from './demo/fixtures'
import type { CostSheetsModel } from './view/CostSheetsView'
import { CostSheetsView } from './view/CostSheetsView'

/**
 * SCR-500 — Style › Cost › Cost sheet versions and approval (B-W2b-430), made-up data only (see demo/fixtures.ts): the
 * versions of DEMO-JKT-01, the version in view, every action held with why, every dialog, and the roles the design names —
 * the Owner, a cost engineer (writes drafts, no decision), the costing owner (approves), the production manager (no money)
 * and a reader.
 */

const rows = demoRows()
const withV4 = demoRows({ withV4: true })
const approved = demoRows({ v3: 'approved' })
const model = (versions: Parameters<typeof versionsModel>[0] = {}, role: Parameters<typeof versionsModel>[1] = 'owner', grains = DEMO_GRAINS.all): CostSheetsModel => ({ versions: versionsModel(versions, role, grains) })

export const designScreen = defineDesignScreen<CostSheetsModel>({
  screen: 'SCR-500',
  title: 'Style › Cost: cost sheet versions and approval',
  view: CostSheetsView,
  cases: [
    { id: 'waiting-owner', label: 'Version 3 waits; the Owner may approve it', model: model(), note: 'Approve and lock is the approval engine\'s yes; the approved version 2 is frozen when version 3 is approved.' },
    { id: 'waiting-asked-by-me', label: 'Version 3 waits: I asked for it', model: model({ task: { status: 'ready', value: demoTask({ mine: true }) } }), note: 'Approve and lock is held: "You asked for it: another person approves it."' },
    { id: 'engineer-draft', label: 'Cost engineer: a new draft (version 4)', model: model({ list: { status: 'ready', value: demoVersions(withV4) }, inView: withV4[3]!, record: { status: 'ready', value: demoRecord(withV4[3]!) }, task: null }, 'engineer', DEMO_GRAINS.cost), note: 'Cost grain only: no target price or margin; Send for approval and Delete draft.' },
    { id: 'approved', label: 'The costing owner: version 3 approved and locked', model: model({ list: { status: 'ready', value: demoVersions(approved) }, inView: approved[2]!, record: { status: 'ready', value: demoRecord(approved[2]!) }, task: null }, 'costingOwner'), note: 'Take back asks a reason; a change is a copy as a new version.' },
    { id: 'frozen', label: 'Version 1: frozen, replaced', model: model({ inView: rows[0]!, record: { status: 'ready', value: demoRecord(rows[0]!) }, task: null }) },
    { id: 'production', label: 'Production manager: no money', model: model({ task: null }, 'production', DEMO_GRAINS.none), note: 'No cost column, no figure; every write held with the missing right.' },
    { id: 'reader', label: 'A reader (costing.view only)', model: model({}, 'reader') },
    { id: 'left-out', label: 'A draft written with an input left out', model: model({ list: { status: 'ready', value: demoVersions(withV4) }, inView: withV4[3]!, record: { status: 'ready', value: demoRecord(withV4[3]!, { leftOut: true }) }, task: null }) },
    { id: 'new-dialog', label: 'New version from revision 2', model: model({ dialog: { kind: 'new', from: 'COMPONENTS' }, draft: { piecesPerCarton: '12', targetPrice: '260', targetMarginPct: '42' } }) },
    { id: 'new-refused', label: 'New version refused: inputs missing', model: model({ dialog: { kind: 'new', from: 'COMPONENTS' }, problem: { key: 'verRefusal.INCOMPLETE' } }), note: 'The refusal in words from its code; the typed values stay.' },
    { id: 'copy-dialog', label: 'Copy version 2 as a new version', model: model({ dialog: { kind: 'new', from: 'COPY', basedOnId: rows[1]!.id } }) },
    { id: 'send-dialog', label: 'Send for approval (an input left out)', model: model({ list: { status: 'ready', value: demoVersions(withV4) }, inView: withV4[3]!, record: { status: 'ready', value: demoRecord(withV4[3]!, { leftOut: true }) }, task: null, dialog: { kind: 'send' } }) },
    { id: 'approve-dialog', label: 'Approve and lock version 3', model: model({ dialog: { kind: 'approve' } }) },
    { id: 'step-up', label: 'An approval rule asks for a fresh code', model: model({ dialog: { kind: 'approve' }, busy: true, stepUp: { open: true, busy: false, problem: null } }) },
    { id: 'take-back-dialog', label: 'Take back version 3', model: model({ list: { status: 'ready', value: demoVersions(approved) }, inView: approved[2]!, record: { status: 'ready', value: demoRecord(approved[2]!) }, task: null, dialog: { kind: 'takeBack' }, draft: { reason: 'Prezzo pelle sbagliato' } }, 'costingOwner') },
    { id: 'remove-dialog', label: 'Delete draft version 3 (its request withdrawn)', model: model({ dialog: { kind: 'remove' } }) },
    { id: 'approved-notice', label: 'Done: version 3 approved', model: model({ list: { status: 'ready', value: demoVersions(approved) }, inView: approved[2]!, record: { status: 'ready', value: demoRecord(approved[2]!) }, task: null, notice: { tone: 'success', words: { key: 'verNotice.approved', params: { version: 3 } } } }) },
    { id: 'empty', label: 'No version yet', model: model({ list: { status: 'ready', value: demoVersions([]) }, inView: null, record: { status: 'idle' }, task: null }) },
    { id: 'loading', label: 'Loading', model: model({ list: { status: 'loading' }, inView: null }) },
    { id: 'error', label: 'Could not read', model: model({ list: { status: 'error', problem: 'verProblem.read.unavailable' }, inView: null }) },
    { id: 'version-error', label: 'The version in view could not be read', model: model({ record: { status: 'error', problem: 'verProblem.read.unavailable' } }) },
    // ---- B-W2b-GB02 (G054): commissions and typed lines on a draft
    { id: 'gb02-typed-lines', label: 'GB02 — Draft version 3: an agent’s 5 % commission and a payment fee', model: model({ record: { status: 'ready', value: demoRecord(rows[2]!, { typed: true }) }, task: null, list: { status: 'ready', value: demoVersions(demoRows({ v3: 'draft' })) }, inView: demoRows({ v3: 'draft' })[2]! }), note: 'The commission is 5 % of the target price 260.00 (it follows the price); Remove on each typed line.' },
    { id: 'gb02-typed-dialog', label: 'GB02 — Type a line: a commission in percent', model: model({ list: { status: 'ready', value: demoVersions(demoRows({ v3: 'draft' })) }, inView: demoRows({ v3: 'draft' })[2]!, task: null, dialog: { kind: 'typed' }, draft: { typed: { label: 'Agente Esempio Nord', pct: '5' } } }), note: 'The line costs 13.00: 5 % of the target price.' },
    { id: 'gb02-typed-amount', label: 'GB02 — Type a line: a payment fee as an amount for size 58', model: model({ list: { status: 'ready', value: demoVersions(demoRows({ v3: 'draft' })) }, inView: demoRows({ v3: 'draft' })[2]!, task: null, dialog: { kind: 'typed' }, draft: { typed: { mode: 'amount', label: 'Commissione di pagamento', size: '58', quantity: '1', unitCost: '1,50' } } }) },
    { id: 'gb02-typed-no-target', label: 'GB02 — Type a commission: the version has no target price', model: model({ list: { status: 'ready', value: demoVersions(withV4) }, inView: withV4[3]!, record: { status: 'ready', value: demoRecord(withV4[3]!) }, task: null, dialog: { kind: 'typed' }, draft: { typed: { mode: 'percent', label: 'Agente Esempio Nord', pct: '5' } } }), note: 'Held in words: give the version a target price first, or type the commission as an amount.' },
    { id: 'gb02-typed-refused', label: 'GB02 — Typed line refused: no target price (from the API)', model: model({ list: { status: 'ready', value: demoVersions(demoRows({ v3: 'draft' })) }, inView: demoRows({ v3: 'draft' })[2]!, task: null, dialog: { kind: 'typed' }, draft: { typed: { label: 'Agente Esempio Nord', pct: '5' } }, problem: { key: 'verRefusal.NEEDS_TARGET' } }) },
    { id: 'gb02-remove-typed', label: 'GB02 — Remove a typed line', model: model({ record: { status: 'ready', value: demoRecord(rows[2]!, { typed: true }) }, task: null, list: { status: 'ready', value: demoVersions(demoRows({ v3: 'draft' })) }, inView: demoRows({ v3: 'draft' })[2]!, dialog: { kind: 'removeTyped', lineId: demoRecord(rows[2]!, { typed: true }).lines.at(-1)!.id } }) },
    { id: 'gb02-typed-approved', label: 'GB02 — Approved version 3 with its commission: locked', model: model({ list: { status: 'ready', value: demoVersions(approved) }, inView: approved[2]!, record: { status: 'ready', value: demoRecord(approved[2]!, { typed: true }) }, task: null }, 'costingOwner'), note: 'No Type a line, no Remove: a change is a new version.' },
    { id: 'gb02-typed-no-grain', label: 'GB02 — Production manager: typed lines without figures', model: model({ record: { status: 'ready', value: demoRecord(rows[2]!, { typed: true }) }, task: null }, 'production', DEMO_GRAINS.none) },
    { id: 'gb02-refresh-refused', label: 'GB02 — Read the size mix again: nothing changes', model: model({ list: { status: 'ready', value: demoVersions(demoRows({ v3: 'draft' })) }, inView: demoRows({ v3: 'draft' })[2]!, task: null, problem: { key: 'verRefusal.NOTHING_CHANGES' } }), note: 'A refusal made outside a dialog is said on the card.' },
    // ---- end B-W2b-GB02
  ],
})
