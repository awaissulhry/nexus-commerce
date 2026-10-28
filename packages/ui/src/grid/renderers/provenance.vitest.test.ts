import { describe, expect, it } from 'vitest'

import { classifyProvenance, describeCellSource, provenanceClassRules, provenanceLabel, provenanceTooltip, type CellProvenance, type ProvenanceLike } from './provenance'

describe('classifyProvenance', () => {
  it('a plain master value carries no mark — most cells, and they get no ink', () => {
    expect(classifyProvenance({ source: 'master', inherited: false, inheritedFrom: null })).toBe('own')
    expect(classifyProvenance(null)).toBe('own')
    expect(classifyProvenance(undefined)).toBe('own')
    expect(classifyProvenance({})).toBe('own')
  })

  it('reads the server’s own `inherited` verdict, and the parent it names', () => {
    expect(classifyProvenance({ source: 'master', inherited: true })).toBe('inherited')
    expect(classifyProvenance({ source: 'master', inheritedFrom: 'GALE-JACKET' })).toBe('inherited')
  })

  it('on the legacy read, inheriting from a non-master source is also an override inheritance', () => {
    expect(classifyProvenance({ source: 'master', inherited: true })).toBe('inherited')
    expect(classifyProvenance({ source: 'masterColumn', inherited: true })).toBe('inherited')
    expect(classifyProvenance({ source: 'channelOverride', inherited: true })).toBe('inheritedOverride')
  })

  it('an empty `inheritedFrom` is not an inheritance — a blank string is a missing value, not a parent', () => {
    expect(classifyProvenance({ source: 'master', inheritedFrom: '' })).toBe('own')
  })

  /**
   * 🔴 Measured on prod, on the parent row of GALE-JACKET. The resolver reports
   * `{ inherited: false, inheritedFrom: <the parent's OWN id> }` for a master attribute the parent
   * itself stores — `inheritedFrom` names where the value came from, which for a parent is itself.
   * Reading it as inheritance put the 🔗 glyph on all 21 rows when only the 20 children earn it,
   * and told the operator that editing the master would "pin" a value already its own.
   */
  it('an explicit `inherited: false` beats an inheritedFrom pointing at the row itself', () => {
    expect(classifyProvenance({ source: 'master', inherited: false, inheritedFrom: 'prod_1' })).toBe('own')
    expect(classifyProvenance({ layer: 'master', inherited: false, inheritedFrom: 'prod_1' })).toBe('own')
  })

  it('still infers inheritance from inheritedFrom when nobody stated a verdict', () => {
    expect(classifyProvenance({ source: 'master', inheritedFrom: 'parent_1' })).toBe('inherited')
  })

  it('an override source is a pin, however the resolver spells it', () => {
    for (const source of ['channelOverride', 'CHANNELEXPLICIT', 'variantOverride', 'aliasOverride', 'pinned']) {
      expect(classifyProvenance({ source })).toBe('pinned')
    }
  })

  /**
   * The layer changes the question. On the master sheet the master IS the layer, so a master value
   * is the row's own. On a channel sheet the master is the layer ABOVE, so anything more specific
   * than it has been pinned away from the master — which is what the operator needs to see.
   */
  it('resolves the same cell differently on a master sheet and a channel sheet', () => {
    const cell = { source: 'variant' }
    expect(classifyProvenance(cell, 'master')).toBe('own')
    expect(classifyProvenance(cell, 'channel')).toBe('pinned')
  })

  /**
   * 🔴 `masterLocale` and `masterColumn` ARE the master — it simply stores that field in a locale
   * slot or a legacy column (`attribute-resolver.ts`'s own `ValueSource`). Reading any non-`master`
   * string as a pin marked most CONTENT cells on a channel sheet "pinned away from the master"
   * when they were the master's own value, which is the opposite of the truth.
   */
  it('every flavour of master is master on a channel sheet, not a pin', () => {
    for (const source of ['master', 'masterLocale', 'masterColumn', 'default', 'schema']) {
      expect(classifyProvenance({ source }, 'channel')).toBe('own')
    }
    // …while the genuinely more-specific layers still read as pins there.
    for (const source of ['variant', 'variantLocale']) {
      expect(classifyProvenance({ source }, 'channel')).toBe('pinned')
    }
  })

  describe('PES.5 studio contract — the server states the layer, so nothing is inferred', () => {
    it('takes an explicit `layer` over any `source` guess', () => {
      expect(classifyProvenance({ layer: 'master', source: 'channelOverride' }, 'master')).toBe('own')
      expect(classifyProvenance({ layer: 'alias', source: 'master' }, 'channel')).toBe('pinned')
    })

    it('`pinned` is the ✎ glyph, stated rather than derived', () => {
      expect(classifyProvenance({ layer: 'master', pinned: true }, 'master')).toBe('pinned')
      expect(classifyProvenance({ layer: 'master', pinned: false }, 'master')).toBe('own')
    })

    it('a linked value is 🔗 — by layer or by linkGroupId', () => {
      expect(classifyProvenance({ layer: 'linked' }, 'master')).toBe('inherited')
      expect(classifyProvenance({ layer: 'channel', linkGroupId: 'grp_1' }, 'channel')).toBe('inherited')
    })

    /**
     * Ruling #16. Both are inherited; they RESET TO DIFFERENT PLACES, so they are different states.
     * A variant inheriting from its alias returns to the alias on reset, not to the Shared product.
     */
    it('distinguishes inherited-from-master from inherited-via-an-override', () => {
      expect(classifyProvenance({ layer: 'master', inherited: true }, 'channel')).toBe('inherited')
      expect(classifyProvenance({ layer: 'default', inherited: true }, 'channel')).toBe('inherited')
      expect(classifyProvenance({ layer: 'alias', inherited: true }, 'channel')).toBe('inheritedOverride')
      expect(classifyProvenance({ layer: 'aliasVariant', inherited: true }, 'channel')).toBe('inheritedOverride')
      expect(classifyProvenance({ layer: 'variant', inherited: true }, 'channel')).toBe('inheritedOverride')
    })

    it('the two inherited states say different things about what a reset does', () => {
      expect(provenanceTooltip('inherited', 'GALE-JACKET')).not.toMatch(/overrides the Shared product/)
      const via = provenanceTooltip('inheritedOverride', 'Bundle listing')
      expect(via).toMatch(/Bundle listing/)
      expect(via).toMatch(/not to the Shared product/)
    })

    it('both inherited states carry the shared tint class; only one carries the override class', () => {
      const rules = provenanceClassRules<{ p: CellProvenance }>((d) => d.p)
      const ask = (name: string, p: CellProvenance) => (rules[name as keyof typeof rules] as (x: unknown) => boolean)({ data: { p }, colDef: { colId: 'c' } })
      expect([ask('nds-cell-is-inherited', 'inherited'), ask('nds-cell-is-inherited-override', 'inherited')]).toEqual([true, false])
      expect([ask('nds-cell-is-inherited', 'inheritedOverride'), ask('nds-cell-is-inherited-override', 'inheritedOverride')]).toEqual([true, true])
    })

    it('a link outranks a pin: a linked cell is not this row’s own value, whatever else is set', () => {
      expect(classifyProvenance({ layer: 'alias', pinned: true, linkGroupId: 'grp_1' }, 'channel')).toBe('inherited')
    })

    it('an aliasVariant value on a channel sheet is a pin even when `pinned` is absent', () => {
      // The server sets `pinned` for the six flagged fields only; JSONB attributes carry no flag.
      expect(classifyProvenance({ layer: 'aliasVariant' }, 'channel')).toBe('pinned')
      expect(classifyProvenance({ layer: 'default' }, 'channel')).toBe('own')
    })
  })

  it('an AI draft outranks everything — it is the fact the operator must act on', () => {
    expect(classifyProvenance({ source: 'master', inherited: true, aiDrafted: true })).toBe('ai')
    expect(classifyProvenance({ source: 'channelOverride', aiDrafted: true })).toBe('ai')
  })

  it('a draft whose cell has moved since is STALE, not clean — approving it would overwrite an edit', () => {
    expect(classifyProvenance({ source: 'master', aiDrafted: true, aiStale: true })).toBe('aiStale')
    // `aiStale` without a draft is meaningless and must not invent a draft state.
    expect(classifyProvenance({ source: 'master', aiStale: true })).toBe('own')
  })
})

