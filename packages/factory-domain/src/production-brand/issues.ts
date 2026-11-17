/**
 * B-PR-15 (production plan schema wave 3/5; lead pick L24; review fixes R-42, R-43, R-44): the issues that need an answer,
 * pure — the lists the database's ProductionIssue mirrors (factory-db domain-mirrors keeps them equal). B-PR-43b adds the due
 * and answered rules and their words here, B-PR-45 the escalation steps (the clock itself is supervisor.ts escalationClock).
 *
 *   source   BRAND   the customer's "Report a problem" on one or many of its own orders (one portal message per order thread)
 *            OFFICE  the office's "Needs an answer" on a note (one internal note per picked record)
 *   status   OPEN → ANSWERED (a BRAND issue: the first shared office message in that order's thread after it was raised; an
 *            OFFICE issue: its task done) or CANCELLED; an OFFICE issue whose task reopens is OPEN again (R-42)
 *
 * One Task per batch (record = the first order; R-43): every issue of a batch names the batch's task, and answering closes
 * every issue of the batch. An issue is about a sales order or a work order of ONE customer; the customer reads only
 * "Waiting on us since <date>" / "Answered", never the issue, its task or who answers (R-41).
 */
export const ISSUE_SOURCES = ['BRAND', 'OFFICE'] as const
export type IssueSource = (typeof ISSUE_SOURCES)[number]

export const ISSUE_STATUSES = ['OPEN', 'ANSWERED', 'CANCELLED'] as const
export type IssueStatus = (typeof ISSUE_STATUSES)[number]

/** The records an issue may be about (ProductionIssue.recordType). */
export const ISSUE_RECORD_TYPES = ['SalesOrder', 'WorkOrder'] as const
export type IssueRecordType = (typeof ISSUE_RECORD_TYPES)[number]
