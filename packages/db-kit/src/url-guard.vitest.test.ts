import { describe, expect, it } from 'vitest'
import { describeUrlHost, isLoopbackHost, isLoopbackUrl } from './url-guard'

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each(['', '10.0.0.5', '128.0.0.1', '127.0.0.256', 'localhost.example.com', 'db.internal', '/tmp', '0.0.0.0', '::'])(
    'refuses %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false)
    },
  )
})

describe('isLoopbackUrl', () => {
  it.each([
    'postgresql://postgres@127.0.0.1:5442/factory_test',
    'postgresql://user:secret@localhost:5442/factory_w9_01?schema=public',
    'postgresql://postgres@[::1]:5442/factory_test',
    'redis://127.0.0.1:6389',
    'postgresql://postgres@127.0.0.1:5442/factory_test?host=127.0.0.1',
  ])('accepts %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true)
  })

  it.each([
    ['a remote host', 'postgresql://user:secret@db.example.com:5432/factory'],
    ['a look-alike name', 'postgresql://user@localhost.example.com/factory'],
    ['a host parameter that overrides the host', 'postgresql://user@127.0.0.1/factory?host=db.example.com'],
    ['a hostaddr parameter', 'postgresql://user@localhost/factory?hostaddr=10.1.2.3'],
    ['a socket path', 'postgresql://user@127.0.0.1/factory?host=%2Ftmp'],
    ['several hosts', 'postgresql://user@127.0.0.1,db.example.com/factory'],
    ['no host', 'postgresql:///factory'],
    ['an unreadable URL', 'not a url'],
    ['a remote Redis', 'rediss://default:secret@cache.example.com:6380'],
  ])('refuses %s', (_label, url) => {
    expect(isLoopbackUrl(url)).toBe(false)
  })
})

describe('describeUrlHost', () => {
  it('names host, port and database but never the credentials', () => {
    const text = describeUrlHost('postgresql://admin:hunter2@db.example.com:5432/factory')
    expect(text).toBe('db.example.com:5432/factory')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('admin')
  })

  it('says when a URL cannot be read', () => {
    expect(describeUrlHost('::::')).toBe('(unreadable URL)')
  })
})