describe('provenanceTooltip', () => {
  it('names the layer when it knows it, and stays true when it does not', () => {
    expect(provenanceTooltip('inherited', 'GALE-JACKET')).toContain('GALE-JACKET')
    expect(provenanceTooltip('inherited')).toContain('the parent')
    expect(provenanceTooltip('pinned', 'Amazon · IT')).toContain('Amazon · IT')
    expect(provenanceTooltip('ai')).toMatch(/not yet approved/i)
  })

  it('says nothing for a cell with nothing to say', () => {
    expect(provenanceTooltip('own')).toBe('')
  })

  it('every provenance except `own` produces a sentence', () => {
    for (const p of ['inherited', 'pinned', 'ai'] as CellProvenance[]) {
      expect(provenanceTooltip(p).length).toBeGreaterThan(10)
    }
  })
})

describe('provenanceClassRules', () => {
  interface Row {
    id: string
    prov: Record<string, CellProvenance>
  }
  const rules = provenanceClassRules<Row>((d, colId) => d.prov[colId] ?? 'own')
  const ask = (name: keyof typeof rules, data: Row | undefined, colId: string) =>
    (rules[name] as (p: unknown) => boolean)({ data, colDef: { colId } })

  it('sets exactly one class per cell, and none for `own`', () => {
    const row: Row = { id: 'r1', prov: { title: 'inherited', price: 'pinned', bullets: 'ai', sku: 'own' } }
    expect([ask('nds-cell-is-inherited', row, 'title'), ask('nds-cell-is-pinned', row, 'title'), ask('nds-cell-is-ai-draft', row, 'title')]).toEqual([true, false, false])
    expect([ask('nds-cell-is-inherited', row, 'price'), ask('nds-cell-is-pinned', row, 'price'), ask('nds-cell-is-ai-draft', row, 'price')]).toEqual([false, true, false])
    expect([ask('nds-cell-is-inherited', row, 'bullets'), ask('nds-cell-is-pinned', row, 'bullets'), ask('nds-cell-is-ai-draft', row, 'bullets')]).toEqual([false, false, true])
    expect([ask('nds-cell-is-inherited', row, 'sku'), ask('nds-cell-is-pinned', row, 'sku'), ask('nds-cell-is-ai-draft', row, 'sku')]).toEqual([false, false, false])
  })

  /**
   * PES.8's request: a STALE draft is still a draft (it keeps the base class and its tint) and is
   * additionally marked, so approving it cannot look like approving a clean one.
   */
  it('a stale AI draft carries BOTH the draft class and the stale class', () => {
    const row: Row = { id: 'r1', prov: { title: 'ai', bullets: 'aiStale' } }
    expect([ask('nds-cell-is-ai-draft', row, 'title'), ask('nds-cell-is-ai-draft-stale', row, 'title')]).toEqual([true, false])
    expect([ask('nds-cell-is-ai-draft', row, 'bullets'), ask('nds-cell-is-ai-draft-stale', row, 'bullets')]).toEqual([true, true])
  })

  it('a row AG has not loaded yet marks nothing, rather than throwing inside a class rule', () => {
    for (const name of ['nds-cell-is-inherited', 'nds-cell-is-pinned', 'nds-cell-is-ai-draft'] as const) {
      expect(ask(name, undefined, 'title')).toBe(false)
    }
  })

  it('falls back to the column FIELD when a def carries no colId', () => {
    const row: Row = { id: 'r1', prov: { title: 'inherited' } }
    expect((rules['nds-cell-is-inherited'] as (p: unknown) => boolean)({ data: row, colDef: { field: 'title' } })).toBe(true)
  })
})

