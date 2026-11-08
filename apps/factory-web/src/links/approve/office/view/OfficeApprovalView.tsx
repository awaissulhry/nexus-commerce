'use client'

import { useState, type FormEvent } from 'react'
import { Clock3, KeyRound, ShieldAlert, UserX } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { CodeInput } from '@nexus/ui/components/CodeInput/index'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { LinkFrameView } from '../../../../shell/links/view/LinkFrameView'
import { signInFieldProblems, type OfficeApprovalViewModel } from '../model'
import '../../approve.css'

export type { OfficeApprovalViewModel } from '../model'

export interface OfficeApprovalActions {
  onSignIn?: (input: { company: string; email: string; password: string }) => void
  onCode?: (code: string) => void
  onCodeComplete?: (code: string) => void
  onRestart?: () => void
  onSignOut?: () => void
  onRetry?: () => void
}

/**
 * SCR-198-office — an office approval opened from its e-mail (PLT-089; design links.approve addr): in the link column,
 * the quick office sign-in (company, e-mail, password, then the code from the app when the person has two-factor), then
 * the approval opens on the office's own page (Home › Approvals' review) behind the person's grants and grains. The mail
 * approves nothing by itself; a forwarded mail opens nothing for another person. Every end says what to do next.
 */
export function OfficeApprovalView({ model, actions }: { model: OfficeApprovalViewModel; actions?: OfficeApprovalActions }) {
  return (
    <WithMessages namespaces={['link-approve']}>
      <OfficeApproval model={model} actions={actions} />
    </WithMessages>
  )
}

function OfficeApproval({ model, actions }: { model: OfficeApprovalViewModel; actions?: OfficeApprovalActions }) {
  const t = useT('link-approve')
  return (
    <LinkFrameView model={{ sender: null, title: t('office.title'), body: { kind: 'task' } }}>
      <Stage model={model} actions={actions} />
    </LinkFrameView>
  )
}

function Stage({ model, actions }: { model: OfficeApprovalViewModel; actions?: OfficeApprovalActions }) {
  const t = useT('link-approve')
  const ds = useDsWords()
  const stage = model.stage
  switch (stage.kind) {
    case 'checking':
    case 'opening':
      return (
        <p className="fw-ap-hint" role="status">
          <Spinner size={14} /> {t(stage.kind === 'checking' ? 'office.checking' : 'office.opening')}
        </p>
      )
    case 'sign-in':
      return <SignInForm model={model} actions={actions} />
    case 'code':
      return (
        <Card padded className="fw-ap-card">
          <h2 className="fw-ap-h2">{t('office.code.title')}</h2>
          <p className="fw-ap-hint">{t('office.code.body', { email: model.email })}</p>
          <div className="fw-ap-signin">
            <CodeInput
              value={model.code}
              onChange={(code) => actions?.onCode?.(code)}
              onComplete={(code) => actions?.onCodeComplete?.(code)}
              label={t('office.code.label')}
              hint={t('office.code.hint')}
              error={model.problem ? t(`office.problem.${model.problem}`) : null}
              busy={model.busy}
              autoFocus
              labels={ds.codeInput}
            />
            <div className="fw-ap-signin-actions">
              <Button variant="quiet" onClick={() => actions?.onRestart?.()}>
                {t('office.code.back')}
              </Button>
              <Button variant="quiet" asChild>
                <a href="/sign-in">{t('office.code.recovery')}</a>
              </Button>
            </div>
          </div>
        </Card>
      )
    case 'open':
      return <EndState tone="info" title={t('office.open.title', { label: stage.label })} body={t('office.open.body')} actions={[{ label: t('office.open.go'), href: stage.href, variant: 'primary' }]} labels={ds.endState} />
    case 'decided':
      return <EndState tone="neutral" icon={<Clock3 size={28} aria-hidden />} title={t('office.decided.title')} body={t('office.decided.body', { label: stage.label })} actions={[{ label: t('office.decided.go'), href: stage.href, variant: 'primary' }]} labels={ds.endState} />
    case 'not-valid':
      return (
        <EndState
          tone="danger"
          icon={<UserX size={28} aria-hidden />}
          title={t('office.notValid.title')}
          body={t('office.notValid.body')}
          actions={[...(stage.home ? [{ label: t('office.notValid.home'), href: stage.home, variant: 'primary' as const }] : []), { label: t('office.notValid.switch'), onClick: () => actions?.onSignOut?.() }]}
          labels={ds.endState}
        />
      )
    case 'missing':
      return <EndState tone="warning" title={t('office.missing.title')} body={t('office.missing.body')} actions={[{ label: t('office.missing.go'), href: '/sign-in' }]} labels={ds.endState} />
    case 'change-password':
      return <EndState tone="warning" icon={<KeyRound size={28} aria-hidden />} title={t('office.change.title')} body={t('office.change.body')} actions={[{ label: t('office.change.go'), href: '/sign-in', variant: 'primary' }]} labels={ds.endState} />
    case 'setup-2fa':
      return <EndState tone="warning" icon={<ShieldAlert size={28} aria-hidden />} title={t('office.setup.title')} body={t('office.setup.body')} actions={[{ label: t('office.setup.go'), href: stage.href, variant: 'primary' }]} labels={ds.endState} />
    case 'error':
      return (
        <Banner
          tone="danger"
          title={t('office.error.title')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('retry')}
            </Button>
          }
        >
          {t('office.error.body')}
        </Banner>
      )
  }
}

function SignInForm({ model, actions }: { model: OfficeApprovalViewModel; actions?: OfficeApprovalActions }) {
  const t = useT('link-approve')
  const [company, setCompany] = useState(model.company)
  const [email, setEmail] = useState(model.email)
  const [password, setPassword] = useState('')
  const [tried, setTried] = useState(false)
  const problems = signInFieldProblems({ company, email, password })
  const shown = tried ? problems : {}
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (model.busy) return
    setTried(true)
    const first = (['company', 'email', 'password'] as const).find((field) => problems[field])
    if (first) {
      document.getElementById(`fw-ap-signin-${first}`)?.focus()
      return
    }
    actions?.onSignIn?.({ company, email, password })
  }
  return (
    <Card padded className="fw-ap-card">
      <h2 className="fw-ap-h2">{t('office.signIn.title')}</h2>
      <p className="fw-ap-hint">{t('office.signIn.body')}</p>
      <form className="fw-ap-signin" noValidate onSubmit={submit} aria-busy={model.busy || undefined}>
        {model.problem && <Banner tone="danger" title={t(`office.problem.${model.problem}`)} />}
        <Field label={t('office.signIn.company')} hint={t('office.signIn.companyHint')} error={shown.company ? t(shown.company) : undefined} required>
          <Input id="fw-ap-signin-company" value={company} onChange={(event) => setCompany(event.target.value)} autoComplete="organization" autoCapitalize="off" spellCheck={false} />
        </Field>
        <Field label={t('office.signIn.email')} error={shown.email ? t(shown.email) : undefined} required>
          <Input id="fw-ap-signin-email" type="email" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} />
        </Field>
        <Field label={t('office.signIn.password')} error={shown.password ? t(shown.password) : undefined} required>
          <Input id="fw-ap-signin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </Field>
        <div className="fw-ap-signin-actions">
          <Button type="submit" variant="primary" heldReason={model.busy ? t('office.signIn.busy') : null}>
            {t('office.signIn.go')}
          </Button>
          <Button variant="quiet" asChild>
            <a href="/forgot-password">{t('office.signIn.forgot')}</a>
          </Button>
        </div>
      </form>
    </Card>
  )
}
