/** Verify the exact coordinator patch in a disposable copy, never the shared working file. */
import { expect, it } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

it('blocks destination-bound composition before resolver/database/publisher work and preserves explicit consumer themes', async () => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url))
  const relative = 'apps/api/src/services/listing-wizard/submission.service.ts'
  const patch = join(root, 'docs/catalog-redesign-sessions/session-02-presets-integration/submission-contract.patch')
  const directory = mkdtempSync(join(tmpdir(), 'nexus-session-two-submission-'))
  try {
    const target = join(directory, relative)
    mkdirSync(join(directory, 'apps/api/src/services/listing-wizard'), { recursive: true })
    const current = readFileSync(join(root, relative), 'utf8')
    writeFileSync(target, current)
    // After coordinator integration the same test exercises current source directly.
    if (!current.includes("Object.prototype.hasOwnProperty.call(state, 'productPresetScope')")) execFileSync('git', ['apply', patch], { cwd: directory })
    expect(readFileSync(target, 'utf8')).toContain("Object.prototype.hasOwnProperty.call(state, 'productPresetScope')")
    const compiled = ts.transpileModule(readFileSync(target, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exported: any = {}
    // Expose the actual private strategy helpers only inside this isolated test copy.
    new Function('require', 'exports', `${compiled}\nexports.readSkuStrategy = readSkuStrategy; exports.applySkuStrategy = applySkuStrategy;`)(() => ({ primaryConnectionIds: () => { throw new Error('Unexpected account resolution') } }), exported)
    const service = new exported.SubmissionService(new Proxy({}, { get: () => { throw new Error('Unexpected database access') } }))
    const wizard = { id: 'bound-draft', productId: 'p1', channels: [{ platform: 'AMAZON', marketplace: 'IT' }], state: { productPresetScope: { accountId: 'account-a' }, variations: { commonTheme: 'COLOR_NAME', includedSkus: ['CHILD-S'] } }, channelStates: { 'AMAZON:IT': { variations: { theme: 'SIZE_NAME' } } } }
    expect(await service.composeMultiChannelPayloads(wizard)).toEqual([{ channelKey: 'AMAZON:IT', platform: 'AMAZON', marketplace: 'IT', unsupported: true, reason: expect.stringContaining('account-aware') }])
    for (const value of [null, '', false]) {
      wizard.channelStates['AMAZON:IT'].variations.theme = value as any
      const report = service.validateMultiChannel(wizard)
      expect(report.channels[0].items.find((i: any) => i.title === 'Variations').status).toBe('incomplete')
    }
    wizard.channelStates['AMAZON:IT'].variations.theme = 'SIZE_NAME'
    expect(service.validateMultiChannel(wizard).channels[0].items.find((i: any) => i.title === 'Variations').message).toContain('SIZE_NAME')
    const strategy = exported.readSkuStrategy({ skuStrategy: { parentSku: 'per-marketplace', childSku: 'per-marketplace' } })
    expect(exported.applySkuStrategy('ALPINE', 'IT', strategy.parentSku, undefined)).toBe('ALPINE-IT')
    expect(exported.applySkuStrategy('ALPINE-S', 'IT', strategy.childSku, 'EXISTING-SKU')).toBe('EXISTING-SKU')
    delete (wizard.channelStates['AMAZON:IT'].variations as any).theme
    ;(wizard.state.variations as any).themeByChannel = { 'AMAZON:IT': 'SIZE_NAME' }
    expect(service.validateMultiChannel(wizard).channels[0].items.find((i: any) => i.title === 'Variations').message).toContain('SIZE_NAME')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
