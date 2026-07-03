import { describe, it, expect } from 'vitest'
import {
  canAdvanceReportTask,
  isReportTaskTerminal,
  isReportTaskOpen,
  pollOrder,
} from './report-task-pipeline.js'

describe('report task state machine', () => {
  it('follows the happy path PENDING → IN_PROGRESS → SUCCESS → INGESTED', () => {
    expect(canAdvanceReportTask('PENDING', 'IN_PROGRESS')).toBe(true)
    expect(canAdvanceReportTask('IN_PROGRESS', 'SUCCESS')).toBe(true)
    expect(canAdvanceReportTask('SUCCESS', 'INGESTED')).toBe(true)
  })
  it('allows fast channels to skip IN_PROGRESS', () => {
    expect(canAdvanceReportTask('PENDING', 'SUCCESS')).toBe(true)
  })
  it('allows download/parse failure after SUCCESS', () => {
    expect(canAdvanceReportTask('SUCCESS', 'FAILED')).toBe(true)
    expect(canAdvanceReportTask('SUCCESS', 'EXPIRED')).toBe(true)
  })
  it('terminal states never advance (retries are NEW tasks)', () => {
    for (const from of ['FAILED', 'EXPIRED', 'INGESTED'] as const) {
      for (const to of ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'INGESTED'] as const) {
        expect(canAdvanceReportTask(from, to)).toBe(false)
      }
    }
  })
  it('no self-transitions, no rewinds', () => {
    expect(canAdvanceReportTask('PENDING', 'PENDING')).toBe(false)
    expect(canAdvanceReportTask('SUCCESS', 'PENDING')).toBe(false)
    expect(canAdvanceReportTask('IN_PROGRESS', 'PENDING')).toBe(false)
  })
  it('classifies terminal and open correctly', () => {
    expect(isReportTaskTerminal('INGESTED')).toBe(true)
    expect(isReportTaskTerminal('FAILED')).toBe(true)
    expect(isReportTaskTerminal('EXPIRED')).toBe(true)
    expect(isReportTaskTerminal('SUCCESS')).toBe(false)
    expect(isReportTaskOpen('PENDING')).toBe(true)
    expect(isReportTaskOpen('IN_PROGRESS')).toBe(true)
    expect(isReportTaskOpen('SUCCESS')).toBe(false)
  })
})

describe('pollOrder fairness', () => {
  const d = (s: string) => new Date(s)
  it('never-polled first (oldest created first), then oldest-polled', () => {
    const tasks = [
      { id: 'c', lastPolledAt: d('2026-07-01T10:00:00Z'), createdAt: d('2026-07-01T08:00:00Z') },
      { id: 'a', lastPolledAt: null, createdAt: d('2026-07-01T09:00:00Z') },
      { id: 'd', lastPolledAt: d('2026-07-01T09:30:00Z'), createdAt: d('2026-07-01T07:00:00Z') },
      { id: 'b', lastPolledAt: null, createdAt: d('2026-07-01T09:30:00Z') },
    ]
    expect(pollOrder(tasks).map((t) => t.id)).toEqual(['a', 'b', 'd', 'c'])
  })
  it('does not mutate its input', () => {
    const tasks = [
      { id: 'x', lastPolledAt: d('2026-07-01T10:00:00Z'), createdAt: d('2026-07-01T08:00:00Z') },
      { id: 'y', lastPolledAt: null, createdAt: d('2026-07-01T09:00:00Z') },
    ]
    const before = tasks.map((t) => t.id)
    pollOrder(tasks)
    expect(tasks.map((t) => t.id)).toEqual(before)
  })
})
