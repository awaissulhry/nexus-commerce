import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { CaptureRead } from './api'
import type { CaptureCardModel } from './model'
import { CaptureCard } from './view/CaptureCard'

/**
 * SCR-439 — Admin › Connections › Your mail domain › Capture address (B-W2b-397; COL-021; design admin.connections
 * sec:mail-domain "Capture address (W2b): forward or BCC any mail to it") — made-up data only (PLAN §3.1): an invented company
 * domain under example.invalid. Each case is one state of the card: live with its default inbox, read only, none yet, no mail
 * domain, the replace and turn-off confirms, a change met meanwhile, loading, error.
 */

const id = (n: number) => `0190f0e2-4390-7000-8000-${String(n).padStart(12, '0')}`
const DOMAIN = 'reply.officina-demo.example.invalid'
const LIVE: CaptureRead = {
  capture: { id: id(1), companyId: id(800), address: `c-k7m2q9x4w8r3t6y1p5n0b2v7c4@${DOMAIN}`, defaultTeamInbox: { id: id(11), name: 'Ordini', active: true }, createdAt: '2026-11-12T09:30:00.000Z', version: 2 },
  receivingDomain: DOMAIN,
  mayManage: true,
}
const INBOXES = [
  { id: id(11), name: 'Ordini' },
  { id: id(12), name: 'Offerte' },
]

const base: CaptureCardModel = { read: { status: 'ready', data: LIVE }, inboxes: INBOXES, busy: false, notice: null, confirm: null, prefix: '/w/DEMO' }

export const designScreen = defineDesignScreen<CaptureCardModel>({
  screen: 'SCR-439',
  title: 'Connections: capture address',
  view: CaptureCard,
  cases: [
    { id: 'live', label: 'Live, mail it cannot place goes to Ordini', model: base, note: 'Copy the address; the default inbox; Replace… and Turn off….' },
    { id: 'read-only', label: 'Read only (no right to manage)', model: { ...base, read: { status: 'ready', data: { ...LIVE, mayManage: false } }, inboxes: null }, note: 'Copy stays; the choice and both actions are held with the reason.' },
    { id: 'none', label: 'No capture address yet', model: { ...base, read: { status: 'ready', data: { ...LIVE, capture: null } } } },
    { id: 'no-domain', label: 'No mail domain yet', model: { ...base, read: { status: 'ready', data: { capture: null, receivingDomain: null, mayManage: true } } }, note: 'Make is held: the address lives at the receiving domain.' },
    { id: 'replace', label: 'Replace the address?', model: { ...base, confirm: 'replace' } },
    { id: 'turn-off', label: 'Turn off the address?', model: { ...base, confirm: 'turnOff' } },
    { id: 'made', label: 'Made', model: { ...base, notice: { key: 'captureAdmin.done.made', tone: 'success' } } },
    { id: 'changed', label: 'Changed meanwhile', model: { ...base, notice: { key: 'captureAdmin.notice.changed', tone: 'warning' } } },
    { id: 'loading', label: 'Loading', model: { ...base, read: { status: 'loading' } } },
    { id: 'error', label: 'Could not be read', model: { ...base, read: { status: 'error', problem: 'capture.problem.unavailable' } } },
  ],
})
