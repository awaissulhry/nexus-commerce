import type { Prisma } from '@nexus/factory-db'
import { dateOfDay, dayOfDate, defineCalendarSource, sourceOf, type SourceItem } from '../source'

/**
 * Training refreshers (B-W2b-120 reading factory-db TrainingRecord, B-W2b-87; the records are B-W2b-139's, the due lists
 * B-W2b-133's): for each person who works for the company now and each course, the record that stands (PASSED, not
 * corrected away, the newest) whose "valid until" falls in the window. Counted per course, site and day — no name on the
 * calendar: the people are on People › Skills. An RLS course is the RLS's yearly training (RLS_TRAINING). The course's own
 * legal basis (typed by the tenant) is the item's law; the refresher period is the course's, frozen on each record.
 */
export default defineCalendarSource({
  kind: 'TRAINING_REFRESHER',
  async read(client, _context, window, scope) {
    const standing = { result: 'PASSED', corrections: { none: {} }, employee: { AND: [scope.site as Prisma.EmployeeWhereInput, { status: 'ACTIVE' }] } } satisfies Prisma.TrainingRecordWhereInput
    const candidates = await client.trainingRecord.findMany({
      where: { ...standing, validUntil: { gte: dateOfDay(window.openFrom), lte: dateOfDay(window.to) } },
      take: 5000,
      select: { employeeId: true, courseId: true },
    })
    if (candidates.length === 0) return []
    // The newest standing record of each person and course decides: a newer one (a refresher done) takes the old one off.
    const records = await client.trainingRecord.findMany({
      where: { ...standing, employeeId: { in: [...new Set(candidates.map((row) => row.employeeId))] }, courseId: { in: [...new Set(candidates.map((row) => row.courseId))] } },
      orderBy: [{ completedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { employeeId: true, courseId: true, validUntil: true, companyId: true, employee: { select: { siteId: true } }, course: { select: { name: true, code: true, type: true, legalBasis: true } } },
    })
    const newest = new Map<string, (typeof records)[number]>()
    for (const record of records) if (!newest.has(`${record.employeeId}:${record.courseId}`)) newest.set(`${record.employeeId}:${record.courseId}`, record)
    const groups = new Map<string, { record: (typeof records)[number]; dueOn: string; count: number }>()
    for (const record of newest.values()) {
      if (!record.validUntil) continue
      const dueOn = dayOfDate(record.validUntil)
      if (dueOn < window.openFrom || dueOn > window.to) continue
      const key = `${record.courseId}:${record.companyId}:${record.employee.siteId}:${dueOn}`
      const group = groups.get(key)
      if (group) group.count += 1
      else groups.set(key, { record, dueOn, count: 1 })
    }
    return [...groups.entries()].map(([key, { record, dueOn, count }]): SourceItem => {
      const kind = record.course.type === 'RLS' ? 'RLS_TRAINING' : 'TRAINING_REFRESHER'
      return {
        key: `${kind}:${key}`,
        kind,
        recordType: null,
        recordId: null,
        companyId: record.companyId,
        siteId: record.employee.siteId,
        dueOn,
        count,
        params: { course: record.course.name, courseCode: record.course.code },
        ownerId: null,
        evidence: null,
        law: record.course.legalBasis.trim() || null,
        source: sourceOf('people.skills', 'SafetyCourse', record.courseId),
        editable: false,
      }
    })
  },
})
