/**
 * PES.4 — the drawer's `$` autocomplete list, and the two invariants no type can catch.
 *
 * The builder itself is tested for real. The two SOURCE assertions at the bottom are not padding:
 * both guard behaviour that is invisible to the compiler, silently wrong, and expensive — a formula
 * stored as a literal VALUE publishes to a channel and preflight calls it valid, and an autosave
 * that fires mid-formula writes `=`, `=u`, `=up` into the cell as the operator types the rule.
 *
 * Each source assertion is PAIRED with the negative form, because a `toContain` that only ever
 * looks for the right string passes just as happily when the file has been rewritten around it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { buildFormulaCandidates, nextActiveIndex } from './formulaCandidates'

const COLS = [
  { key: 'brand', label: 'Brand' },
  { key: 'item_name', label: 'Title' },
  { key: 'basePrice', label: 'Price' },
]
const FNS = [
  { name: 'upper', signature: 'upper(text)', summary: 'Uppercase' },
  { name: 'concat', signature: 'concat(a, b)', summary: 'Join' },
]

describe('buildFormulaCandidates', () => {
  it('offers every column as a field, then every function', () => {
    const out = buildFormulaCandidates(COLS, {}, FNS)
    expect(out.map((c) => c.name)).toEqual(['brand', 'item_name', 'basePrice', 'upper', 'concat'])
    expect(out.filter((c) => c.kind === 'field')).toHaveLength(3)
    expect(out.filter((c) => c.kind === 'function')).toHaveLength(2)
  })

  it('🔴 groups every column under the literal "Columns", never under the form\'s own group', () => {
    /* The drawer's FORM is grouped by `col.group` ("Identity", "Compliance", …). If that leaked in
       here the autocomplete would fragment into a dozen headed sections where the sheet shows one —
       the same list, two shapes, one of them wrong. */
    const out = buildFormulaCandidates(COLS, {}, FNS)
    expect(new Set(out.filter((c) => c.kind === 'field').map((c) => c.group))).toEqual(new Set(['Columns']))
    expect(new Set(out.filter((c) => c.kind === 'function').map((c) => c.group))).toEqual(new Set(['Functions']))
  })

  it('🔴 carries the row\'s CURRENT value, which is the half that answers "is this the column I meant"', () => {
    const out = buildFormulaCandidates(COLS, { brand: { value: 'Xavia' } }, [])
    expect(out.find((c) => c.name === 'brand')?.value).toBe('Xavia')
  })

  it('🔴 leaves `value` ABSENT for an empty cell rather than setting an empty string', () => {
    /* An empty chip and a missing chip look identical on screen and mean different things. The
       editor draws nothing for `undefined`; `''` would draw an empty one. */
    const out = buildFormulaCandidates(COLS, { brand: { value: '' }, item_name: { value: null } }, [])
    expect(out.find((c) => c.name === 'brand')).not.toHaveProperty('value', '')
    expect(out.find((c) => c.name === 'brand')?.value).toBeUndefined()
    expect(out.find((c) => c.name === 'item_name')?.value).toBeUndefined()
    /* A cell the payload omits entirely is the same case, and it is the common one on a sparse row. */
    expect(out.find((c) => c.name === 'basePrice')?.value).toBeUndefined()
  })

  it('stringifies a non-string value rather than passing a number through', () => {
    /* `FormulaCandidate.value` is documented as text — the chip renders it directly. */
    const out = buildFormulaCandidates(COLS, { basePrice: { value: 105 } }, [])
    expect(out.find((c) => c.name === 'basePrice')?.value).toBe('105')
  })

  it('🔴 a zero is a VALUE, not an empty cell', () => {
    /* `0` and `false` are falsy, so a truthiness test here would hide a real price of 0 behind
       "this column is empty" — the classic form of this bug and the reason the check is `== null`. */
    const out = buildFormulaCandidates(COLS, { basePrice: { value: 0 } }, [])
    expect(out.find((c) => c.name === 'basePrice')?.value).toBe('0')
  })

  it('offers no functions before the docs have loaded, and invents none', () => {
    const out = buildFormulaCandidates(COLS, {}, [])
    expect(out.filter((c) => c.kind === 'function')).toHaveLength(0)
  })
})

