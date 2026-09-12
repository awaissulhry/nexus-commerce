import { describe, it, expect } from 'vitest'
import { evaluateExpr, validateExpr, exprDependencies, exprDependenciesDeep, parseExpr, EXPR_FUNCTIONS } from './expr.js'

const values: Record<string, unknown> = {
  brand: 'Xavia Racing',
  name: 'Errol',
  colour: 'Midnight',
  itemasin: '',
  itemean: '7325707234606',
  basePrice: 1013.59,
  cost: 400,
  qty: 0,
  bullets: ['Superior Insulation', 'Genuine Sheepskin'],
  'categoryAttributes.material': 'Sheepskin',
}

const ctx = {
  lookup: (p: string) => (p in values ? values[p] : undefined),
  namedExpression: (n: string) =>
    n === 'SE_AS_TITLE'
      ? '$brand + " " + $name + " " + $colour'
      : n === 'Loop'
        ? 'rule("Loop")'
        : undefined,
}

const run = (src: string) => evaluateExpr(src, ctx)

describe('expr — the observed Rithum formulas', () => {
  it('if(isblank(...), a, b) picks the populated identifier', () => {
    expect(run('if(isblank($itemasin), $itemean, $itemasin)').value).toBe('7325707234606')
    expect(run('if(isblank($itemasin), "ean", "upc")').value).toBe('ean')
  })

  it('concatenates with + the way an operator expects', () => {
    expect(run('$brand + " " + $name').value).toBe('Xavia Racing Errol')
    expect(run('{{brand}} + " " + {{name}}').value).toBe('Xavia Racing Errol')
  })

  it('runs a named business rule by name', () => {
    expect(run('rule("SE_AS_TITLE")').value).toBe('Xavia Racing Errol Midnight')
  })

  it('computes a margin price', () => {
    // 400 at 20% gross margin = 500
    expect(run('round(margin($cost, 20), 2)').value).toBe(500)
    expect(run('round(markup($cost, 20), 2)').value).toBe(480)
    expect(run('round(discount($basePrice, 10), 2)').value).toBe(912.23)
  })
})

describe('expr — arithmetic and precedence', () => {
  it('multiplies before adding', () => {
    expect(run('2 + 3 * 4').value).toBe(14)
    expect(run('(2 + 3) * 4').value).toBe(20)
  })
  it('adds numerically when both sides are numeric, concatenates otherwise', () => {
    expect(run('1 + 2').value).toBe(3)
    expect(run('"a" + 1').value).toBe('a1')
    expect(run('$basePrice + 1').value).toBeCloseTo(1014.59, 5)
  })
  it('handles unary minus', () => {
    expect(run('-5 + 2').value).toBe(-3)
  })
})

describe('expr — the honesty rules', () => {
  it('a null never reads as a zero in a comparison', () => {
    const r = run('$missingThing > 0')
    expect(r.value).toBe(false)
    expect(r.warnings.some((w) => w.includes('unknown attribute'))).toBe(true)
  })

  it('0 and false are NOT blank', () => {
    expect(run('isblank($qty)').value).toBe(false)
    expect(run('isblank($itemasin)').value).toBe(true)
    expect(run('isblank($nope)').value).toBe(true)
  })

  it('division by zero warns and yields null, never Infinity', () => {
    const r = run('10 / $qty')
    expect(r.value).toBeNull()
    expect(r.warnings).toContain('division by zero')
  })

  it('a syntax error is reported, never thrown', () => {
    const r = run('if(isblank($a), "x"')
    expect(r.value).toBeNull()
    expect(r.error).toMatch(/expected "\)"/)
  })

  it('a bare word is caught as the missing-$ typo it usually is', () => {
    const r = run('brand + " " + $name')
    expect(r.error).toMatch(/\$brand/)
  })

  it('a self-referencing business rule is refused, not hung', () => {
    const r = run('rule("Loop")')
    expect(r.value).toBeNull()
    expect(r.warnings.some((w) => w.includes('refers to itself'))).toBe(true)
  })

  it('an unknown function names itself', () => {
    expect(run('frobnicate($brand)').warnings[0]).toContain('unknown function "frobnicate()"')
  })

  it('never evaluates the untaken branch', () => {
    // The else branch divides by zero; taking the then branch must not warn.
    const r = run('if(notblank($brand), "ok", 1 / 0)')
    expect(r.value).toBe('ok')
    expect(r.warnings).toEqual([])
  })
})

describe('expr — text + list helpers', () => {
  it('joins an array attribute', () => {
    expect(run('join($bullets, " | ")').value).toBe('Superior Insulation | Genuine Sheepskin')
  })
  it('slices and pads', () => {
    expect(run('left($brand, 6)').value).toBe('Xavia ')
    expect(run('pad("7", 3)').value).toBe('007')
    expect(run('upper($colour)').value).toBe('MIDNIGHT')
  })
  it('reads a dotted attribute path', () => {
    expect(run('$categoryAttributes.material').value).toBe('Sheepskin')
    expect(run('${categoryAttributes.material}').value).toBe('Sheepskin')
  })
  it('replaces literally, with no regex surprises', () => {
    expect(run('replace("a.b.c", ".", "-")').value).toBe('a-b-c')
  })
})

