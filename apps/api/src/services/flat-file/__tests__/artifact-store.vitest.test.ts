/**
 * FF1.9 — ArtifactStore tests (TDD — written before implementation)
 *
 * Tests FsArtifactStore round-trip and getArtifactStore() factory.
 * S3ArtifactStore is intentionally NOT tested against a real bucket (no network in CI).
 */
import { describe, it, expect, afterAll } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import { FsArtifactStore, getArtifactStore } from '../artifact-store'

// Fixed-suffix temp dir — must NOT use Date.now/random per task constraints
const TEST_DIR = path.join(os.tmpdir(), 'ff-artifact-test-static01')

describe('FsArtifactStore', () => {
  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
  })

  it('round-trips: put then get returns the same bytes', async () => {
    const store = new FsArtifactStore(TEST_DIR)
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x01, 0x02])
    const handle = await store.put(
      'exp-1.xlsx',
      bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(handle).toMatch(/^local:/)
    const result = await store.get(handle)
    expect(result).not.toBeNull()
    expect(result).toEqual(bytes)
  })

  it('creates baseDir if it does not exist', async () => {
    const subDir = path.join(os.tmpdir(), 'ff-artifact-test-static01-sub')
    const store = new FsArtifactStore(subDir)
    await store.put('sub.bin', new Uint8Array([42]), 'application/octet-stream')
    const stat = await fs.stat(subDir)
    expect(stat.isDirectory()).toBe(true)
    await fs.rm(subDir, { recursive: true, force: true })
  })

  it('returns null for an unknown handle', async () => {
    const store = new FsArtifactStore(TEST_DIR)
    const result = await store.get('local:does-not-exist.xlsx')
    expect(result).toBeNull()
  })

  it('sanitizes keys with special characters (slashes, spaces)', async () => {
    const store = new FsArtifactStore(TEST_DIR)
    const bytes = new Uint8Array([99])
    const handle = await store.put('path/to/export file.xlsx', bytes, 'application/octet-stream')
    expect(handle).toMatch(/^local:/)
    const relpath = handle.slice('local:'.length)
    expect(relpath).not.toContain('/')
    expect(relpath).not.toContain(' ')
    // Verify the stored bytes are still retrievable
    const result = await store.get(handle)
    expect(result).toEqual(bytes)
  })

  it('round-trips large bytes (>1 MB)', async () => {
    const store = new FsArtifactStore(TEST_DIR)
    const large = new Uint8Array(1_200_000)
    for (let i = 0; i < large.length; i++) {
      large[i] = i % 256
    }
    const handle = await store.put('large-export.xlsx', large, 'application/octet-stream')
    const result = await store.get(handle)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(large.length)
    expect(result![0]).toBe(0)
    expect(result![255]).toBe(255)
    expect(result![256]).toBe(0)
  })
})

describe('getArtifactStore', () => {
  it('returns FsArtifactStore when STORAGE_PROVIDER is not set', () => {
    const original = process.env.STORAGE_PROVIDER
    delete process.env.STORAGE_PROVIDER
    const store = getArtifactStore()
    if (original !== undefined) {
      process.env.STORAGE_PROVIDER = original
    }
    expect(store).toBeInstanceOf(FsArtifactStore)
  })

  it('returns FsArtifactStore when STORAGE_PROVIDER=LOCAL', () => {
    const original = process.env.STORAGE_PROVIDER
    process.env.STORAGE_PROVIDER = 'LOCAL'
    const store = getArtifactStore()
    if (original !== undefined) {
      process.env.STORAGE_PROVIDER = original
    } else {
      delete process.env.STORAGE_PROVIDER
    }
    expect(store).toBeInstanceOf(FsArtifactStore)
  })
})
