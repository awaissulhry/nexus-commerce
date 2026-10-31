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
  ...RESTORE_DRILL_RULES])