describe('formula — D16\'s ninth member (#763)', () => {
  it('a cell with a stored formula reads as `formula`', () => {
    expect(classifyProvenance({ layer: 'variant', pinned: true, formula: true }, 'master')).toBe('formula')
  })

  it('🔴 it OUTRANKS mapped and mappedShared — both computed, but edited in different PLACES', () => {
    // A mapped value sends the operator to the rule; a formula is edited in this cell. A cell that
    // is both must read as the one they can act on, or the mark points at a surface with nothing
    // on it for this cell.
    expect(classifyProvenance({ formula: true, mapped: { status: 'mapped' } }, 'master')).toBe('formula')
    expect(classifyProvenance({ formula: true, mapped: { status: 'mapped' }, mappedProductLevel: true }, 'master')).toBe('formula')
  })

  it('🔴 an AI draft still wins — an unapproved proposal demands a decision first', () => {
    expect(classifyProvenance({ formula: true, aiDrafted: true }, 'master')).toBe('ai')
    expect(classifyProvenance({ formula: true, aiDrafted: true, aiStale: true }, 'master')).toBe('aiStale')
  })

  it('it outranks inheritance and pinning, which describe a value this cell does not simply hold', () => {
    expect(classifyProvenance({ formula: true, inherited: true, inheritedFrom: 'GALE-JACKET' }, 'master')).toBe('formula')
  })

  it('🔴 absent or false leaves every other verdict exactly as it was', () => {
    // The member must be inert when the lane supplies nothing — a sheet with no formula read must
    // classify identically to one before this member existed.
    expect(classifyProvenance({ layer: 'master', inherited: true }, 'master')).toBe('inherited')
    expect(classifyProvenance({ layer: 'master', inherited: true, formula: false }, 'master')).toBe('inherited')
    expect(classifyProvenance({ mapped: { status: 'mapped' }, formula: false }, 'master')).toBe('mapped')
  })

  it('the tooltip names where the next click lands, like every other member', () => {
    expect(provenanceTooltip('formula')).toMatch(/formula on this cell/i)
    expect(provenanceTooltip('formula')).toMatch(/edit the cell/i)
  })

  it('the class rule fires only for `formula`', () => {
    const rules = provenanceClassRules<{ p: CellProvenance }>((d) => d.p)
    const at = (p: CellProvenance) => rules['nds-cell-is-formula']({ data: { p }, colDef: { colId: 'x' } })
    expect(at('formula')).toBe(true)
    expect(at('mapped')).toBe(false)
    expect(at('pinned')).toBe(false)
    expect(at('own')).toBe(false)
  })
})

