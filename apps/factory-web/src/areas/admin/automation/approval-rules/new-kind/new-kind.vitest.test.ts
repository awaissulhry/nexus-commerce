import { describe, expect, it } from 'vitest'
import { designScreen } from '../../fixtures'
import { DEMO_APPROVAL_RULES } from '../demo'
import { newRuleHref, newRuleKindOf, startDraft } from './new-kind'

/** B-W2b-382 (XF7:06): Admin › Approval rules `?rule=new&kind=` preselects the kind the page was opened for. */
describe('a new approval rule opened for a kind', () => {
  it('Purchasing and Warehouse settings open a new rule with their kind in the address', () => {
    expect(newRuleHref('/w/DEMO', 'PURCHASE_ORDER')).toBe('/w/DEMO/admin/automation?view=approvals&rule=new&kind=PURCHASE_ORDER')
    expect(newRuleHref('/w/DEMO', 'STOCK_ADJUSTMENT')).toBe('/w/DEMO/admin/automation?view=approvals&rule=new&kind=STOCK_ADJUSTMENT')
  })
  it('starts with the asked kind only when the API lists it', () => {
    const kinds = [{ kind: 'PURCHASE_ORDER' }, { kind: 'STOCK_ADJUSTMENT' }]
    expect(newRuleKindOf('STOCK_ADJUSTMENT', kinds)).toBe('STOCK_ADJUSTMENT')
    expect(newRuleKindOf('NOT_A_KIND', kinds)).toBeNull()
    expect(newRuleKindOf(null, kinds)).toBeNull()
    expect(newRuleKindOf('PURCHASE_ORDER', null)).toBeNull()
  })
  it('the pop-up starts on the kind (one company: that one), a rule on its own kind, a design case’s draft as given', () => {
    expect(startDraft({ kind: 'STOCK_ADJUSTMENT', rule: null }, [{ id: 'c1' }])).toMatchObject({ kind: 'STOCK_ADJUSTMENT', companyId: 'c1', name: '' })
    expect(startDraft({ kind: null, rule: null }, [{ id: 'c1' }, { id: 'c2' }])).toMatchObject({ kind: null, companyId: null })
    const rule = DEMO_APPROVAL_RULES[0]!
    expect(startDraft({ kind: 'STOCK_ADJUSTMENT', rule }, [])).toMatchObject({ kind: rule.kind })
    const model = designScreen.cases.find((item) => item.id === 'w2b-382-rule-new-kind')!.model as { approvalRules?: { dialog: { kind?: string | null } | null } }
    expect(model.approvalRules?.dialog?.kind).toBe('PURCHASE_ORDER')
  })
})
