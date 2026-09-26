import { expect, it, vi } from 'vitest'
const construct = vi.fn()
vi.mock('pg', () => ({ Pool: class { constructor(...args: unknown[]) { construct(...args) } } }))
const { parseInventoryArguments, quarantineInventoryMain } = await import('./cx-quarantine-inventory.js')

it('has bounded defaults and accepts explicit safe inventory controls', () => {
  expect(parseInventoryArguments([])).toEqual({})
  expect(parseInventoryArguments(['--max-rows', '100', '--page-size', '20'])).toEqual({ maxRows: 100, pageSize: 20 })
})
it.each([['--apply'], ['--max-rows'], ['--max-rows','1','--max-rows','2'], ['--page-size','0'],
  ['--max-rows','1.5'], ['--max-rows','100001'], ['--page-size','101'], ['--target-key-arn','alias/mutable']])('rejects unsupported/invalid invocation %j', args => {
  expect(() => parseInventoryArguments(args)).toThrow()
})
it('never falls back to the ordinary application DATABASE_URL or constructs its pool', async () => {
  await expect(quarantineInventoryMain([], { DATABASE_URL: 'postgresql://synthetic.invalid/application' })).rejects.toThrow('Dedicated quarantine maintenance connection is required.')
  expect(construct).not.toHaveBeenCalled()
})