/**
 * #780 — `refused`. The member that exists because a cell was asserting something FALSE: a formula
 * whose result the server refused stored its expression, wrote no value, and the cell still drew
 * `ƒ · "Calculated by a formula on this cell"` over a value that formula had not calculated.
 */
describe('classifyProvenance — refused', () => {
  it('classifies a stored formula with a server reason as refused, NOT as formula', () => {
    expect(classifyProvenance({ formula: true, refusedReason: 'x is not an allowed value' })).toBe('refused')
  })

  /* 🔴 The load-bearing negative. `refused` is derived from the REASON's presence, so an empty
     string or a null must not tip a perfectly good formula into a warning — that would put a ⚠ on
     every formula cell the moment the server sent `lastError: ""`. */
  it('leaves a formula alone when there is no reason', () => {
    expect(classifyProvenance({ formula: true })).toBe('formula')
    expect(classifyProvenance({ formula: true, refusedReason: null })).toBe('formula')
    expect(classifyProvenance({ formula: true, refusedReason: '' })).toBe('formula')
  })

  /* Precedence, asserted rather than remembered: every other member says where a value came FROM;
     this one says the cell is not what its own mark claims, so it outranks even an AI draft. */
  it('outranks ai, mapped, pinned and inherited', () => {
    const reason = 'The result is 300 characters; Item Name accepts 200.'
    expect(classifyProvenance({ refusedReason: reason, aiDrafted: true })).toBe('refused')
    expect(classifyProvenance({ refusedReason: reason, aiDrafted: true, aiStale: true })).toBe('refused')
    expect(classifyProvenance({ refusedReason: reason, mapped: { status: 'mapped' } })).toBe('refused')
    expect(classifyProvenance({ refusedReason: reason, pinned: true })).toBe('refused')
    expect(classifyProvenance({ refusedReason: reason, inherited: true, inheritedFrom: 'GALE-JACKET' })).toBe('refused')
  })

  it('does not invent a refusal on a cell that has none', () => {
    expect(classifyProvenance({ inherited: true, inheritedFrom: 'GALE-JACKET' })).toBe('inherited')
    expect(classifyProvenance(null)).toBe('own')
    expect(classifyProvenance({})).toBe('own')
  })
})

describe('provenanceTooltip — refused', () => {
  /* 🔴 THE SERVER'S REASON AND NOTHING ELSE (#780, and pre-ruled by the hub). No prefix, no field
     name, no restatement: the server already writes a whole sentence, and wrapping it puts two
     voices in one tooltip — and, where the server names the field, two labels for one column. */
  it('is the server reason verbatim — no prefix, no wrapper', () => {
    const reason = '"purple" is not an allowed value for Colour — choose one of: Black, Yellow'
    expect(provenanceTooltip('refused', reason)).toBe(reason)
  })

  it('never returns empty, even for a refusal with no reason text', () => {
    expect(provenanceTooltip('refused', null)).toBe('This formula produced no value')
    expect(provenanceTooltip('refused')).toBe('This formula produced no value')
  })

  /* The formula tooltip is unchanged — this is the claim `refused` replaces, kept here so a future
     edit cannot quietly make the two say the same thing. */
  it('still says "Calculated by a formula" for a formula that was NOT refused', () => {
    expect(provenanceTooltip('formula')).toBe('Calculated by a formula on this cell — edit the cell to change the formula')
  })
})

