import { expect, it, vi } from 'vitest'
import { FAKE_KMS_KEY_ID } from '../test-support/fake-kms.js'
const construct = vi.fn()
vi.mock('pg', () => ({ Pool: class { constructor(...args: unknown[]) { construct(...args) } } }))
const { quarantineVerifyMain } = await import('./cx-quarantine-verify.js')
const { parseMaintenanceArguments } = await import('./cx-quarantine-operator.js')

// Each case is wrapped once: it.each spreads the outer row into test arguments.
it.each([[], ['--target-key-arn','alias/mutable'], ['--target-key-arn',FAKE_KMS_KEY_ID,'--max-rows','10001'],
  ['--target-key-arn',FAKE_KMS_KEY_ID,'--page-size','1'], ['--apply'], ['--apply','--target-key-arn',FAKE_KMS_KEY_ID],
  ['--target-key-arn',FAKE_KMS_KEY_ID,'--budget-seconds','59'], ['--target-key-arn',FAKE_KMS_KEY_ID,'--budget-seconds','1801'],
  ['--target-key-arn',FAKE_KMS_KEY_ID,'--budget-seconds','60.5']].map(args => [args]))('refuses unsupported/missing verification parameters before connecting: %j', async args => {
  await expect(quarantineVerifyMain(args, { CX_QUARANTINE_MAINTENANCE_DATABASE_URL: 'postgresql://synthetic.invalid' })).rejects.toMatchObject({ code: 'invalid_arguments' })
  expect(construct).not.toHaveBeenCalled()
})
it('accepts an explicit operator budget within its bounds', () => {
  expect(parseMaintenanceArguments(['--target-key-arn', FAKE_KMS_KEY_ID, '--budget-seconds', '1800', '--max-rows', '10000'], false))
    .toEqual({ targetKeyArn: FAKE_KMS_KEY_ID, budgetMs: 1_800_000, maxRows: 10_000 })
})
it('requires its dedicated operator connection, never the normal application URL', async () => {
  await expect(quarantineVerifyMain(['--target-key-arn',FAKE_KMS_KEY_ID], { DATABASE_URL: 'postgresql://synthetic.invalid' })).rejects.toThrow('Dedicated quarantine maintenance connection is required.')
  expect(construct).not.toHaveBeenCalled()
})
