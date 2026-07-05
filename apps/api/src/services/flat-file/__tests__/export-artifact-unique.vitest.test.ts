/**
 * C2 — Artifact-key uniqueness tests.
 *
 * Verifies that FsArtifactStore correctly isolates artifacts stored under
 * distinct keys, and that two puts with the SAME key overwrite (documenting
 * why ExportWizardService must key on job.id, not job.jobName).
 */
import { describe, it, expect, afterAll } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import { FsArtifactStore } from '../artifact-store.js'

// Fixed-suffix temp dir so tests are reproducible and never collide with the
// main artifact-store test suite (which uses a different suffix).
const TEST_DIR = path.join(os.tmpdir(), 'ff-artifact-unique-c2-static01')

describe('FsArtifactStore — key uniqueness', () => {
  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
  })

  it('distinct keys return their own bytes independently', async () => {
    const store = new FsArtifactStore(TEST_DIR)
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

    const bytesA = new Uint8Array([0xAA, 0xBB, 0xCC])
    const bytesB = new Uint8Array([0x11, 0x22, 0x33])

    const handleA = await store.put('job1.xlsx', bytesA, mime)
    const handleB = await store.put('job2.xlsx', bytesB, mime)

    const gotA = await store.get(handleA)
    const gotB = await store.get(handleB)

    expect(gotA).not.toBeNull()
    expect(gotB).not.toBeNull()
    expect(gotA).toEqual(bytesA)
    expect(gotB).toEqual(bytesB)
    // Explicitly confirm they are different
    expect(gotA).not.toEqual(gotB)
  })

  it('second put with the SAME key overwrites the first (documents why unique keys matter)', async () => {
    const store = new FsArtifactStore(TEST_DIR)
    const mime = 'application/octet-stream'

    const first = new Uint8Array([0x01, 0x02, 0x03])
    const second = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD])

    const handle1 = await store.put('same-name-export.xlsx', first, mime)
    const handle2 = await store.put('same-name-export.xlsx', second, mime)

    // Both handles point to the same underlying file
    expect(handle1).toBe(handle2)

    // Only the second bytes survive
    const result = await store.get(handle1)
    expect(result).not.toBeNull()
    expect(result).toEqual(second)
    expect(result).not.toEqual(first)
  })
})
