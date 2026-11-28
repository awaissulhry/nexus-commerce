import type { CallFlag, CallTypeRow, HelpRead } from './api'

/**
 * owb-fl8 — made-up data for the help parts' tests (a basket of the demo site; codes and words invented, never a real customer).
 * Complete as fl1's read and fl3's types would answer for what these parts read.
 */

export const BASKET_ID = '00000000-0000-4000-8000-0000000b0431'

export const flag = (extra: Partial<CallFlag> = {}): CallFlag => ({ callId: 'call-1', typeCode: 'MATERIAL', state: 'SENT', minutes: 3, escalated: false, ...extra })

export const helpRead = (extra: Partial<HelpRead> = {}): HelpRead => ({
  basket: { id: BASKET_ID, code: 'B-0431', workOrderId: '00000000-0000-4000-8000-00000000a001' },
  picture: { src: 'https://example.com/picture/b-0431.png' },
  here: { departmentId: '00000000-0000-4000-8000-0000000d0002' },
  flags: { problem: null, ask: null, answer: null },
  notes: [],
  ...extra,
})

export const problemTypes: CallTypeRow[] = [
  { id: 'type-paper', code: 'PAPER', active: true, escalateAfterMinutes: 10, to: null },
  { id: 'type-material', code: 'MATERIAL', active: true, escalateAfterMinutes: 10, to: null },
  { id: 'type-machine', code: 'MACHINE', active: false, escalateAfterMinutes: 10, to: null },
  { id: 'type-safety', code: 'SAFETY', active: true, escalateAfterMinutes: null, to: null },
]

export const askTypes: CallTypeRow[] = [
  { id: 'type-other', code: 'ASK_OTHER', active: true, escalateAfterMinutes: 10, to: 'TEAM_LEADER' },
  { id: 'type-logo', code: 'ASK_LOGO', active: true, escalateAfterMinutes: 10, to: 'DESIGNER' },
]
