import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Share } from './sharingApi'
import { DEFAULT_FIELD_GROUPS, FIELD_GROUP_ORDER, FIELD_GROUP_WORDS, groupsSentence, plannedCopy, runResultWords, statusWords } from './words'

// The API owns the list. Two copies drift, so this reads the API's source and compares.
const rules = readFileSync(new URL('../../../../../api/src/services/assortment/share-rules.ts', import.meta.url), 'utf8')
const listIn = (name: string) => [...(new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(rules)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1])

describe('shared products words', () => {
  it('names every field group the API knows, in the API order, with the API defaults', () => {
    const apiGroups = listIn('FIELD_GROUPS')
    expect(apiGroups.length).toBeGreaterThan(5) // positive control: the source was really read
    expect([...FIELD_GROUP_ORDER]).toEqual(apiGroups)
    expect([...DEFAULT_FIELD_GROUPS]).toEqual(listIn('DEFAULT_FIELD_GROUPS'))
    expect(Object.keys(FIELD_GROUP_WORDS).sort()).toEqual([...apiGroups].sort())
  })

  it('never shows a group key or a status enum to a person', () => {
    expect(groupsSentence(['status', 'identity', 'media'])).toBe('Identifiers · Images · Active or draft')
    const share = { status: 'revoked', endedBySide: 'follower', respondedAt: '2026-09-17T10:00:00Z', endedAt: '2026-09-18T10:00:00Z', createdAt: '2026-09-16T10:00:00Z', pausedAt: null, workspaceName: 'Business B', ownerWorkspaceName: 'Business A' } as unknown as Share
    expect(statusWords(share, 'owner').detail).toMatch(/^Business B left this share on /)
    expect(statusWords(share, 'follower').detail).toMatch(/^You left this share on /)
    const withdrawn = { ...share, endedBySide: 'owner', respondedAt: null } as Share
    expect(statusWords(withdrawn, 'owner').detail).toMatch(/^You withdrew this share on /)
    for (const status of ['pending', 'active', 'paused', 'declined', 'revoked'] as const) {
      for (const side of ['owner', 'follower'] as const) {
        const words = statusWords({ ...share, status }, side)
        expect(`${words.label} ${words.detail}`).not.toMatch(/\b(pending|revoked|follower|undefined|null|NaN|Invalid Date)\b/)
        // pausedAt is null in this fixture: a missing date is left out, never "on ."
        expect(words.detail).not.toMatch(/ on \.|  /)
      }
    }
  })

  it('the planned copy follows the API rule: new copied, a match only when linked, a variation only with its main product', () => {
    const products = [
      { kind: 'match', sku: 'JKT', sourceProductId: 's1', parentSku: null, followerProductId: 'f1', followerName: 'Jacket' },
      { kind: 'linked', sku: 'COAT', sourceProductId: 's2', parentSku: null, followerProductId: 'f2' },
      { kind: 'new', sku: 'JKT-S', sourceProductId: 's3', parentSku: 'JKT' },
      { kind: 'new', sku: 'COAT-S', sourceProductId: 's4', parentSku: 'COAT' },
      { kind: 'blocked', sku: 'HAT', sourceProductId: 's5', parentSku: null, reason: 'A deleted product holds this SKU.' },
    ] as const
    const skip = plannedCopy([...products], { JKT: 'skip' })
    expect([...skip.includedSkus]).toEqual(['COAT-S']) // COAT is already linked, so its variation still comes
    expect([...skip.skippedByParent]).toEqual(['JKT-S'])
    const link = plannedCopy([...products], { JKT: 'link' })
    expect([...link.includedSkus]).toEqual(['JKT', 'JKT-S', 'COAT-S'])
    // The API's own rule, read from its source, still has the same two conditions (drift check).
    const api = readFileSync(new URL('../../../../../api/src/services/assortment/copy-run.service.ts', import.meta.url), 'utf8')
    expect(api).toContain("p.parentSku && !included.has(p.parentSku) && outcome.get(p.parentSku)?.kind !== 'linked'")
    expect(api).toContain("p.kind === 'match' && choices[p.sku] !== 'link'")
  })

  it('a run result counts only what the run produced', () => {
    expect(runResultWords({ state: 'reviewing', products: 3, skipped: 0, counts: null, error: null })).toBe('3 products in review')
    expect(runResultWords({ state: 'partial', products: 3, skipped: 1, error: null, counts: { linked: 2, alreadyLinked: 1, notSaved: 0, linkRefused: 0, managedApplied: 2, managedFailed: 0, imagesCopied: 1, imagesReused: 0, imagesAddressed: 1, imagesFailed: 1, mediaNotCopied: 1 } }))
      .toBe('3 products linked · 2 images added · 1 problem · 1 product skipped')
  })
})
