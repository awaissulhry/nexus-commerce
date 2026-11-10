import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, ROLE_PERMISSIONS, type RoleCase } from '../../../quality/_shared/fixtures'
import { failedRead, reading, ready } from '../../../quality/_shared/model'
import { certCan } from '../model'
import { BODIES, BODY_0000, BODY_9990, BODY_9991, bodiesModel } from '../depth/bodies-demo/fixtures'
import { blankBodyDraft, bodyDraftOf, type BodiesFilter, type BodiesModel } from '../depth/model'
import { BodiesDialog } from './view/BodiesDialog'

/**
 * SCR-291 — Notified bodies (B-W2b-255; design compliance.certificates › pop:ce-nb, page.h "Notified bodies"; PRD-286),
 * made-up data only ("Demo Test Lab" 0000, "Demo Certification Office" 9990, "Demo Glove Lab" 9991 and an archived
 * earlier 0000; NANDO addresses on example.org). The pop-up opens from the register's ⋯ Notified bodies and from a
 * certificate's Notified body tab. Each case is one state the Owner reviews: the directory with the clothing scope check
 * and the NANDO links; archived and all; two selected (Export 2); a search with nothing matching; Add notified body empty,
 * filled, refused (the twin number) and held; Edit with the number fixed; the notice after a save; the product developer
 * (reads, every write held); loading, failed and empty.
 */

interface BodiesCase {
  readonly model: BodiesModel
  readonly role: RoleCase
}

const one = (over: Partial<BodiesModel> = {}, role: RoleCase = 'owner'): BodiesCase => ({ role, model: bodiesModel(over) })

/** The design case keeps its own filter, words and selection, so the list frame works in the review. */
function BodiesDesign({ model }: { model: BodiesCase }) {
  const [selected, setSelected] = useState<readonly string[]>(model.model.selected)
  const [filter, setFilter] = useState<BodiesFilter>(model.model.filter)
  const [q, setQ] = useState(model.model.q)
  useEffect(() => setSelected(model.model.selected), [model.model.selected])
  useEffect(() => setFilter(model.model.filter), [model.model.filter])
  useEffect(() => setQ(model.model.q), [model.model.q])
  const view = createElement(BodiesDialog, {
    model: { ...model.model, selected, filter, q },
    can: certCan(ROLE_PERMISSIONS[model.role]),
    actions: { onSelect: (ids) => setSelected([...ids]), onFilter: setFilter, onQuery: setQ },
  })
  return inShell('/compliance/certificates', view, model.role)
}

const filled = { ...blankBodyDraft(), number: '9992', name: 'Demo Impact Lab', address: 'Via Demo 9\n20100 Milano (MI)', country: 'IT', nandoUrl: 'https://example.org/nando/9992', scopes: 'Regulation (EU) 2016/425 – protective clothing (demo)\nRegulation (EU) 2016/425 – equipment against mechanical impact (demo)', contactEmail: 'lab@example.org' }

export const designScreen = defineDesignScreen<BodiesCase>({
  screen: 'SCR-291',
  title: 'Notified bodies (directory with NANDO)',
  view: BodiesDesign,
  cases: [
    { id: 'directory', label: 'The directory: active bodies, the clothing scope check, NANDO links', model: one(), note: '0000 is listed for protective clothing ✓; 9990 only for impact equipment (a warning); 9991 has no scope yet. NANDO opens the Commission’s site in a new tab.' },
    { id: 'archived', label: 'Status: archived', model: one({ filter: 'ARCHIVED' }) },
    { id: 'all', label: 'Status: all (the archived 0000 entry beside the active one)', model: one({ filter: 'ALL' }) },
    { id: 'selected', label: 'Two selected: Export 2', model: one({ selected: [BODY_0000.id, BODY_9990.id] }), note: 'The toolbar swaps to Export 2 (CSV).' },
    { id: 'no-match', label: 'A search with nothing matching', model: one({ q: 'zzz' }) },
    { id: 'add', label: 'Add notified body: empty', model: one({ form: { mode: 'new', bodyId: null, draft: blankBodyDraft(), touched: [] } }), note: 'Add is held with the first open field; ⌘↵ adds.' },
    { id: 'add-filled', label: 'Add notified body: filled from its NANDO entry', model: one({ form: { mode: 'new', bodyId: null, draft: filled, touched: [] } }) },
    { id: 'add-problems', label: 'Add notified body: wrong number and an http link, as you leave the fields', model: one({ form: { mode: 'new', bodyId: null, draft: { ...filled, number: '99', nandoUrl: 'http://example.org/nando' }, touched: ['number', 'nandoUrl'] } }) },
    {
      id: 'add-refused',
      label: 'Add notified body: refused, the number is in the directory',
      model: one({ form: { mode: 'new', bodyId: null, draft: { ...filled, number: '0000' }, touched: [] }, problem: 'bodies.write.conflict', lines: ['Notified body 0000 is in the directory already (Demo Test Lab): edit that entry, or archive it first.'] }),
    },
    { id: 'edit', label: 'Edit 0000: the number fixed (certificates name it)', model: one({ form: { mode: 'edit', bodyId: BODY_0000.id, draft: bodyDraftOf(BODY_0000), touched: [] } }) },
    { id: 'edit-free', label: 'Edit 9991: no certificate names it yet, the number may change', model: one({ form: { mode: 'edit', bodyId: BODY_9991.id, draft: bodyDraftOf(BODY_9991), touched: [] } }) },
    { id: 'saved', label: 'After a save: the notice', model: one({ notice: { key: 'bodies.done.added', params: { number: '9992' } } }) },
    { id: 'product', label: 'Product developer (production manager): reads, every write held', model: one({ directory: ready({ bodies: BODIES, mayManage: false, asOf: at(29, 9, 40) }) }, 'production'), note: 'Add, Edit, Archive say why they are held.' },
    { id: 'quality', label: 'Quality (inspector): keeps the directory', model: one({}, 'inspector') },
    { id: 'loading', label: 'Loading', model: one({ directory: reading() }) },
    { id: 'error', label: "The API didn't answer", model: one({ directory: failedRead('problem.unavailable') }), note: 'Never drawn as an empty directory.' },
    { id: 'empty', label: 'No body yet', model: one({ directory: ready({ bodies: [], mayManage: true, asOf: at(29, 9, 40) }) }) },
  ],
})
