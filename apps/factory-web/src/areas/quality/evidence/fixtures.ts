import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { failedRead, ready, reading } from '../_shared/model'
import { inShell, NOW, PREFIX, type RoleCase } from '../_shared/fixtures'
import { EVIDENCE, EVIDENCE_GAPS, EVIDENCE_SERIAL } from '../inspections/demo/fixtures'
import type { EvidenceModel } from './model'
import { EvidenceTrailView } from './view/EvidenceTrailView'

/**
 * The evidence trail of SCR-076 (design compliance.techfiles#evidence-trail; Owner answer Q2 (a): read only in W1) —
 * made-up data only: a Demo batch with every proof present, one with gaps (a lot failed Cr VI later, no leaflet, an open
 * register entry), one garment serial, and the read states. Opened in a new tab from an inspection or a register entry.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: EvidenceModel
}

const trail = (over: Partial<EvidenceModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  model: { prefix: PREFIX, kind: 'batch', subject: 'DEMO-BT-0142', can: { view: role !== 'sales' }, evidence: ready(EVIDENCE), asOf: NOW, ...over },
})

function EvidenceDesign({ model }: { model: DesignModel }) {
  return inShell('/compliance/evidence', createElement(EvidenceTrailView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-076-evidence',
  title: 'Evidence trail (read only)',
  view: EvidenceDesign,
  cases: [
    { id: 'batch', label: 'A batch: everything required is present', model: trail(), note: 'Production is counted per operation, never per person; no cost, price or wage.' },
    { id: 'gaps', label: 'A batch with gaps: a lot failed Cr VI later, no leaflet, an open register entry', model: trail({ evidence: ready(EVIDENCE_GAPS) }) },
    { id: 'serial', label: 'One garment by its serial', model: trail({ kind: 'serial', subject: 'DEMO-SN-0142-017', evidence: ready(EVIDENCE_SERIAL) }) },
    { id: 'production', label: 'Production manager: the same trail', model: trail({}, 'production') },
    { id: 'loading', label: 'Loading', model: trail({ evidence: reading(), asOf: null }) },
    { id: 'not-found', label: 'Nothing found (or not in your companies and customers)', model: trail({ evidence: failedRead('problem.notFound'), asOf: null }) },
    { id: 'error', label: "The API didn't answer", model: trail({ evidence: failedRead('problem.unavailable'), asOf: null }) },
    { id: 'bad-address', label: 'An address that names no batch or serial', model: trail({ kind: null }) },
    { id: 'no-permission', label: 'Sales: no permission', model: trail({}, 'sales') },
  ],
})
