import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { PACK, PACK_PDF, PREFIX, ROLES_DEMO } from '../../_demo/fixtures'
import { declarationsCan } from '../../model'
import type { PackWindowModel } from '../../view-model'
import { PackWindowView } from '../view/WindowsView'

/**
 * SCR-052-pack — the shipment compliance pack window (B-W2b-268; design tab:dc-pack; PRD-300; a window page, a new tab). Made-up
 * data only; the PDF is a small made-up one. The warehouse builds packs; the read-only role reads them.
 */

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const base = (over: Partial<PackWindowModel> = {}): PackWindowModel => ({
  prefix: PREFIX,
  can: declarationsCan(ROLES_DEMO.warehouse),
  shipmentId: PACK.shipment.id,
  pack: ready(PACK),
  versionId: PACK.versions[1]!.id,
  pdf: ready(PACK_PDF),
  busy: null,
  notice: null,
  problem: null,
  online: true,
  ...over,
})

export const designScreen = defineDesignScreen<PackWindowModel>({
  screen: 'SCR-052-pack',
  title: 'Shipment compliance pack (PDF / ZIP, a new tab)',
  view: PackWindowView,
  cases: [
    { id: 'normal', label: 'Warehouse: what the pack holds, its versions, the PDF and the ZIP', model: base(), note: 'The buyer reads German: the Italian documents are a fallback (warning). Make a version; Make and share gives its PDF to the customer.' },
    { id: 'made', label: 'After Make: nothing changed, the newest again', model: base({ notice: { tone: 'success', key: 'pack.same', params: { version: 2 } } }) },
    { id: 'refused', label: 'A signed leaflet is missing: the pack is refused, Make held', model: base({ pack: ready({ ...PACK, refusals: [{ code: 'DOCUMENT_MISSING' }], versions: [] }), versionId: null, pdf: null }) },
    { id: 'no-versions', label: 'No version yet', model: base({ pack: ready({ ...PACK, versions: [] }), versionId: null, pdf: null }) },
    { id: 'read-only', label: 'Read-only role: reads; Make held with the reason', model: base({ can: declarationsCan(ROLES_DEMO.readOnly) }) },
    { id: 'zip', label: 'The ZIP being made', model: base({ busy: 'zip' }) },
    { id: 'failed-make', label: 'Make refused by the database', model: base({ problem: { key: 'refusal.DATABASE', field: null } }) },
    { id: 'offline', label: 'Offline: Make held', model: base({ online: false }) },
    { id: 'loading', label: 'Loading', model: base({ pack: { status: 'loading' }, pdf: null }) },
    { id: 'forbidden', label: 'Another company\'s shipment', model: base({ pack: { status: 'error', problem: 'problem.forbidden' } }) },
    { id: 'error', label: 'Failed read', model: base({ pack: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'no-shipment', label: 'No shipment named', model: base({ shipmentId: null, pack: null }) },
  ],
})
