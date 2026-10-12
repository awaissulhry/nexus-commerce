import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'

/**
 * Keyword Harvest polish (2026-10-11): `ReviewChangesModal` passes `groups` and `doneLine` to its `ReviewChangesPanel`
 * (the Terms review hand-built Modal + panel to get them). Additive: without them the panel gets nothing new. The real
 * component runs on a minimal hook runtime (apps/web vitest has no DOM); the returned tree holds the panel's element.
 */
const runtime = vi.hoisted(() => ({ slots: [] as unknown[], at: 0 }))
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>()
  const useState = (init: unknown) => {
    const i = runtime.at++
    if (!(i in runtime.slots)) runtime.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
    return [runtime.slots[i], (next: unknown) => { runtime.slots[i] = next }]
  }
  const useEffect = () => { runtime.at++ }
  // The Done focus (Bid page R5) holds two refs; a plain object is enough without a DOM.
  const useRef = (init: unknown) => ({ current: init })
  // The panel names its tabs with an id.
  const useId = () => ':r0:'
  return { ...real, default: { ...real, useState, useEffect, useRef, useId }, useState, useEffect, useRef, useId }
})

import { ReviewChangesModal, type ReviewChangesModalProps } from './ReviewChangesModal'
import { ReviewChangesPanel } from './ReviewChangesPanel'

type El = ReactElement<Record<string, unknown>>
const flat = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(flat)
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return []
  const el = node as El
  return [el, ...flat((el.props as { children?: unknown }).children)]
}
const panelOf = (props: ReviewChangesModalProps) => {
  runtime.at = 0
  return flat(ReviewChangesModal(props) as El).find((el) => el.type === ReviewChangesPanel)!
}
const base: ReviewChangesModalProps = {
  open: true, onClose() {}, onSave() {},
  changes: [{ id: 'k1', where: 'Exact group', what: 'rain jacket', now: '—', next: 'Exact', group: 'keywords' }],
}

beforeEach(() => { runtime.slots = []; runtime.at = 0 })

describe('ReviewChangesModal — groups and doneLine reach the panel', () => {
  it('passes the tabs and the host\'s Done line through', () => {
    const groups = [{ id: 'keywords', label: 'Keywords' }, { id: 'negatives', label: 'Negatives' }]
    const doneLine = { line: 'Asked · waits for approval', tone: 'warning' as const }
    const panel = panelOf({ ...base, groups, doneLine })
    expect(panel.props.groups).toBe(groups)
    expect(panel.props.doneLine).toBe(doneLine)
    expect(panel.props.changes).toBe(base.changes)
  })
  it('size "detail" reaches the Modal (a full-screen sheet on a phone); the default stays lg', () => {
    runtime.at = 0
    expect((ReviewChangesModal({ ...base, size: 'detail' }) as El).props.size).toBe('detail')
    runtime.at = 0
    expect((ReviewChangesModal(base) as El).props.size).toBe('lg')
  })
  it('without them nothing changes for current callers', () => {
    const panel = panelOf(base)
    expect(panel.props.groups).toBeUndefined()
    expect(panel.props.doneLine).toBeUndefined()
    expect(panel.props.lead).toBeUndefined()
    expect(panel.props.doneVerb).toBe('saved')
  })
})

/** The Save button in the footer (the primary one), and the tooltip around it when held. */
const saveOf = (props: ReviewChangesModalProps) => {
  runtime.at = 0
  const footer = flat((ReviewChangesModal(props) as El).props.footer)
  const save = footer.find((el) => el.props.variant === 'primary')!
  const tip = footer.find((el) => typeof el.props.label === 'string' && el.props.portal === true)
  return { save, tip }
}

describe('ReviewChangesModal — a form above the table (lead)', () => {
  it('passes the form to the panel, which draws it first', () => {
    const lead = createElement('form', { 'aria-label': 'Change bid' })
    const panel = panelOf({ ...base, lead })
    expect(panel.props.lead).toBe(lead)
    runtime.at = 0
    const body = flat(ReviewChangesPanel({ changes: base.changes, ack: false, onAckChange() {}, lead }) as El)
    expect(body[1]).toBe(lead)
  })
  it('the panel leaves the form out once done', () => {
    runtime.at = 0
    const lead = createElement('form', { 'aria-label': 'Change bid' })
    const body = flat(ReviewChangesPanel({ changes: base.changes, ack: false, onAckChange() {}, lead, state: { phase: 'done', results: { k1: { ok: true, words: 'Sent' } } } }) as El)
    expect(body).not.toContain(lead)
  })
  it('holds Save with the form\'s own words while it is not filled in, and lets it go once it is', () => {
    const held = saveOf({ ...base, lead: createElement('form'), leadHeld: 'Type a bid', saveLabel: 'Send 1 bid' })
    expect(held.save.props['aria-disabled']).toBe(true)
    expect(held.save.props['aria-description']).toBe('Type a bid')
    expect(held.save.props.onClick).toBeUndefined()
    expect(held.tip?.props.label).toBe('Type a bid')
    const free = saveOf({ ...base, lead: createElement('form'), leadHeld: null, saveLabel: 'Send 1 bid' })
    expect(free.save.props['aria-disabled']).toBeUndefined()
    expect(free.tip).toBeUndefined()
  })
})
