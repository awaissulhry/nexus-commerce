/**
 * Owner 2026-10-11: the Keyword Harvest rule builder is the OLD shared builder (`_shared/RuleBuilder.tsx`, as on main),
 * with three necessary fixes only — (a) it never sends the person to the Suggestions page, (b) "block where found" starts
 * ON for a new rule (D3), (c) its Manual / Automate lands in the harvest engine as the Rules view reads it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const builder = read('../../_shared/RuleBuilder.tsx')

describe('the Keyword Harvest rule builder is the shared one', () => {
  it('no harvest wrapper: RuleBuilder is the builder itself, the new editor is gone', () => {
    expect(builder).toContain('export function RuleBuilder({ slug, ruleId: ruleIdProp, initialMarket, onClose, onSaved }: RuleBuilderProps) {')
    expect(builder).not.toContain('HarvestRuleEditor')
    for (const f of ['HarvestRuleEditor.tsx', 'HarvestScopePicker.tsx', 'harvestRuleDraft.ts']) expect(existsSync(new URL(`../../_shared/${f}`, import.meta.url))).toBe(false)
  })

  it('(a) a harvest rule’s words name the Keyword Harvest page, never the Suggestions page', () => {
    expect(builder).toContain("every harvest waits on the Keyword Harvest page for your approval.'")
    expect(builder).toContain("description={isHarvest ? 'Manually approve each harvest on the Keyword Harvest page' : 'Manually approve rule actions on the Suggestions page'}")
    expect(builder).toContain("{isHarvest && ' On Automate it harvests by itself, inside its caps.'}")
    // The Suggestions sentence about creation stays the Negatives page's own.
    // (Negatives wave 4: the sentence hides while its "Stop waste — may run alone" section is on.)
    expect(builder).toContain("{isNegative && !stopWaste.on && ' This rule CREATES things")
    expect(builder).not.toContain('(isHarvest || isNegative) && \' This rule CREATES things')
  })

  it('(b) block where found starts ON for a new harvest rule; a stored rule keeps its own', () => {
    expect(builder).toContain('const [negateInSource, setNegateInSource] = useState(isHarvest && !ruleId)')
    expect(builder).toContain("if (typeof a.negateInSource === 'boolean') setNegateInSource(a.negateInSource)")
  })

  it('(c) Manual / Automate go through the harvest mode route (Ask me / Auto), and an edit keeps Auto’s mark', () => {
    expect(builder).toMatch(/if \(isHarvest\) \{[\s\S]{0,400}\/api\/advertising\/harvest\/rules\/mode`[\s\S]{0,200}mode: level === 'AUTO' \? 'AUTO' : 'ASK'/)
    // A refusal inside a 200 answer is a refusal: the notice says it and the radio goes back.
    expect(builder).toContain("lj = res.ok && !r0?.ok ? { error: r0?.error ?? 'The mode was not changed.', message: r0?.error } : mj")
    expect(builder).toContain('...(isHarvest && savedHarvestAuto.current ? { harvestAuto: savedHarvestAuto.current } : {}),')
    expect(builder).toContain('if (isHarvest) savedHarvestAuto.current = a.harvestAuto ?? null')
  })
})
