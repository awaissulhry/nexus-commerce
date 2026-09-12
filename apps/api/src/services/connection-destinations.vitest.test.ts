import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ channelConnection: { findMany: vi.fn(), findUnique: vi.fn() } }))
vi.mock('../db.js', () => ({ default: db }))
import { AmbiguousConnectionError, isPrimaryChannelConnection, NoConnectionError, primaryConnectionIds, resolveChannelConnectionId } from './connection-resolver.service.js'

const account = (id: string, primary = false, channel = 'EBAY') => ({ id, channelType: channel, isActive: true, isPrimary: primary })
beforeEach(() => vi.resetAllMocks())

describe('batched destination resolution', () => {
  it('keeps a disconnected draft destination explicitly unattributed', async () => {
    db.channelConnection.findMany.mockResolvedValue([])
    expect(await primaryConnectionIds(['EBAY'])).toEqual(new Map([['EBAY', null]]))
  })

  it.each([false, true])('refuses ambiguous accounts instead of creating an unattributed draft (both primary=%s)', async primary => {
    db.channelConnection.findMany.mockResolvedValue([account('a', primary), account('b', primary)])
    await expect(primaryConnectionIds(['EBAY'])).rejects.toBeInstanceOf(AmbiguousConnectionError)
  })

  it('resolves each requested channel once, independent of database order', async () => {
    db.channelConnection.findMany.mockResolvedValue([account('b'), account('a', true), account('amazon', false, 'AMAZON')])
    expect(await primaryConnectionIds(['EBAY', 'AMAZON', 'EBAY'])).toEqual(new Map([['EBAY', 'a'], ['AMAZON', 'amazon']]))
    expect(db.channelConnection.findMany).toHaveBeenCalledTimes(1)
  })

  it('does not read any accounts for a shared-only operation', async () => {
    expect(await primaryConnectionIds([])).toEqual(new Map())
    expect(db.channelConnection.findMany).not.toHaveBeenCalled()
  })

  it('does not treat a failed account query as a disconnected channel', async () => {
    db.channelConnection.findMany.mockRejectedValue(new Error('database unavailable'))
    await expect(primaryConnectionIds(['EBAY'])).rejects.toThrow('database unavailable')
  })
})

describe('explicit channel destinations', () => {
  it('keeps primary-only consumers closed for alternate or ambiguous accounts', async () => {
    db.channelConnection.findMany.mockResolvedValue([account('a', true), account('b')])
    expect(await isPrimaryChannelConnection('EBAY', 'a')).toBe(true)
    expect(await isPrimaryChannelConnection('EBAY', 'b')).toBe(false)
    db.channelConnection.findMany.mockResolvedValue([account('a'), account('b')])
    expect(await isPrimaryChannelConnection('EBAY', 'b')).toBe(false)
  })
  it('honors a named account without resolving any primary', async () => {
    db.channelConnection.findUnique.mockResolvedValue(account('b'))
    expect(await resolveChannelConnectionId('EBAY', 'b')).toBe('b')
    expect(db.channelConnection.findMany).not.toHaveBeenCalled()
  })

  it.each([null, { ...account('b'), isActive: false }, account('b', false, 'AMAZON')])('refuses a missing, inactive or cross-channel named account: %j', async row => {
    db.channelConnection.findUnique.mockResolvedValue(row)
    await expect(resolveChannelConnectionId('EBAY', 'b')).rejects.toBeInstanceOf(NoConnectionError)
    expect(db.channelConnection.findMany).not.toHaveBeenCalled()
  })

  it('preserves an already resolved null even if an account becomes connected', async () => {
    db.channelConnection.findMany.mockResolvedValue([account('new', true)])
    expect(await resolveChannelConnectionId('EBAY', null)).toBeNull()
    expect(db.channelConnection.findMany).not.toHaveBeenCalled()
  })
})
