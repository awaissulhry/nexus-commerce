import { describe, expect, it } from 'vitest'
import { databasePartyRefusal, PARTY_REFUSAL_ISSUES } from './refusals'

describe('databasePartyRefusal()', () => {
  it("reads the database's party refusals back as words with their issue path", () => {
    expect(databasePartyRefusal('parties: contact 0195a1b2-0000-7000-8000-000000000001 was erased; its name, e-mail and phone stay blank and it stays archived')?.path).toBe(PARTY_REFUSAL_ISSUES.erased)
    expect(databasePartyRefusal('parties: contact x was erased; the erasure is never changed or undone')?.path).toBe(PARTY_REFUSAL_ISSUES.erased)
    expect(databasePartyRefusal('parties: party x rides for a team, so it is a person (PERSON), never its own team')?.path).toBe(PARTY_REFUSAL_ISSUES.rider)
    expect(databasePartyRefusal('parties: party x has riders, so it stays an organisation (move its riders first)')?.path).toBe(PARTY_REFUSAL_ISSUES.team)
    expect(databasePartyRefusal('parties: party x has riders, so it stays an organisation (move its riders first)')?.message).toMatch(/Move its riders first/)
  })

  it('leaves every other message alone', () => {
    expect(databasePartyRefusal('parties: the default deposit of party x is above 0 and at most 100 percent, or none')).toBeNull()
    expect(databasePartyRefusal('customers: inquiry x is logged open')).toBeNull()
    expect(databasePartyRefusal('parties: the erasure of contact x has when and by whom, both or neither')).toBeNull()
  })
})