describe('nextActiveIndex — the ↑/↓ walk', () => {
  /* 🔴 This exists BECAUSE the screen could not test it. The one live reading of the autocomplete
     had a single match, and a one-row list behaves identically whether the modulo is correct,
     inverted, or off by one. The alternative to these assertions was another browser session
     against a production fixture to exercise two lines of arithmetic. */
  it('walks down and up through the list', () => {
    expect(nextActiveIndex(0, 'ArrowDown', 4)).toBe(1)
    expect(nextActiveIndex(2, 'ArrowDown', 4)).toBe(3)
    expect(nextActiveIndex(2, 'ArrowUp', 4)).toBe(1)
  })

  it('🔴 wraps at BOTH ends — an operator who overshot must not travel all the way back', () => {
    expect(nextActiveIndex(3, 'ArrowDown', 4)).toBe(0)
    expect(nextActiveIndex(0, 'ArrowUp', 4)).toBe(3)
  })

  it('🔴 an index left over from a LONGER list does not survive past the end', () => {
    /* The operator types another character, the matches shrink, and the stored index is now past
       the end. Un-normalised it would point `aria-activedescendant` at a row that is not rendered
       — a dangling reference that audits as wired, the same failure as a bad `aria-controls`. */
    expect(nextActiveIndex(9, 'ArrowDown', 3)).toBe(1)
    expect(nextActiveIndex(9, 'ArrowUp', 3)).toBe(2)
  })

  it('🔴 an EMPTY list leaves the index alone rather than moving to 0', () => {
    /* There is nothing to highlight; 0 would name a row that does not exist. */
    expect(nextActiveIndex(2, 'ArrowDown', 0)).toBe(2)
    expect(nextActiveIndex(2, 'ArrowUp', 0)).toBe(2)
  })

  it('a single match stays put in both directions — the case the screen DID see', () => {
    expect(nextActiveIndex(0, 'ArrowDown', 1)).toBe(0)
    expect(nextActiveIndex(0, 'ArrowUp', 1)).toBe(0)
  })
})

