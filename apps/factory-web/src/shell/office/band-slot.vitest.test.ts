import { createElement, type ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { permissionCheck } from '../../lib/session/session'
import { render, textOf } from '../../lib/record-thread/parts/testing'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../design-data'
import { officeNavFor } from '../nav/office-nav'
import { useBandSlot } from './band-slot'
import { OfficeShellView, type OfficeShellViewModel } from './view/OfficeShellView'

/** B-TH-213 — the record band slot: a record page draws its band in the shell's area band row (no packages/ui change). */

function Reader(): ReactNode {
  const slot = useBandSlot()
  return createElement('p', { 'data-slot': slot.element ? 'element' : 'none', 'data-claim': typeof slot.claim }, slot.actions ?? 'no shell actions', slot.status ?? null)
}

const shell = (path: string, frame: OfficeShellViewModel['frame'] = 'office'): OfficeShellViewModel => ({
  nav: officeNavFor(permissionCheck(rolePermissions('owner'))),
  path,
  frame,
  switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
  user: DEMO_USER,
  tenantTag: DEMO_TAG,
  banners: [],
  live: 'live',
  printKind: 'record',
})

describe('the band slot', () => {
  it('a record page in an area with pages reads the slot: the shell’s live state and Print stay beside the record’s band', () => {
    const html = render(createElement(OfficeShellView, { model: shell('/sales/orders/0190f0e2-3333-7000-8000-000000000002') }, createElement(Reader)))
    expect(html).toContain('data-claim="function"')
    // No claim yet on the server: the crumbs stay and no element is handed out (the page draws its band itself until it claims).
    expect(html).toContain('data-slot="none"')
    const page = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? ''
    expect(textOf(page)).toContain('Print')
    expect(page).toContain('fw-live')
  })

  it('a window or the print view has no band row: no slot, the record draws its own band', () => {
    const html = render(createElement(OfficeShellView, { model: shell('/sales/orders/0190f0e2-3333-7000-8000-000000000002', 'window') }, createElement(Reader)))
    expect(textOf(html)).toContain('no shell actions')
  })

  it('outside the office shell (a design case alone): no slot', () => {
    expect(textOf(render(createElement(Reader)))).toContain('no shell actions')
  })

  it('the shell’s change is the slot only: the claimed row is an empty element the record portals into', () => {
    const source = readFileSync(new URL('./view/OfficeShellView.tsx', import.meta.url), 'utf8')
    expect(source).toContain('band.claimed ? <div ref={band.ref} className="fw-band-slot" />')
    expect(source).toContain('<BandSlotContext.Provider value={band.value}>{children}</BandSlotContext.Provider>')
  })
})