/*
 * 2026-10-04 — channel cell marks. Four members for the channel scopes (`pending`, `attention`, `listingValue`,
 * `listingLevel`). The DS describes them (label, sentence, tint); the product sheet's channel verdict decides them.
 */
/** Verdict counts of the sweep below, computed with main's `provenance.ts` (02f30039e) before the four members existed. */
const CLASSIFY_COUNTS_ON_MAIN = {
  master: { ai: 13824, formula: 13824, inherited: 5976, inheritedOverride: 648, mapped: 1728, mappedShared: 1728, outdated: 13824, own: 984, pinned: 2760, refused: 13824 },
  variant: { ai: 13824, formula: 13824, inherited: 5976, inheritedOverride: 648, mapped: 1728, mappedShared: 1728, outdated: 13824, own: 360, pinned: 3384, refused: 13824 },
  channel: { ai: 13824, formula: 13824, inherited: 5976, inheritedOverride: 648, mapped: 1728, mappedShared: 1728, outdated: 13824, own: 360, pinned: 3384, refused: 13824 },
}
const ALL_MEMBERS: CellProvenance[] = ['own', 'inherited', 'inheritedOverride', 'pinned', 'ai', 'aiStale', 'mapped', 'mappedShared',
  'outdated', 'formula', 'refused', 'pending', 'attention', 'listingValue', 'listingLevel']

describe('the words — "the Shared product", never "the master"', () => {
  it('no sentence or label a user reads says "master", with or without a source', () => {
    for (const m of ALL_MEMBERS) {
      for (const from of [undefined, null, 'GALE-JACKET']) expect(provenanceTooltip(m, from)).not.toMatch(/master/i)
      expect(provenanceLabel(m)).not.toMatch(/master/i)
    }
  })
  it('every member but `own` has a label and a sentence', () => {
    for (const m of ALL_MEMBERS.filter((x) => x !== 'own')) {
      expect(provenanceLabel(m).length).toBeGreaterThan(3)
      expect(provenanceTooltip(m).length).toBeGreaterThan(10)
    }
    expect(provenanceLabel('own')).toBe('')
  })
  it('a cell with no stated source names the layer in words, never its id', () => {
    expect(describeCellSource({ layer: 'master', inherited: true }).tooltip).toBe('Inherited from the Shared product — edit to give this row its own value')
    expect(describeCellSource({ layer: 'master', inherited: true }).from).toBe('the Shared product')
    expect(describeCellSource({ layer: 'somethingNew', inherited: true }).from).toBeNull()
  })
})

describe('provenanceTooltip — the four channel members', () => {
  /* Like `refused`: the server's sentence, verbatim — no prefix, no restatement. */
  it('pending and attention return the server sentence verbatim', () => {
    const waits = 'Live on eBay until you publish: Gale Jacket, black'
    const fba = 'Amazon reports this listing as FBA — Nexus does not send its quantity.'
    expect(provenanceTooltip('pending', waits)).toBe(waits)
    expect(provenanceTooltip('attention', fba)).toBe(fba)
  })
  it('pending and attention never return empty without a sentence', () => {
    expect(provenanceTooltip('pending')).toBe('Saved in Nexus — the channel gets this value when you publish')
    expect(provenanceTooltip('pending', null)).toBe('Saved in Nexus — the channel gets this value when you publish')
    expect(provenanceTooltip('attention')).toBe('Needs attention — this value may not reach the channel as shown')
  })
  it('listingValue says the listing holds its own text and how to follow the Shared product', () => {
    const text = provenanceTooltip('listingValue', 'eBay · IT')
    expect(text).toBe('This listing still holds its own text, not the Shared product’s — the next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now')
    expect(provenanceTooltip('listingValue')).toBe(text)
  })
  it('listingLevel states the scope of an edit, with the row it is read from when known', () => {
    expect(provenanceTooltip('listingLevel', 'GALE-JACKET')).toBe('One value for the whole listing, from GALE-JACKET — setting or clearing it here sets it for every variation')
    expect(provenanceTooltip('listingLevel')).toBe('One value for the whole listing — setting or clearing it here sets it for every variation')
  })
})