describe('🔴 invariants the compiler cannot see', () => {
  const field = readFileSync(new URL('./fields/FormulaField.tsx', import.meta.url), 'utf8')
  const composer = readFileSync(new URL('../../../../../../design-system/grid/editors/FormulaComposer.tsx', import.meta.url), 'utf8')
  const record = readFileSync(new URL('./fields/RecordField.tsx', import.meta.url), 'utf8')

  it('a formula is saved through the FORMULA writer, never through the value writer', () => {
    /* 🔴 The dangerous one. `onWrite` stores what it is given as the cell's literal value, and
       `overrideData` is read as a value layer by the resolver — so a formula sent that way would
       publish its own CHARACTERS to a channel and preflight would call the listing valid. */
    expect(field).toContain('formulas.save(rowId, column.key, exprOf(draft))')
    expect(field).not.toMatch(/\bonWrite\b/)
  })

  it('entering formula mode cancels the idle autosave instead of scheduling one', () => {
    /* Without the early return the 900ms autosave fires on the mode switch itself and writes `=`,
       then `=u`, then `=up` into the cell as the rule is typed — each one a real write. */
    expect(record).toContain('autosave.cancel()\n            setFormulaMode(true)\n            return')
    /* The ordinary path must still schedule one, or every plain edit stops saving. */
    expect(record).toContain('scheduleCommit(next)')
  })

  it('the drawer builds no formula hook of its own — the seam is injected by the host', () => {
    /* `useCellFormulas` needs a `market` this drawer cannot see, and a second instance would be a
       second answer to "what formula is on this cell".

       🔴 The assertion names the IMPORT, not the word. Both these files DISCUSS `useCellFormulas`
       in their comments — explaining why they do not call it — so a bare `not.toMatch(/useCell…/)`
       fails on the prose that documents the rule it is enforcing. It did, on the first run: the
       banked "a guard greps comments" shape, caught here only because the assertion was written to
       be capable of failing. */
    expect(field).not.toMatch(/import[^\n]*useCellFormulas/)
    expect(record).not.toMatch(/import[^\n]*useCellFormulas/)
  })

  it('🔴 a scope that refuses writes cannot author a formula through the side door', () => {
    /* PES.3's channel scope passes an `onWrite` that always refuses, because channel writes belong
       to the sheet's own cascade. A formula IS a write and reaches the server through
       `DrawerFormulas.save`, NOT `onWrite` — so the host's refusal is structurally unable to stop
       it, and without this signal the drawer would offer a live ƒ control three lines under its own
       "read-only" message. Every authoring path must consult the flag: the ƒ button, the remove
       button, the `=` keystroke, and the field's own disabled state. */
    const gates = record.match(/!formulaWritesRefused/g) ?? []
    expect(gates.length).toBeGreaterThanOrEqual(3)
    expect(record).toContain('disabled={!editable || formulaWritesRefused}')
    /* Defence in depth: the WRITE functions guard too, because a hidden control and an impossible
       write are different claims and only the second is worth relying on. */
    expect(record).toContain('if (formulaWritesRefused) return')
    expect(field).toContain('disabled={disabled || formulas.ready === false}')
    expect(composer).toContain('!onApply || disabled || busy.current')
    /* 🔴 And the guards must be in the callbacks' DEPS, or a stale closure keeps the write path open
       after the scope closed it — a guard present in the source and not in effect. */
    expect(field).toContain('onApply={async draft =>')
    expect(record).toMatch(/onFormulaSaved, formulaWritesRefused\]/)
  })

  it('🔴 a STORED formula still displays where writes are refused', () => {
    /* Hiding it would leave the operator looking at a computed value whose rule they can neither
       read nor account for — the hazard `formulaAvailability`'s "always available when stored" arm
       exists to prevent. Only AUTHORING is suppressed, which is why the refusal gates the
       `formulaMode` half of the disjunction and not the `storedExpr` half. */
    expect(record).toContain('(storedExpr != null || (formulaMode && !formulaWritesRefused))')
  })

  it('🔴 ↑/↓ indexes the panel\'s OWN match list, never the field\'s options array', () => {
    /* `ListboxPanel` re-ranks and regroups what it is handed (`searchOptions` + `groupOptions`), so
       `options[i]` and `matches[i]` are different rows. Indexing the local array would highlight one
       candidate and insert another — invisible on a short list where the orders happen to agree,
       and wrong exactly when the list is long enough that the operator needs the keyboard. */
    expect(composer).toContain('matches[active] ?? matches[0] ?? suggestions.options[0]')
    expect(composer).not.toMatch(/choose\(suggestions.options\[active\]/)
    /* The panel is told what is highlighted, and hands back the list that index belongs to. */
    expect(composer).toContain('onMatchesChange={setMatches}')
    expect(composer).toContain('activeIndex={active}')
  })

  it('🔴 walking the list is announced, because focus never moves', () => {
    /* The caret stays in the input while the highlight moves in a panel the input does not contain.
       Without `aria-activedescendant` the feature exists and is silent to a screen reader. */
    expect(composer).toContain('aria-activedescendant={open && matches[active] ? `${id}-o${active}`')
    /* The shared ListboxPanel now exposes its ID, so aria-controls resolves.
       Previous contract: no dangling `aria-controls`: the panel's container carries no id to point at, so the
       attribute would name an element that does not exist.
       🔴 Matched as an ATTRIBUTE (`aria-controls=`), not as the word — the file's comment names it
       precisely to record why it is absent, and the bare word fails on that prose. Third time this
       shape has bitten in this file; each time the test caught it only because it was written to be
       capable of failing rather than to pass. */
    expect(composer).toContain('aria-controls={open ? `${id}-listbox`')
    expect(composer).toContain('<ListboxPanel idPrefix={id}')
  })

  it('the formula field does not wear the grid wrapper that would make its text invisible', () => {
    /* `.nds-formula-editor` sets `color: transparent` on the input for the grid's syntax-highlight
       overlay. This field has no overlay, so that class would hide everything typed into it.
       Matched as a className, for the same comment reason as above — the file's header names the
       class precisely to record why it is not used. */
    expect(composer).not.toMatch(/className=["'][^"']*nds-formula-editor/)
    /* The classes it SHOULD share, so the two surfaces look like one feature rather than two. */
    expect(field).toContain('<FormulaComposer')
    expect(composer).toContain('nds-formula-preview')
    expect(composer).toContain('nds-formula-pop')
  })
})

it('uses the same language-scoped reference values as both sheets', () => {
  const candidates = buildFormulaCandidates([{key:'name@de',label:'Name'},{key:'name@fr',label:'Name'}],
    {'name@de':{value:'Deutsch'},'name@fr':{value:'Français'}}, [], 'description@fr', 'de')
  expect(candidates).toEqual([{name:'name',label:'Name',kind:'field',group:'Columns',value:'Français'}])
})
