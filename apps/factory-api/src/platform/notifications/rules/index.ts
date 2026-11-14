import type { FanOutRule } from '../fan-out'
import { ALERT_RULES } from './alerts'
import { APPROVAL_RULES } from './approvals'
import { ASSIGNMENT_RULES } from './assignments'
import { THREAD_RULES } from './threads'
// B-W2a-35: machine requests to maintenance, jobs to their technician.
import { PLANT_RULES } from './plant'
// B-W2a-65: a safety complaint's alert to the owner and quality.
import { COMPLAINT_RULES } from './complaints'
// B-W2b-24: the restore drill's reminder (a RESTORE_DRILL_DUE timer fired: SYSTEM to the people who see Security & health).
import { RESTORE_DRILL_RULES } from '../../timers/restore-drill'
// B-W2b-35: a help call to the type's responder team (ALERT to its office members, or to the site's team leaders).
import { CALL_RULES } from '../../../modules/production/calls/notices'
// B-W2b-42: a working-time limit alert to the roles the limit names.
import { LIMIT_RULES } from '../../../modules/people/limits/notices'
// B-W2b-96: a machine request routed to a team or technician, and escalated to a person.
import { ROUTING_RULES } from '../../../modules/plant/requests/notices'
// B-W2b-118: a quality alert rule fired (ALERT to its audience; a test to the person who asked).
import { QUALITY_ALERT_RULES } from '../../../modules/quality/rules/notices'
// B-W2b-125: a new incident report to the safety roles; an INAIL filing's reminders before and at its 48-hour deadline.
import { INCIDENT_RULES } from '../../../modules/safety/incidents/notices'
// B-W2b-177: a document of a record stops being valid soon (SYSTEM to the record's owner and followers).
import { EXPIRY_RULES } from '../../files/expiry/notices'
// B-W2b-F17: the holder of a dead link with no renewer asked for a new one (SYSTEM to the person who made the link).
import { LINK_RULES } from '../../links/notices'
// B-W2b-226: change requests and change orders (PRD-175: who triages, the style's owner, approvers, the author, supervisors).
import { CHANGE_RULES } from '../../../modules/product/changes/notices'
// B-W2b-307: the approval engine's requests to their deciders and the decision to who asked; an SMV change to its approvers.
import { APPROVAL_TASK_NOTICES } from '../../../modules/insights/sources/approval-tasks'
import { SMV_CHANGE_NOTICES } from '../../../modules/insights/sources/smv-changes'
// B-W2b-385: following in depth (a followed saved view changed, a followed record's status moved) and the follow-ups NT1:01-03.
import { FOLLOWING_RULES } from '../view-follow/rules'
import { FOLLOW_UP_RULES } from './follow-ups'
// B-W2b-394: a team-inbox mail given to a person; its follow-up that came with no answer.
import { TEAM_INBOX_RULES } from '../../email-in/team-inbox/notify'
// B-W2b-398: a tracking problem raised on a shipment on its way (ALERT to the dispatch desk of its site).
import { TRACKING_PROBLEM_RULES } from '../../../modules/shipping/exceptions/notices'

/**
 * The fan-out's rules, one file per source (B-W2a-20: mentions and followed records, assignments, approvals). A step that
 * adds a source of notifications adds its file here, one line (a merge point): B-W2a-33 the alerts its rules raise
 * (category ALERT, the rule's recipients), B-W2a-23 a finished export (SYSTEM, its asker).
 */
export const FAN_OUT_RULES: readonly FanOutRule[] = Object.freeze([...THREAD_RULES, ...ASSIGNMENT_RULES, ...APPROVAL_RULES, ...PLANT_RULES,
  // B-W2a-33: the exception rules' alerts (ALERT to the rule's recipients; ASSIGNMENT to an alert's assignee).
  ...ALERT_RULES,
  // B-W2a-65: a safety complaint (ALERT to who acknowledges it and who follows complaints up).
  ...COMPLAINT_RULES,
  // B-W2b-24: the restore drill is due within 14 days (SYSTEM to the holders of security.view).
  ...RESTORE_DRILL_RULES,
  // B-W2b-35: a station called for help (ALERT to the responder team's office members).
  ...CALL_RULES,
  // B-W2b-42: a working-time limit alert (ALERT to the roles the limit names).
  ...LIMIT_RULES,
  // B-W2b-96: a machine request routed (ASSIGNMENT to the team's or technician's office accounts), escalated (ALERT).
  ...ROUTING_RULES,
  // B-W2b-118: a quality alert rule fired (ALERT to the rule's audience, or the person who tested it).
  ...QUALITY_ALERT_RULES,
  // B-W2b-125: a new incident report (ALERT to safety.incidents.manage); an INAIL filing's reminders (ALERT to safety.incidents.people).
  ...INCIDENT_RULES,
  // B-W2b-177: a document expires within 30, then 7 days (SYSTEM to who added it and the record's followers).
  ...EXPIRY_RULES,
  // B-W2b-F17: a dead link with no renewer asked for again (SYSTEM to who made the link, with the reader's note).
  ...LINK_RULES,
  // B-W2b-226: a change request raised or decided; a change order's approval asked or decided, its release (SYSTEM / APPROVAL).
  ...CHANGE_RULES,
  // B-W2b-307: approval.requested (APPROVAL to its deciders), approval.decided (APPROVAL to who asked), an SMV change proposed (APPROVAL to its approvers).
  ...APPROVAL_TASK_NOTICES,
  ...SMV_CHANGE_NOTICES,
  // B-W2b-385: notification.view_changed and the records' status moves (FOLLOWING to their followers); a request to buy answered
  // (to who asked), an inquiry given to a person, a product-safety report (ALERT to who assesses them).
  ...FOLLOWING_RULES,
  ...FOLLOW_UP_RULES,
  // B-W2b-394: a team-inbox mail given to a member (ASSIGNMENT, notifications.mail.assigned), its follow-up due (to its assignee or the members).
  ...TEAM_INBOX_RULES,
  // B-W2b-398: shipment.tracking_problem_raised (ALERT to who manages shipments at its site).
  ...TRACKING_PROBLEM_RULES])