/* 2026-10-04 (A2): ONE punctuation rule for every DS sentence — none ends with a full stop. A server sentence passed as
   `from` for refused / pending / attention is returned verbatim and is not held to it. */
describe('provenanceTooltip — one ending rule', () => {
  const MEMBERS = ['inherited', 'inheritedOverride', 'pinned', 'mapped', 'mappedShared', 'ai', 'aiStale', 'formula', 'refused',
    'outdated', 'pending', 'attention', 'listingValue', 'listingLevel'] as const
  it('no DS sentence ends with a full stop, with or without a source', () => {
    for (const m of MEMBERS) {
      for (const from of [undefined, 'GALE-JACKET']) {
        if (from && (m === 'refused' || m === 'pending' || m === 'attention')) continue
        const text = provenanceTooltip(m, from)
        expect([m, from, text.length > 0 && !/[.]$/.test(text)]).toEqual([m, from, true])
      }
    }
  })
  it('the language pin sentence follows it too', () => {
    expect(describeCellSource({ tier: 'pin', follows: false, provenance: { member: 'pinned', from: 'Dutch · Amazon · BE · pin' } } as ProvenanceLike).tooltip)
      .toBe('Pinned at Dutch · Amazon · BE · pin — changes to the shared language text do not replace this value')
  })
})

describe('provenanceClassRules — the four channel members', () => {
  const rules = provenanceClassRules<{ p: CellProvenance }>((d) => d.p)
  const on = (p: CellProvenance) => Object.entries(rules).filter(([, f]) => (f as (x: unknown) => boolean)({ data: { p }, colDef: { colId: 'c' } })).map(([k]) => k)
  it('each new member sets exactly its own class', () => {
    expect(on('pending')).toEqual(['nds-cell-is-awaiting-publish'])
    expect(on('attention')).toEqual(['nds-cell-is-attention'])
    expect(on('listingValue')).toEqual(['nds-cell-is-listing-value'])
    expect(on('listingLevel')).toEqual(['nds-cell-is-listing-level'])
  })
  /* 🔴 The save tracker owns `nds-cell-is-pending` (a save in flight). A value waiting for Publish is SAVED. */
  it('never reuses the save tracker\'s pending class', () => {
    expect(Object.keys(rules)).not.toContain('nds-cell-is-pending')
    for (const m of ALL_MEMBERS) expect(on(m)).not.toContain('nds-cell-is-pending')
  })
  it('the existing members keep exactly their classes', () => {
    expect(on('own')).toEqual([])
    expect(on('inherited')).toEqual(['nds-cell-is-inherited'])
    expect(on('inheritedOverride')).toEqual(['nds-cell-is-inherited', 'nds-cell-is-inherited-override'])
    expect(on('pinned')).toEqual(['nds-cell-is-pinned'])
    expect(on('mapped')).toEqual(['nds-cell-is-mapped'])
    expect(on('mappedShared')).toEqual(['nds-cell-is-mapped', 'nds-cell-is-mapped-shared'])
    expect(on('outdated')).toEqual(['nds-cell-is-outdated'])
    expect(on('formula')).toEqual(['nds-cell-is-formula'])
    expect(on('refused')).toEqual(['nds-cell-is-formula-refused'])
    expect(on('ai')).toEqual(['nds-cell-is-ai-draft'])
    expect(on('aiStale')).toEqual(['nds-cell-is-ai-draft', 'nds-cell-is-ai-draft-stale'])
  })
})

describe('describeCellSource — the four channel members', () => {
  it('pending and attention carry the server sentence as `from`, and nothing else stands in for it', () => {
    const sentence = 'Saved in Nexus, not sent: eBay refused the last send.'
    expect(describeCellSource({ provenance: { member: 'attention', from: sentence } })).toEqual({ member: 'attention', from: sentence, tooltip: sentence })
    // A layer must never become the hover text of a sentence member.
    const bare = describeCellSource({ provenance: { member: 'pending', from: null }, layer: 'alias' }, { from: 'an internal row id' })
    expect(bare).toEqual({ member: 'pending', from: null, tooltip: 'Saved in Nexus — the channel gets this value when you publish' })
  })
  it('listingLevel and listingValue keep the ordinary source rule', () => {
    expect(describeCellSource({ provenance: { member: 'listingLevel', from: 'GALE-JACKET' } }).tooltip).toContain('from GALE-JACKET')
    expect(describeCellSource({ provenance: { member: 'listingValue', from: 'eBay · IT' } }).member).toBe('listingValue')
  })
})