describe('expr — tooling', () => {
  it('validateExpr locates the error', () => {
    expect(validateExpr('$brand + ')).not.toBeNull()
    expect(validateExpr('$brand + " "')).toBeNull()
  })
  it('lists dependencies for the editor', () => {
    const d = exprDependencies('if(isblank($itemasin), rule("SE_AS_TITLE"), $itemean)')
    expect(d).not.toBeNull()
    expect(d!.attributes).toEqual(['itemasin', 'itemean'])
    expect(d!.rules).toEqual(['SE_AS_TITLE'])
  })

  it('distinguishes "does not parse" from "depends on nothing"', () => {
    // The whole point: an empty list is a REAL answer, so a broken formula must not produce one.
    expect(exprDependencies('$brand + ')).toBeNull()
    expect(exprDependencies('rule("Unclosed"')).toBeNull()
    expect(exprDependencies('"New"')).toEqual({ attributes: [], rules: [] })
    expect(exprDependencies('1 + 1')).toEqual({ attributes: [], rules: [] })
  })
  it('parses to a tree without executing anything', () => {
    expect(parseExpr('1 + 1').t).toBe('bin')
  })
})

describe('exprDependenciesDeep — the transitive closure', () => {
  const expressions = {
    Title: '$brand + " " + rule("Suffix")',
    Suffix: '$athlete_type + rule("Tag")',
    Tag: '"Pro"',
    LoopA: 'rule("LoopB")',
    LoopB: 'rule("LoopA")',
    Broken: 'if(isblank($x), "y"',
  }

  it('follows rule() chains the shallow walk misses', () => {
    const shallow = exprDependencies('rule("Title")')
    expect(shallow!.rules).toEqual(['Title'])
    expect(shallow!.attributes).toEqual([])

    const deep = exprDependenciesDeep('rule("Title")', expressions)
    expect(deep!.rules).toEqual(['Suffix', 'Tag', 'Title'])
    expect(deep!.attributes).toEqual(['athlete_type', 'brand'])
    expect(deep!.cycle).toBeNull()
  })

  it('reports a cycle instead of hanging or truncating', () => {
    const d = exprDependenciesDeep('rule("LoopA")', expressions)
    expect(d!.cycle).toEqual(['LoopA', 'LoopB', 'LoopA'])
  })

  it('names a referenced rule that is missing or broken, never skips it', () => {
    expect(exprDependenciesDeep('rule("Nope")', expressions)!.unresolved).toEqual(['Nope'])
    expect(exprDependenciesDeep('rule("Broken")', expressions)!.unresolved).toEqual(['Broken'])
  })

  it('keeps exprDependencies null-on-parse-failure contract', () => {
    expect(exprDependenciesDeep('$a + ', expressions)).toBeNull()
  })
})

describe('ifblank — the one-argument fallback (§1.6)', () => {
  it('returns the value when present, the fallback when blank', () => {
    expect(run('ifblank($brand, "unbranded")').value).toBe('Xavia Racing')
    expect(run('ifblank($itemasin, "no asin")').value).toBe('no asin')
    expect(run('ifblank($nope, "missing")').value).toBe('missing')
  })
  it('treats 0 and false as PRESENT, like isblank does', () => {
    expect(run('ifblank($qty, 99)').value).toBe(0)
  })
  it('is exactly if(isblank(a), b, a)', () => {
    for (const src of ['$brand', '$itemasin', '$qty']) {
      expect(run(`ifblank(${src}, "F")`).value).toEqual(run(`if(isblank(${src}), "F", ${src})`).value)
    }
  })
  it('does not evaluate the fallback when the value is present', () => {
    const r = run('ifblank($brand, 1 / 0)')
    expect(r.value).toBe('Xavia Racing')
    expect(r.warnings).toEqual([])
  })
  it('is listed for the editor', () => {
    expect(EXPR_FUNCTIONS.some((f) => f.name === 'ifblank')).toBe(true)
  })
})


describe('Excel text concatenation', () => {
  it('joins numeric-looking text without adding it', () => {
    expect(evaluateExpr('"12" & "34"', { lookup: () => null }).value).toBe('1234')
  })
  it('joins a field and a literal, preserving spaces', () => {
    expect(evaluateExpr('$brand & " Jacket"', { lookup: () => 'Xavia' }).value).toBe('Xavia Jacket')
  })
})


describe('exact formula comparisons', () => {
  it.each([['1 === 1', true], ['1 === "1"', false], ['"Nexus" === "nexus"', false], ['"Nexus" !== "nexus"', true], ['null === null', true], ['false === 0', false], ['if($brand === "Xavia Racing", "Match", "Different")', 'Match']])('%s', (expr, expected) => {
    expect(run(String(expr))).toMatchObject({ value: expected, warnings: [] })
  })
  it('keeps saved legacy comparisons compatible', () => { expect(run('"Nexus" = "nexus"').value).toBe(true) })
  it('refuses oversized expressions with a useful explanation', () => { expect(validateExpr('1 + '.repeat(5000) + '1')?.message).toContain('too long') })
})
