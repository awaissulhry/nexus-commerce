import { expect, it, vi } from 'vitest'
const reader = vi.hoisted(() => vi.fn())
vi.mock('./read-client.js', () => ({ etsyReader: reader }))
import { etsyReferenceChoices, etsyReferenceChoice } from './information-references.js'
it('loads named choices from the selected shop and handles the complete processing-profile pagination', async () => {
  const get = vi.fn().mockResolvedValueOnce({ count: 2, results: [{ readiness_state_id: 1, readiness_state: 'ready_to_ship', processing_days_display_label: '1–3 days' }] })
    .mockResolvedValueOnce({ count: 2, results: [{ readiness_state_id: 2, readiness_state: 'made_to_order', processing_days_display_label: '3–5 days' }] })
  reader.mockResolvedValue({ shopId: 22, get })
  expect(await etsyReferenceChoices('account-b', 'readiness_state_id')).toEqual([{ id: '1', name: 'Ready to ship · 1–3 days', active: true }, { id: '2', name: 'Made to order · 3–5 days', active: true }])
  expect(reader).toHaveBeenCalledWith('account-b')
  expect(get.mock.calls.map(call => call[0])).toEqual(['/shops/22/readiness-state-definitions?limit=100&offset=0', '/shops/22/readiness-state-definitions?limit=100&offset=1'])
  expect(etsyReferenceChoice('return_policy_id', { return_policy_id: 5, accepts_returns: true, accepts_exchanges: false, return_deadline: 30 }).name).toBe('Returns within 30 days · no exchanges')
})
it('refuses truncated or inconsistent choices and preserves legitimate zero-result shops', async () => {
  const get = vi.fn(); reader.mockResolvedValue({ shopId: 1, get })
  get.mockResolvedValueOnce({ count: 2, results: [{ shipping_profile_id: 1, title: 'Standard' }] })
  await expect(etsyReferenceChoices('a', 'shipping_profile_id')).rejects.toThrow('incomplete')
  get.mockResolvedValueOnce({ count: 0, results: [] })
  expect(await etsyReferenceChoices('a', 'shipping_profile_id')).toEqual([])
  expect(() => etsyReferenceChoice('shipping_profile_id', { shipping_profile_id: '1' })).toThrow('invalid resource ID')
})
