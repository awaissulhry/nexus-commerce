/**
 * PES.4 — the provenance vocabulary must cover what the API actually emits.
 *
 * The drawer renders ONE layer vocabulary and maps the API's two onto it (`toLayer`). The failure
 * this guards is quiet and expensive: the API gains a provenance value, nothing here changes, and
 * every field carrying it renders as "Unrecognised" — or worse, a future maintainer folds it into
 * `master` to make the chip look right and the drawer starts claiming a channel override is the
 * master's own value.
 *
 * So the expected members are not restated here. They are READ from the two API files that define
 * them, and every one must map to a known layer. A test that hard-coded the list would pass
 * forever while the thing it is about drifted.
 *
 * The extraction is bounded (the `export type X =` block up to the first blank line) and asserts
 * a non-empty result FIRST — an extractor that silently matches nothing would otherwise turn this
 * into a test that passes because it checked nothing, which is the worse of the two failures.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { pimFile } from './api-source.testutil'

import {
  isInherited,
  isOwnValue,
  LAYER_HINT,
  LAYER_LABEL,
  previousWasRecorded,
  resolveLayer,
  toLayer,
  type Layer,
} from './types'

/** Members of `export type <name> = 'a' | 'b' | …`, read from the block that declares it. */
function unionMembers(file: string, typeName: string): string[] {
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf(`export type ${typeName} =`)
  if (start === -1) throw new Error(`${typeName} not found in ${file} — did it move or get renamed?`)
  // The declaration ends at the first blank line after it; every union in these files is written
  // one member per line with a trailing comment.
  const rest = src.slice(start)
  const end = rest.search(/\n\s*\n/)
  const block = end === -1 ? rest : rest.slice(0, end)
  return [...block.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1])
}

describe('the API provenance vocabularies are fully covered', () => {
  it('every attribute-resolver ValueSource maps to a known layer', () => {
    const members = unionMembers(pimFile('attribute-resolver.ts'), 'ValueSource')
    // Guard the extractor before trusting what it produced.
    expect(members.length).toBeGreaterThan(4)
    expect(members).toContain('master')

    const unmapped = members.filter((m) => toLayer(m) === 'unknown')
    expect(unmapped, `unmapped ValueSource members: ${unmapped.join(', ')}`).toEqual([])
  })

  it('the channel-field resolver provenance values map to a known layer', () => {
    // resolve-channel-field.ts documents its precedence as a numbered list in the module comment
    // rather than one exported union, so the members are named here — and this test exists to
    // fail loudly if that stops being true.
    const src = readFileSync(pimFile('resolve-channel-field.ts'), 'utf8')
    const documented = ['missing', 'locked', 'override', 'linked', 'fallback', 'default', 'catalogRule']
    for (const name of documented) {
      expect(src, `resolve-channel-field.ts no longer mentions '${name}'`).toContain(name)
      expect(toLayer(name), `'${name}' is not mapped`).not.toBe('unknown')
    }
  })

  it("the sheet's own 'schema' source maps, since sheet-rows writes it directly", () => {
    const src = readFileSync(pimFile('sheet-rows.service.ts'), 'utf8')
    expect(src).toContain("source: 'schema'")
    expect(toLayer('schema')).not.toBe('unknown')
  })
})

describe('toLayer', () => {
  it('never guesses: an unknown string is unknown, not master', () => {
    expect(toLayer('somethingNew')).toBe('unknown')
    expect(toLayer(null)).toBe('unknown')
    expect(toLayer(undefined)).toBe('unknown')
    expect(toLayer('')).toBe('unknown')
  })

  it('keeps the two channel spellings on ONE layer', () => {
    // `channelOverride` (JSONB bag) and `channelExplicit` (a *Override column) are the same fact
    // to an operator: someone pinned this on the listing.
    expect(toLayer('channelOverride')).toBe('channel')
    expect(toLayer('channelExplicit')).toBe('channel')
    expect(toLayer('override')).toBe('channel')
  })
})

describe('isInherited', () => {
  it('treats every layer that TRACKS something else as inherited', () => {
    for (const layer of ['master', 'locale', 'linked', 'mapped', 'default', 'channelSnapshot'] as Layer[]) {
      expect(isInherited(layer), layer).toBe(true)
    }
  })

  it("does NOT treat this scope's own pinned value as inherited", () => {
    // If these ever flipped, Reset would be offered on a value there is nothing to reset to, and
    // the first keystroke in a pinned field would try to pin it again.
    for (const layer of ['variant', 'alias', 'aliasVariant', 'channel'] as Layer[]) {
      expect(isInherited(layer), layer).toBe(false)
    }
  })
})