/*
 * 🔴 `classifyProvenance` must NOT change for any existing input: the Shared scope and the Variants tab read it, and the
 * channel verdict lives in the sheet (`channelCellProvenance`), not here. Two proofs:
 *   1. a table of the shapes those two surfaces send, with the verdicts they had before the four members existed;
 *   2. a combinatorial sweep of the generic inputs: none of the four channel members ever comes out of them, and the
 *      count per member per layer is pinned (taken from main at 02f30039e, before this change).
 */
describe('classifyProvenance — unchanged by the four channel members', () => {
  it('the Shared scope and Variants tab shapes keep their verdicts', () => {
    const table: [ProvenanceLike, 'master' | 'variant' | 'channel', CellProvenance][] = [
      [{ layer: 'master', inherited: false }, 'master', 'own'],
      [{ layer: 'master', inherited: true, inheritedFrom: 'GALE-JACKET' }, 'master', 'inherited'],
      [{ layer: 'variant', pinned: true }, 'master', 'pinned'],
      [{ provenance: { member: 'pinned', from: 'German · shared' }, follows: true }, 'master', 'inherited'],
      [{ provenance: { member: 'inherited', from: 'German · shared' } }, 'master', 'inherited'],
      [{ translation: { outdated: true } }, 'master', 'outdated'],
      [{ translation: { outdated: false, source: 'ai', reviewedAt: null } }, 'master', 'ai'],
      [{ formula: true, refusedReason: 'Too long.' }, 'master', 'refused'],
      [{ mapped: { status: 'mapped' }, mappedProductLevel: true }, 'channel', 'mappedShared'],
      [{ mapped: { status: 'mapped', derived: false }, layer: 'master', inherited: true }, 'channel', 'inherited'],
      [{ layer: 'alias', inherited: true }, 'channel', 'inheritedOverride'],
      [{ layer: 'aliasVariant' }, 'channel', 'pinned'],
      [{ layer: 'default' }, 'channel', 'own'],
      [{ source: 'variant' }, 'variant', 'pinned'],
      [{ source: 'masterLocale' }, 'channel', 'own'],
      [{ source: 'channelSnapshot', inherited: false }, 'channel', 'pinned'],
    ]
    for (const [cell, layer, expected] of table) expect([cell, layer, classifyProvenance(cell, layer)]).toEqual([cell, layer, expected])
  })

  it('no generic input yields a channel member, and the verdict counts are the ones main produced', () => {
    const counts: Record<string, Record<string, number>> = {}
    const opt = <V,>(...v: V[]) => v
    for (const layerArg of opt<'master' | 'variant' | 'channel'>('master', 'variant', 'channel'))
      for (const layer of opt(undefined, 'master', 'variant', 'alias', 'aliasVariant', 'channel', 'linked', 'default'))
        for (const source of opt(undefined, 'master', 'masterLocale', 'variant', 'channelOverride', 'channelSnapshot'))
          for (const inherited of opt(undefined, true, false))
            for (const pinned of opt(undefined, true))
              for (const follows of opt(undefined, true))
                for (const mapped of opt(undefined, { status: 'mapped' }, { status: 'mapped', derived: false }, { status: 'unmapped' }))
                  for (const mappedProductLevel of opt(undefined, true))
                    for (const member of opt<CellProvenance | undefined>(undefined, 'inherited', 'pinned'))
                      for (const extra of opt<ProvenanceLike>({}, { formula: true }, { aiDrafted: true }, { translation: { outdated: true } }, { refusedReason: 'No.' })) {
                        const cell: ProvenanceLike = { layer, source, inherited, pinned, follows, mapped, mappedProductLevel, ...(member ? { provenance: { member, from: null } } : {}), ...extra }
                        const verdict = classifyProvenance(cell, layerArg)
                        ;(counts[layerArg] ??= {})[verdict] = (counts[layerArg][verdict] ?? 0) + 1
                      }
    for (const byLayer of Object.values(counts)) for (const m of ['pending', 'attention', 'listingValue', 'listingLevel']) expect(byLayer[m]).toBeUndefined()
    expect(counts).toEqual(CLASSIFY_COUNTS_ON_MAIN)
  })
})
