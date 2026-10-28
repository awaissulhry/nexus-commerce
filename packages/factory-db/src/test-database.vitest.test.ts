import { describe, expect, it } from 'vitest'
import { assertTestDatabaseUrl, checkTestDatabaseUrl, readWorktree, worktreeDatabaseNames } from './test-database'

const names = worktreeDatabaseNames({ branch: 'chore/example-branch', folder: 'w9-01-example-step' })

describe('worktreeDatabaseNames', () => {
  it('names the branch, the folder and the step id of the folder', () => {
    expect(names).toEqual(['factory_chore_example_branch', 'factory_w9_01_example_step', 'factory_w9_01'])
  })

  it('ignores a detached HEAD and missing parts', () => {
    expect(worktreeDatabaseNames({ branch: 'HEAD' })).toEqual([])
    expect(worktreeDatabaseNames({})).toEqual([])
  })
})

describe('checkTestDatabaseUrl', () => {
  it.each([
    'postgresql://postgres@127.0.0.1:5442/factory_test',
    'postgresql://postgres@127.0.0.1:5442/factory_test_a1b2',
    'postgresql://postgres@localhost:5442/factory_w9_01',
    'postgresql://postgres@127.0.0.1:5442/factory_w9-01',
    'postgresql://postgres@127.0.0.1:5442/factory_chore_example_branch',
  ])('accepts %s', (url) => {
    expect(checkTestDatabaseUrl(url, names).ok).toBe(true)
  })

  it.each([
    ['no URL', undefined, 'not set'],
    ['a remote host', 'postgresql://u:secret@db.example.com:5432/factory_test', 'not a database on this machine'],
    ['a host parameter pointing away', 'postgresql://u@127.0.0.1/factory_test?host=db.example.com', 'loopback only'],
    ['another worktree', 'postgresql://postgres@127.0.0.1:5442/factory_w9_02', 'not a test or worktree database'],
    ['a shared name', 'postgresql://postgres@127.0.0.1:5442/factory', 'not a test or worktree database'],
    ['the server database', 'postgresql://postgres@127.0.0.1:5442/postgres', 'not a test or worktree database'],
    ['a Commerce database', 'postgresql://postgres@127.0.0.1:5432/nexus_development', 'not a test or worktree database'],
  ])('refuses %s', (_label, url, reason) => {
    const result = checkTestDatabaseUrl(url, names)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain(reason)
      expect(result.reason).not.toContain('secret')
    }
  })
})

describe('assertTestDatabaseUrl', () => {
  it('returns the database name or throws the reason', () => {
    expect(assertTestDatabaseUrl('postgresql://postgres@127.0.0.1:5442/factory_test', [])).toBe('factory_test')
    expect(() => assertTestDatabaseUrl('postgresql://postgres@127.0.0.1:5442/factory_w9_01', [])).toThrow(
      /Factory tests refused to start: database "factory_w9_01"/,
    )
  })
})

describe('readWorktree', () => {
  it('reads the branch and folder of this checkout', () => {
    const worktree = readWorktree(process.cwd())
    expect(typeof worktree.folder).toBe('string')
  })
})
