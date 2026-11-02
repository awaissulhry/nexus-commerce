import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { PEOPLE, PREFIX } from '../../_shared/fixtures'
import { EMPLOYEE_PUBLICATIONS, EMPLOYEE_STATEMENTS, STATEMENT } from '../demo/fixtures'
import { EmployeePayView, type EmployeePayModel } from './view/EmployeePayView'

/** SCR-085-pay — Employee › Pay & piece rates, made-up figures; the tab of the employee record, for those with the right. */

const tab = (over: Partial<EmployeePayModel> = {}): EmployeePayModel => ({ prefix: PREFIX, employeeId: PEOPLE.giulia.id, right: true, rates: true, statements: { status: 'ready', value: EMPLOYEE_STATEMENTS }, publications: { status: 'ready', value: EMPLOYEE_PUBLICATIONS }, opened: null, ...over })

export const designScreen = defineDesignScreen<EmployeePayModel>({
  screen: 'SCR-085-pay',
  title: 'Employee › Pay & piece rates',
  view: EmployeePayView,
  cases: [
    { id: 'pay', label: 'Statements and rates read', model: tab(), note: 'The pieces open only on the person’s choice: each opening is recorded.' },
    { id: 'opened', label: 'A statement opened', model: tab({ opened: { status: 'ready', value: STATEMENT } }) },
    { id: 'empty', label: 'No statement, no rates', model: tab({ statements: { status: 'ready', value: { ...EMPLOYEE_STATEMENTS, statements: [] } }, publications: { status: 'ready', value: { ...EMPLOYEE_PUBLICATIONS, publications: [] } } }) },
    { id: 'no-permission', label: 'Pay figures hidden for your role', model: tab({ right: false, statements: null }) },
    { id: 'no-rates', label: 'Without either right', model: tab({ right: false, rates: false, statements: null, publications: null }) },
    { id: 'loading', label: 'Loading', model: tab({ statements: { status: 'loading' }, publications: { status: 'loading' } }) },
    { id: 'error', label: 'Reads failed', model: tab({ statements: { status: 'failed', problem: { key: 'problem.unavailable' } }, publications: { status: 'failed', problem: { key: 'problem.unavailable' } } }) },
  ],
})