describe('PES.5 §3.2 StudioCellValue.layer', () => {
  it('every layer the studio sheet can send resolves — none lands as unknown', () => {
    // The seven in PES.5 §3.2's contract, verbatim. If the backend adds an eighth, `resolveLayer`
    // returns 'unknown' and this fails — which is the point: a new layer must be given a word and
    // a glyph deliberately, not folded into whichever chip happens to look right.
    const contract = ['master', 'variant', 'alias', 'aliasVariant', 'channel', 'linked', 'default']
    for (const layer of contract) {
      expect(resolveLayer({ layer, source: 'ignored' }), layer).not.toBe('unknown')
      // The server's word wins over `source` — that is the whole precedence.
      expect(resolveLayer({ layer, source: 'master' }), layer).toBe(layer)
    }
  })

  it('falls back to `source` only when no layer was sent', () => {
    expect(resolveLayer({ source: 'channelExplicit' })).toBe('channel')
    expect(resolveLayer({ layer: 'alias', source: 'channelExplicit' })).toBe('alias')
  })

  it('🔴 an ABSENT cell is `default`, not `unknown` — absence is a defined state', () => {
    // The sheet contract omits keys with no value anywhere. Reporting that as "Unrecognised"
    // claims a contract mismatch that has not happened — measured live, every empty optional
    // column rendered "? Unrecognised". `unknown` must stay reserved for a provenance string this
    // build genuinely does not know.
    expect(resolveLayer(undefined)).toBe('default')
    expect(resolveLayer({ source: 'somethingTheServerInvented' })).toBe('unknown')
  })
})

describe('isOwnValue', () => {
  it("trusts the server's `pinned` over anything inferred from the layer", () => {
    // A linked cell reads as inherited by layer, but if the server says this coordinate stores
    // the value, it stores the value. Getting this backwards offers Reset on a cell with nothing
    // to reset, or hides it on one that needs it.
    expect(isOwnValue({ layer: 'linked', source: 'linked', pinned: true })).toBe(true)
    expect(isOwnValue({ layer: 'channel', source: 'override', pinned: false })).toBe(false)
  })

  it('falls back to the layer only when NEITHER explicit flag was sent', () => {
    expect(isOwnValue({ layer: 'alias', source: 'override' })).toBe(true)
    expect(isOwnValue({ layer: 'master', source: 'master' })).toBe(false)
    expect(isOwnValue(undefined)).toBe(false)
  })

  it('🔴 a parent row is never "inherited from itself" (ruling #33, same bug independently)', () => {
    // A family root's OWN stored value carries layer 'master', and `isInherited('master')` is
    // true — so pure layer inference calls the row's own value inherited from itself. The read
    // sends `inherited: false` precisely here, and it must win.
    //
    // What it costs when it does not: no Reset on a value that has one, and the first edit sent
    // as `pin` — pinning an override onto the very row the value already lives on.
    expect(isOwnValue({ layer: 'master', source: 'master', inherited: false })).toBe(true)
    // The converse still reads correctly: a child quoting the parent is inherited.
    expect(isOwnValue({ layer: 'master', source: 'master', inherited: true })).toBe(false)
  })

  it('keeps `pinned` above `inherited` — the more specific answer to the same question', () => {
    expect(isOwnValue({ layer: 'master', source: 'master', pinned: true, inherited: true })).toBe(true)
    expect(isOwnValue({ layer: 'channel', source: 'override', pinned: false, inherited: false })).toBe(false)
  })
})

describe('every layer is presentable', () => {
  it('has both a label and a hint — a chip with no words is a colour', () => {
    const layers: Layer[] = [
      'master', 'variant', 'alias', 'aliasVariant', 'channel', 'linked', 'default',
      'locale', 'mapped', 'locked', 'channelSnapshot', 'unknown',
    ]
    for (const layer of layers) {
      expect(LAYER_LABEL[layer], layer).toBeTruthy()
      expect(LAYER_HINT[layer]?.length ?? 0, layer).toBeGreaterThan(20)
    }
  })
})

describe('previousWasRecorded — hub ruling #14', () => {
  it("takes the server's explicit flag over the payload's shape", () => {
    // The case the flag exists for: a captured EMPTY previous value. Without the flag this reads
    // as "not recorded"; with it, the pane can honestly show that the field was blank before.
    expect(previousWasRecorded({ previous: null, previousRecorded: true })).toBe(true)
    // And the reverse: a value present but explicitly not trustworthy as a `before`.
    expect(previousWasRecorded({ previous: 'x', previousRecorded: false })).toBe(false)
  })

  it('falls back to absent-vs-null until PES.5 ships the flag', () => {
    expect(previousWasRecorded({ previous: undefined })).toBe(false)
    expect(previousWasRecorded({ previous: null })).toBe(true)
    expect(previousWasRecorded({ previous: 'Old title' })).toBe(true)
  })

  it('errs toward "not recorded" — the cheaper of the two wrong answers', () => {
    // Rendering a value that was never captured invents a change that did not happen. Rendering
    // "not recorded" for a value that WAS captured only under-claims.
    expect(previousWasRecorded({ previous: undefined, previousRecorded: undefined })).toBe(false)
  })
})

describe('following channel snapshots', () => {
  it('names the stored channel value even when a legacy fold says master', () => {
    expect(toLayer('channelSnapshot')).toBe('channelSnapshot')
    expect(resolveLayer({ source: 'channelSnapshot', layer: 'master' })).toBe('channelSnapshot')
    expect(LAYER_LABEL.channelSnapshot).toBe('Channel snapshot')
    expect(LAYER_HINT.channelSnapshot).toContain('not an operator pin')
    expect(isOwnValue({ source: 'channelSnapshot' })).toBe(false)
    expect(resolveLayer({ source: 'master', layer: 'master' })).toBe('master')
  })
})
