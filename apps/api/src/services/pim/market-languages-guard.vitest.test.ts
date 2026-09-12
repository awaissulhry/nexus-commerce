/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MARKET_LANGUAGE_EXEMPTIONS, marketLanguageViolations } from './market-languages-guard.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
}
describe('LX.2 market language guard', () => {
  it('rejects regional literals and channel-less Marketplace lookups with positive controls', () => {
    expect(marketLanguageViolations('services/probe.ts', `const tag = 'it_IT'; prisma.marketplace.findFirst({where:{code:'DE'}}); marketplaceRows.find(m=>m.code===code);`)).toHaveLength(3)
    expect(marketLanguageViolations('services/probe.ts', `prisma.marketplace.findFirst({where:{code:'DE',channel:'AMAZON'}}); marketplaceRows.find(m=>m.channel===channel&&m.code===code);`)).toEqual([])
    expect(marketLanguageViolations('services/amazon/flat-file.service.ts', `const tag = 'it_IT'`)).toEqual([])
    expect(marketLanguageViolations('services/channel-batch/amazon-batch-feed.service.ts', `const tag = 'it_IT'`)).toEqual([])
    expect(marketLanguageViolations('services/amazon/not-exempt.ts', `const tag = 'it_IT'`)).toHaveLength(1)
    expect(marketLanguageViolations('services/probe.ts', `const where = {code:'DE'}; prisma.marketplace.findFirst({where});`)).toHaveLength(1)
    expect(marketLanguageViolations('services/probe.ts', `const coordinate = {code:'DE'}; const args = {where:{...coordinate}}; prisma.marketplace.findFirst(args);`)).toHaveLength(1)
    expect(marketLanguageViolations('services/probe.ts', `const coordinate = {channel:'AMAZON',code:'DE'}; prisma.marketplace.findFirst({where:coordinate});`)).toEqual([])
  })
  it('scans tracked and untracked API sources, naming every Owner exemption', () => {
    const all = files(root).map(path => relative(root, path).replace(/\\/g, '/'))
    const checked = all.filter(path => !/(?:\.test\.tsx?$|\/__tests__\/)/.test(path))
    const exempt = checked.filter(path => MARKET_LANGUAGE_EXEMPTIONS.some(pattern => pattern.test(path)))
    const violations = checked.flatMap(path => marketLanguageViolations(path, readFileSync(join(root, path), 'utf8')))
    process.stdout.write(`${JSON.stringify({ guard: 'LX.2', scanned: checked.length, exempt, violations }, null, 2)}\n`)
    expect(checked.length).toBeGreaterThan(100)
    expect(exempt).toContain('services/amazon/flat-file.service.ts')
    expect(exempt).toContain('services/channel-batch/amazon-batch-feed.service.ts')
    expect(violations).toEqual([])
  })
})
