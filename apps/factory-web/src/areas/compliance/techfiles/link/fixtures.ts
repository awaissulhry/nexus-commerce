import { createElement } from 'react'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BUILDING_PACK, BUILT_PACK, NOW } from '../_demo/fixtures'
import { failed, LOADING, ready } from '../model'
import { AuthorityPreviewView, type AuthorityPreviewModel } from './view/AuthorityPreviewView'

/**
 * SCR-327 — Authority link preview (design compliance.techfiles tab:tf-authority, a new tab; links.document) with made-up data
 * only: what a made-up German authority meets on the link of EP-DEMO-0001 — the password step, then the PDF and the ZIP with
 * their checksums, the PDF read in the page — a pack with no link yet, a pack not built, loading, a failed read, no right.
 */

const PDF = samplePdf(['Pacchetto prove EP-DEMO-0001', 'Fascicolo tecnico TF-DEMO-0001 · DEMO-JKT-01', 'Costi, prezzi e retribuzioni non sono mai inclusi.'])
const base = (over: Partial<AuthorityPreviewModel> = {}): AuthorityPreviewModel => ({ canView: true, sender: 'Officina Demo S.r.l.', pack: ready(BUILT_PACK), step: 'password', preview: null, now: NOW, ...over })

export const designScreen = defineDesignScreen<AuthorityPreviewModel>({
  screen: 'SCR-327',
  title: 'Authority link preview',
  view: ({ model }) => createElement(AuthorityPreviewView, { model }),
  cases: [
    { id: 'password', label: 'Before the password: what the link asks first', model: base() },
    { id: 'files', label: 'After the password: the PDF and the ZIP with their checksums', model: base({ step: 'files' }) },
    { id: 'read', label: 'The PDF read in the page', model: base({ step: 'files', preview: ready(PDF) }) },
    { id: 'no-link', label: 'No link made yet', model: base({ pack: ready({ ...BUILT_PACK, links: [] }) }) },
    { id: 'not-built', label: 'The pack is not built yet', model: base({ pack: ready(BUILDING_PACK) }) },
    { id: 'loading', label: 'Reading the pack', model: base({ pack: LOADING }) },
    { id: 'error', label: 'The pack could not be read', model: base({ pack: failed('problem.unavailable') }) },
    { id: 'forbidden', label: 'No right to see it', model: base({ canView: false }) },
  ],
})
