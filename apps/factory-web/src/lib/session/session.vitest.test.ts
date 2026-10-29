import { describe, expect, it } from 'vitest'
import { officeMeSchema } from '../api/office'
import { sessionFromMe } from './session'

const me = (extra: Record<string, unknown>) =>
  officeMeSchema.parse({
    user: { id: 'u1', email: 'alex.demo@example.com', displayName: 'Alex Demo', locale: 'it' },
    tenant: { id: 't1', slug: 'demo', name: 'Officina Demo' },
    company: null,
    session: { id: 's1', createdAt: '2026-10-28T08:00:00.000Z', idleExpiresAt: '2026-10-28T16:00:00.000Z', absoluteExpiresAt: '2026-11-04T08:00:00.000Z', stepUpUntil: null },
    mfa: { enabled: true, required: false, satisfied: true, recoveryCodesLeft: 10 },
    permissions: [],
    ...extra,
  })

const DEMO = { id: 'c1', code: 'DEMO', name: 'Officina Demo S.r.l.' }
const ESEMPIO = { id: 'c2', code: 'ESEMPIO', name: 'Pelletteria Esempio S.p.A.' }

describe('the switcher lists the companies the person\'s roles reach (SCR-002, me.companies)', () => {
  it('takes the API\'s list, whether or not the session is in a company yet', () => {
    expect(sessionFromMe(me({ company: DEMO, companies: [DEMO, ESEMPIO] })).companies).toEqual([DEMO, ESEMPIO])
    expect(sessionFromMe(me({ company: null, companies: [DEMO, ESEMPIO] })).companies).toEqual([DEMO, ESEMPIO])
  })

  it('an answer without the list keeps the current company only', () => {
    expect(sessionFromMe(me({ company: DEMO })).companies).toEqual([DEMO])
    expect(sessionFromMe(me({})).companies).toEqual([])
  })
})
