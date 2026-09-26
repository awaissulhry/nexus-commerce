import { expect, it, vi } from 'vitest'
import { FAKE_KMS_KEY_ID } from '../test-support/fake-kms.js'
const construct = vi.fn()
vi.mock('pg', () => ({ Pool: class { constructor(...args: unknown[]) { construct(...args) } } }))
const { quarantineRewrapMain } = await import('./cx-quarantine-rewrap.js')

it.each([[['--target-key-arn', FAKE_KMS_KEY_ID]], [['--apply', '--apply', '--target-key-arn', FAKE_KMS_KEY_ID]], [['--apply']],
  [['--apply', '--target-key-arn', 'alias/mutable']], [['--apply', '--target-key-arn', FAKE_KMS_KEY_ID, '--max-rows', '10001']],
  [['--apply', '--target-key-arn', FAKE_KMS_KEY_ID, '--page-size', '1']], [['--apply', '--target-key-arn', FAKE_KMS_KEY_ID, '--dry-run', '1']], [['--apply', '--target-key-arn', FAKE_KMS_KEY_ID, '--budget-seconds', '1801']], [['--target-key-arn', FAKE_KMS_KEY_ID, '--apply=yes']]])(
  'refuses a missing acknowledgement or unsupported parameters before connecting: %j', async args => {
    await expect(quarantineRewrapMain(args, { CX_QUARANTINE_MAINTENANCE_DATABASE_URL: 'postgresql://synthetic.invalid' })).rejects.toMatchObject({ code: 'invalid_arguments' })
    expect(construct).not.toHaveBeenCalled()
  })
it('requires its dedicated operator connection, never the normal application URL', async () => {
  await expect(quarantineRewrapMain(['--apply', '--target-key-arn', FAKE_KMS_KEY_ID], { DATABASE_URL: 'postgresql://synthetic.invalid' }))
    .rejects.toThrow('Dedicated quarantine maintenance connection is required.')
  expect(construct).not.toHaveBeenCalled()
})
