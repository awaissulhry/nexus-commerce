import { defineDesignScreen } from '../../lib/design/design-screen'
import { signedInFrame, onFloor } from '../frame/fixtures'
import { homeTiles, type FloorMode } from '../model'
import { HomeView, type HomeViewModel } from './view/HomeView'

/**
 * SCR-022's cases: the floor frame (operator chip, offline banner with the queue's counts, Help, operator menu, idle
 * sign-out) around the tile home, per station mode and per person's floor permissions, and the offline queue's states. Made-up people and places only. The tiles come from the
 * same rule as the live page (model.ts `homeTiles`): only Scan anything is built; every other tile says "Coming soon".
 */

const OPERATOR = ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer', 'inventory.issue', 'production.cut', 'shipping.pack']
const INSPECTOR = ['floor.work', 'print.view', 'print.labels', 'inventory.locations.view', 'inventory.transfer']

const home = (mode: FloorMode | null, extra: Partial<HomeViewModel> = {}, permissions = OPERATOR, blocks = false): HomeViewModel => ({
  frame: signedInFrame('home.title', { showHome: false }),
  mode,
  tiles: homeTiles(mode, permissions, blocks),
  notice: { due: blocks, blocksScans: blocks },
  ...extra,
})

export const designScreen = defineDesignScreen<HomeViewModel>({
  screen: 'SCR-022',
  title: 'Floor shell & tile home',
  view: onFloor(HomeView),
  cases: [
    { id: 'cutting', label: 'Cutting table (operator)', model: home('cutting'), note: 'Mode from the station\'s work centre (CUTTING). Scan anything opens; Cut a hide and Bundles say "Coming soon" on the tile.' },
    { id: 'sewing', label: 'Sewing station', model: home('sewing', { frame: signedInFrame('home.title', { showHome: false, station: { name: 'SEW-04 · Linea 2 St 4', site: 'Stabilimento Demo Nord' } }) }) },
    { id: 'packing', label: 'Packing bench', model: home('packing', { frame: signedInFrame('home.title', { showHome: false, station: { name: 'PACK-01 · Banco imballo', site: 'Stabilimento Demo Nord' } }) }) },
    { id: 'inspection', label: 'Inspection bench (inspector)', model: home('inspection', { frame: signedInFrame('home.title', { showHome: false, station: { name: 'QC-01 · Banco collaudo', site: 'Stabilimento Demo Nord' } }) }, INSPECTOR) },
    {
      id: 'warehouse',
      label: 'Warehouse device (no station)',
      model: home('warehouse', { frame: signedInFrame('home.title', { showHome: false, station: { name: null, site: 'Stabilimento Demo Nord' } }) }),
      note: 'A device with no station is a warehouse device. Receive needs an office permission no floor role holds yet: the tile is not shown (fail closed).',
    },
    {
      id: 'notice-blocks',
      label: 'Worker notice due: scans held',
      model: home('cutting', {}, OPERATOR, true),
      note: 'The site names workers and this worker has not acknowledged the version in force: every scan tile says "Read the notice first"; the card opens the notice (SCR-025).',
    },
    {
      id: 'notice-due',
      label: 'Worker notice due (station site, not blocking)',
      model: { ...home('cutting'), notice: { due: true, blocksScans: false } },
      note: 'A site that records stations only: the notice is shown, nothing is held.',
    },
    { id: 'no-tiles', label: 'Nothing to do with this role', model: home('cutting', {}, ['print.view']), note: 'A worker without floor.work: no tile, the words say whom to ask.' },
    { id: 'operator-menu', label: 'Operator menu open', model: home('cutting', { frame: signedInFrame('home.title', { showHome: false, menuOpen: true }) }), note: 'Switch person (scan a badge), the language for this session, Sign out.' },
    { id: 'help', label: 'Help open', model: home('cutting', { frame: signedInFrame('home.title', { showHome: false, helpOpen: true }) }), note: 'W1: words only; calling for help is W2b.' },
    {
      id: 'idle',
      label: 'Idle sign-out countdown',
      model: home('cutting', { frame: signedInFrame('home.title', { showHome: false, idle: { warning: true, secondsLeft: 21 } }) }),
      note: 'After the site\'s idle minutes less 30 seconds: "I am here" or Esc stays; zero signs out.',
    },
    {
      id: 'offline',
      label: 'Offline, nothing waiting',
      model: home('cutting', { frame: signedInFrame('home.title', { showHome: false, online: false }), offline: { held: null } }),
      note: 'B-W0-30: every action at a cutting table is saved on this tablet and sent when the network is back.',
    },
    {
      id: 'queue-online',
      label: 'Online, everything recorded',
      model: home('sewing', { frame: signedInFrame('home.title', { showHome: false, lastSentAt: '2026-10-29T09:58:00.000Z' }) }),
      note: 'Nothing waits: the banner leaves (it comes back the moment an action waits).',
    },
    {
      id: 'queue-offline-pending',
      label: 'Offline, 4 actions waiting',
      model: home('cutting', { frame: signedInFrame('home.title', { showHome: false, online: false, pending: 4, lastSentAt: '2026-10-29T09:38:00.000Z' }), offline: { held: null } }),
      note: 'The waiting count as a big number, the last send, and Open queue (Waiting to send, SCR-023).',
    },
    {
      id: 'queue-sending',
      label: 'Back online: sending',
      model: home('cutting', { frame: signedInFrame('home.title', { showHome: false, pending: 3, lastSentAt: '2026-10-29T09:38:00.000Z' }) }),
      note: 'Online with actions still on their way: they go in the queue\'s order, one send at a time.',
    },
    {
      id: 'queue-refused',
      label: 'An action was refused',
      model: home('sewing', { frame: signedInFrame('home.title', { showHome: false, pending: 1, refused: 1, lastSentAt: '2026-10-29T09:58:00.000Z' }) }),
      note: 'The banner turns red with the refused count; Open queue shows why in words and the one fix.',
    },
    {
      id: 'held-network',
      label: 'Offline at the inspection bench',
      model: home('inspection', { frame: signedInFrame('home.title', { showHome: false, online: false, station: { name: 'QC-01 · Banco collaudo', site: 'Stabilimento Demo Nord' } }), offline: { held: 'inspect' } }, INSPECTOR),
      note: 'Inspections and releases take their number from the office at once: they wait for the network (never queued). Scans still go on.',
    },
    {
      id: 'held-network-warehouse',
      label: 'Offline at the warehouse',
      model: home('warehouse', { frame: signedInFrame('home.title', { showHome: false, online: false, station: { name: null, site: 'Stabilimento Demo Nord' } }), offline: { held: 'receive' } }),
      note: 'A goods receipt and its lots take their numbers from the office at once: receiving waits for the network.',
    },
    {
      id: 'numbers-low',
      label: 'Bundle ticket numbers running low (offline)',
      model: home('cutting', { frame: signedInFrame('home.title', { showHome: false, online: false, pending: 6 }), offline: { held: null }, lowNumbers: [{ kind: 'BUNDLE', left: 12 }] }),
      note: 'Tickets printed offline take numbers from this tablet\'s own block; it tops up by itself with the next send.',
    },
    { id: 'switched', label: 'Person switched by a badge', model: home('cutting', { switched: { from: 'Bea Esempio', to: 'Ada Demo' } }), note: 'The next person scanned their badge on Home (badge-only site): one line says who left and who is on.' },
    { id: 'badge-refused', label: 'A badge that does not open this tablet', model: home('cutting', { badgeRefused: true }), note: 'The person signed in stays.' },
  ],
})
