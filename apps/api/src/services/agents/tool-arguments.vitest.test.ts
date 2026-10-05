/**
 * Phase 1 N1 — an argument name a tool does not take is refused at Claude's door with the name it likely meant,
 * never dropped (a zod object strips unknown keys: `market` sent to a tool that takes `marketplace` used to vanish).
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { argumentNames, argumentsRefusal, unknownArgumentsProblem } from './tool-arguments.js'
import { getTool, listTools } from './tool-registry.js'
import { PLAN_TOOL } from './tool-types.js'

const publish = { name: 'publish-listing', readOnly: false, input: z.object({ productId: z.string(), channel: z.string(), marketplace: z.string(), fields: z.string().optional() }) }

describe('unknownArgumentsProblem', () => {
  it('names the wrong argument, the one it likely meant, and every name the tool takes', () => {
    expect(unknownArgumentsProblem(publish, { productId: 'p', channel: 'EBAY', market: 'IT' }))
      .toBe('publish-listing does not take the argument market (did you mean marketplace?). It takes: productId, channel, marketplace, fields.')
  })

  it('catches a typo and a different spelling', () => {
    expect(unknownArgumentsProblem(publish, { prodcutId: 'p' })).toContain('prodcutId (did you mean productId?)')
    expect(unknownArgumentsProblem(publish, { product_id: 'p' })).toContain('product_id (did you mean productId?)')
  })

  it('gives no guess when nothing is close', () => {
    expect(unknownArgumentsProblem(publish, { colour: 'red' })).toContain('the argument colour. It takes:')
  })

  it('lets the tool\'s own arguments through', () => {
    expect(unknownArgumentsProblem(publish, { productId: 'p', channel: 'EBAY', marketplace: 'IT' })).toBeNull()
  })

  it('does not check an input that allows any key', () => {
    expect(argumentNames({ input: z.object({ a: z.string() }).loose() })).toBeNull()
    expect(unknownArgumentsProblem({ name: 'loose-tool', input: z.object({ a: z.string() }).loose() }, { b: 1 })).toBeNull()
  })
})

describe('argumentsRefusal', () => {
  const tools: Record<string, typeof publish> = { 'publish-listing': publish }
  const plan = { name: PLAN_TOOL, readOnly: false, input: z.object({ title: z.string(), steps: z.array(z.unknown()) }) }

  it('refuses Claude\'s call and says nothing was queued (or read)', () => {
    expect(argumentsRefusal(publish, { market: 'IT' }, (n) => tools[n])).toMatch(/did you mean marketplace\?\)\. It takes: .*\. Nothing was queued\.$/)
    expect(argumentsRefusal({ ...publish, readOnly: true }, { market: 'IT' }, (n) => tools[n])).toMatch(/Nothing was read\.$/)
  })

  it('checks each step of a change plan against its own tool', () => {
    const refusal = argumentsRefusal(plan, { title: 't', steps: [
      { tool: 'publish-listing', args: { productId: 'p', channel: 'EBAY', marketplace: 'IT' } },
      { tool: 'publish-listing', args: { productId: 'p', channel: 'EBAY', market: 'DE' } },
      { tool: 'no-such-tool', args: { anything: 1 } },
    ] }, (n) => tools[n])
    expect(refusal).toBe('step 2: publish-listing does not take the argument market (did you mean marketplace?). It takes: productId, channel, marketplace, fields. Nothing was queued.')
  })
})

describe('every registered tool', () => {
  it('can be checked: its input is a plain object', () => {
    expect(listTools().filter((tool) => argumentNames(tool) === null).map((tool) => tool.name)).toEqual([])
  })

  it('the real publish-listing refuses `market` and points to `marketplace`', () => {
    const tool = getTool('publish-listing')!
    expect(argumentsRefusal(tool, { productId: 'p', channel: 'EBAY', market: 'IT', fields: 'all' }, getTool)).toContain('market (did you mean marketplace?)')
  })
})
