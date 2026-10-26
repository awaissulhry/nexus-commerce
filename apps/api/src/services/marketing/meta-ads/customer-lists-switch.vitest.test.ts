/**
 * Meta consent PR 2 — the business's "Upload customer lists to Meta" switch, a copy of step 33's: off by default (no row,
 * or no time), a person's name and time when on, recorded in the settings history (its own key, never reverted) only
 * when it moves, written on this business's own settings row. The database and the audit writer are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  row: null as null | { metaCustomerListsOnAt: Date | null; metaCustomerListsOnBy: string | null },
  upsert: vi.fn(),
  audit: vi.fn(),
}))
vi.mock('../../../db.js', () => ({ default: { accountSettings: { findFirst: vi.fn(async () => h.row), upsert: h.upsert } } }))
vi.mock('../../../utils/settings-audit.js', () => ({ writeSettingsAudit: h.audit }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceIdForQuery: () => 'ws-a' }))

import { metaCustomerListsSwitch, setMetaCustomerListsSwitch } from './customer-lists-switch.js'

beforeEach(() => {
  h.row = { metaCustomerListsOnAt: new Date('2026-10-26T08:00:00Z'), metaCustomerListsOnBy: 'Owner' }
  h.upsert.mockReset().mockImplementation(async ({ update }: { update: typeof h.row }) => { h.row = update })
  h.audit.mockReset()
})

describe('the switch', () => {
  it('is off without a settings row or a time; on names who and when', async () => {
    h.row = null
    expect(await metaCustomerListsSwitch()).toEqual({ on: false, since: null, by: null })
    h.row = { metaCustomerListsOnAt: null, metaCustomerListsOnBy: 'Someone' }
    expect(await metaCustomerListsSwitch()).toEqual({ on: false, since: null, by: null })
    h.row = { metaCustomerListsOnAt: new Date('2026-10-26T08:00:00Z'), metaCustomerListsOnBy: 'Owner' }
    expect(await metaCustomerListsSwitch()).toEqual({ on: true, since: '2026-10-26T08:00:00.000Z', by: 'Owner' })
  })
  it('a person turns it on or off on the business\'s own row; the same value again changes and records nothing', async () => {
    expect(await setMetaCustomerListsSwitch(true, { label: 'Owner' })).toMatchObject({ changed: false, switch: { on: true } })
    expect(h.upsert).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
    const off = await setMetaCustomerListsSwitch(false, { label: 'Owner' })
    expect(off).toEqual({ changed: true, switch: { on: false, since: null, by: null } })
    expect(h.upsert.mock.calls[0][0]).toMatchObject({ where: { workspaceId: 'ws-a' }, update: { metaCustomerListsOnAt: null, metaCustomerListsOnBy: null } })
    // Its own history key, which Settings › History never reverts.
    expect(h.audit).toHaveBeenCalledWith({ key: 'meta-customer-lists', action: 'update', before: { metaCustomerLists: true }, after: { metaCustomerLists: false } })
    const on = await setMetaCustomerListsSwitch(true, { label: 'A'.repeat(300) })
    expect(on.switch).toMatchObject({ on: true, by: 'A'.repeat(200) })
    expect(h.upsert.mock.calls[1][0].update.metaCustomerListsOnAt).toBeInstanceOf(Date)
  })
})
