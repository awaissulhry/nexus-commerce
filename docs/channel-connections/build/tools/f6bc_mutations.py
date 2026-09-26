import subprocess, sys, hashlib, json
ROOT='/private/tmp/nexus-channel-connections-20260922'; API=ROOT+'/apps/api'
V='apps/api/src/services/cx/ingress/ebay-quarantine-verification.ts'
S='apps/api/src/services/cx/ingress/quarantine-snapshot.ts'
X='apps/api/src/services/cx/ingress/ebay-quarantine-crypto.ts'
W='apps/api/src/services/cx/ingress/ebay-quarantine-rewrap.ts'
O='apps/api/src/scripts/cx-quarantine-operator.ts'
M='packages/database/prisma/migrations/20260923h_cx_quarantine_verification/migration.sql'
UNIT=['src/services/cx/ingress/ebay-quarantine-verification.vitest.test.ts','src/scripts/cx-quarantine-verify.vitest.test.ts','src/services/cx/ingress/ebay-quarantine-rewrap.vitest.test.ts','src/scripts/cx-quarantine-rewrap.vitest.test.ts']
PGV='[{"name":"verification","file":"src/services/cx/ingress/ebay-quarantine-verification-postgres.vitest.test.ts","expect":12}]'
PGW='[{"name":"rewrap","file":"src/services/cx/ingress/ebay-quarantine-rewrap-postgres.vitest.test.ts","expect":7}]'
muts=[
 # C11f6b verify
 ('v-warm-cache',V,[("bypassKmsCache: true, signal })","bypassKmsCache: false, signal })")],'unit'),
 ('v-fingerprint-without-cipher',V,[("row.payloadDigest, row.cipherDigest, row.proofDigest])","row.payloadDigest, row.proofDigest])")],'unit'),
 ('v-batch-validation',V,[("  })) return null","  }) && false) return null")],'unit'),
 ('v-batch-fingerprint-only',V,[("return !row || fingerprint(row) !== fingerprint(entry) || !row.payloadEnc","return !row || !row.payloadEnc")],'unit'),
 ('v-final-comparison',V,[("    if (!report.unchangedObservedState) report.incompleteReason = 'state_changed'","    report.unchangedObservedState = true\n    if (!report.unchangedObservedState) report.incompleteReason = 'state_changed'")],'unit'),
 ('v-finish-downgrade',V,[("    if (report.complete && now >= deadline) {","    if (report.complete && now >= deadline && false) {")],'unit'),
 ('v-record-deadline',V,[("          if (timer.signal.aborted || performance.now() >= recordDeadline) { report.incompleteReason = 'time_limit'; return finish() }\n          if (options.signal?.aborted) { report.incompleteReason = 'cancelled'; return finish() }\n          report.verified++","          if (options.signal?.aborted) { report.incompleteReason = 'cancelled'; return finish() }\n          report.verified++")],'unit'),
 ('v-authority-code',V,[("=== '42501' ? 'authority_denied'","=== 'never' ? 'authority_denied'")],'unit'),
 ('v-all-opened-and-stepping',V,[("    else if (report.failed || report.verified !== expected.length) report.incompleteReason","    else if (report.failed) report.incompleteReason"),("    for (let offset = 0; offset < expected.length; offset += 5) {","    for (let offset = 0; offset < expected.length; offset += 6) {")],'unit'),
 ('v-operator-signal',V,[("        const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal\n        try {\n          const body","        const signal = timer.signal\n        try {\n          const body")],'unit'),
 ('v-failure-class',V,[("error.reason === 'integrity' ? 'integrity' : 'access'","false ? 'integrity' : 'access'")],'unit'),
 ('v-budget-ignored',V,[("return { started, deadline: started + budgetMs, cryptoDeadline: started + budgetMs - 10_000 }","return { started, deadline: started + 60_000, cryptoDeadline: started + 50_000 }")],'unit'),
 ('s-snapshot-left-open',S,[("    await client.query('COMMIT')\n","")],'unit'),
 ('s-custodian-role',S,[("role === 'nexus_ebay_quarantine_custodian' ? role : 'nexus_ebay_quarantine_maintenance'","'nexus_ebay_quarantine_maintenance'")],'unit'),
 ('o-application-url',O,[("const connectionString = env.CX_QUARANTINE_MAINTENANCE_DATABASE_URL","const connectionString = env.CX_QUARANTINE_MAINTENANCE_DATABASE_URL ?? env.DATABASE_URL")],'unit'),
 ('o-apply-optional',O,[("    if (rest.filter(arg => arg === '--apply').length !== 1) throw","    if (rest.filter(arg => arg === '--apply').length > 1) throw")],'unit'),
 ('o-budget-bounds',O,[("n >= 60 && n <= 1_800","n >= 1")],'unit'),
 ('x-access-class-pg',X,[("error.code === 'kms_unavailable') ? 'access' : 'integrity'","error.code === 'kms_unavailable') ? 'integrity' : 'integrity'")],'pgv'),
 ('sql-rejected-bodies',M,[('FROM public."EbayNoticeQuarantine" q WHERE q.id=ANY(notice_ids) AND q."signatureOk"=true ORDER BY q.id;','FROM public."EbayNoticeQuarantine" q WHERE q.id=ANY(notice_ids) ORDER BY q.id;')],'pgv'),
 ('sql-runtime-grant',M,[("GRANT EXECUTE ON FUNCTION public.nexus_ebay_quarantine_cipher_batch(text[]) TO nexus_ebay_quarantine_custodian;","GRANT EXECUTE ON FUNCTION public.nexus_ebay_quarantine_cipher_batch(text[]) TO nexus_ebay_quarantine_custodian;\nGRANT EXECUTE ON FUNCTION public.nexus_ebay_quarantine_manifest(text,integer),public.nexus_ebay_quarantine_cipher_batch(text[]) TO nexus_workspace_runtime;")],'pgv'),
 ('sql-size-bound',M,[("  IF EXISTS (SELECT 1 FROM public.\"EbayNoticeQuarantine\" q WHERE q.id=ANY(notice_ids) AND q.\"signatureOk\"=true AND octet_length(q.\"payloadEnc\")>3145728) THEN","  IF false THEN")],'pgv'),
 ('sql-metadata-reads-bodies',M,[("GRANT EXECUTE ON FUNCTION public.nexus_ebay_quarantine_cipher_batch(text[]) TO nexus_ebay_quarantine_custodian;","GRANT EXECUTE ON FUNCTION public.nexus_ebay_quarantine_cipher_batch(text[]) TO nexus_ebay_quarantine_custodian, nexus_ebay_quarantine_maintenance;")],'pgv'),
 # C11f6c rewrap
 ('w-transport-as-failure',W,[("    if (state === null && !(error instanceof QuarantineDeadlineError)) return 'unknown'\n","")],'unit'),
 ('w-unproven-rollback',W,[("    try { await client.query('ROLLBACK') } catch { return 'unknown' }","    await client.query('ROLLBACK').catch(() => {})")],'unit'),
 ('w-commit-noop',W,[("    if (changed !== true) {\n      await client.query('ROLLBACK').catch(() => { throw new UnknownRollback() })\n      return 'contended'\n    }\n","")],'unit'),
 ('w-late-replacement-stored',W,[("        if (timer.signal.aborted || performance.now() >= recordDeadline) { report.incompleteReason = 'time_limit'; return finish() }\n        if (options.signal?.aborted) { report.incompleteReason = 'cancelled'; return finish() }\n        writesAttempted = true","        writesAttempted = true")],'unit'),
 ('w-transaction-across-kms',W,[("          replacement = await reencryptEbayQuarantine(","          await client.query('BEGIN'); replacement = await reencryptEbayQuarantine(")],'unit'),
 ('w-transaction-across-kms-pg',W,[("          replacement = await reencryptEbayQuarantine(","          await client.query('BEGIN'); replacement = await reencryptEbayQuarantine(")],'pgw'),
 ('w-rewrap-at-target',W,[("filter(row => row.signatureOk && row.payloadKeyId !== options.targetKeyArn)\n    report.candidates","filter(row => row.signatureOk)\n    report.candidates")],'unit'),
 ('w-rewrap-at-target-pg',W,[("filter(row => row.signatureOk && row.payloadKeyId !== options.targetKeyArn)\n    report.candidates","filter(row => row.signatureOk)\n    report.candidates")],'pgw'),
 ('w-final-state-ignored',W,[("    else if (report.remainingOffTarget) report.incompleteReason = 'off_target_remaining'\n","")],'unit'),
 ('w-failures-ignored',W,[("    if (report.failed) report.incompleteReason = 'rewrap_failed'\n    else if","    if (false) report.incompleteReason = 'rewrap_failed'\n    else if")],'unit'),
 ('w-cas-expected-key',W,[("[row.id, row.payloadEnc, row.payloadKeyId, row.payloadDigest, replacement.blob","[row.id, row.payloadEnc, replacement.keyId, row.payloadDigest, replacement.blob")],'unit'),
 ('w-unbounded-cas',W,[("    const changed = (await boundedQuarantineQuery<{ changed: boolean }>(client,","    const changed = (await (async (c: Client, sql: string, v: unknown[], _d: number) => c.query<{ changed: boolean }>(sql, v))(client,")],'unit'),
 ('w-operation-per-row',W,[("const outcome = await compareAndSwap(client, row, replacement, operationId, deadline)","const outcome = await compareAndSwap(client, row, replacement, randomUUID(), deadline)")],'unit'),
 ('w-report-after-writes',W,[("    if (writesAttempted) { report.incompleteReason = denied ? 'authority_denied' : 'database_unavailable'; return finish() }\n","")],'unit'),
 ('w-lock-timeout-as-failure',W,[("    if (state === '55P03') return 'contended' // lock_timeout: another writer holds the row\n","")],'unit'),
 ('w-single-run-lock',W,[("    if (!locked) throw new QuarantineRewrapError('rewrap_in_progress')\n","")],'unit'),
 ('w-single-run-lock-pg',W,[("    if (!locked) throw new QuarantineRewrapError('rewrap_in_progress')\n","")],'pgw'),
 ('w-operator-signal',W,[("        const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal\n        let replacement","        const signal = timer.signal\n        let replacement")],'unit'),
 ('w-no-lock-timeout-pg',W,[("    await client.query(\"SET LOCAL lock_timeout='5s'\")\n","")],'pgw'),
]
only=sys.argv[1:]; results=[]
for name,path,reps,kind in muts:
  if only and name not in only: continue
  full=ROOT+'/'+path; orig=open(full).read(); h=hashlib.sha256(orig.encode()).hexdigest(); mut=orig
  for a,b in reps:
    assert mut.count(a)==1,(name,a[:60],mut.count(a)); mut=mut.replace(a,b)
  open(full,'w').write(mut)
  try:
    if kind=='unit': r=subprocess.run(['npx','vitest','run',*UNIT],cwd=API,capture_output=True,text=True,timeout=300)
    else: r=subprocess.run(['node','scripts/run-real-postgres-tests.mjs','--suites',PGV if kind=='pgv' else PGW],cwd=ROOT,capture_output=True,text=True,timeout=900)
    out=r.stdout+r.stderr
    open(f'/private/tmp/cx-completion-20260922/c11-f6bc-mutation-{name}.log','w').write(out)
    failing=[l.strip()[:150] for l in out.splitlines() if ('FAIL' in l and '>' in l) or 'FAILED TEST' in l][:3]
    killed=r.returncode!=0 and ('AssertionError' in out or 'FAILED TEST' in out)
  finally: open(full,'w').write(orig)
  assert hashlib.sha256(open(full).read().encode()).hexdigest()==h
  results.append({'mutation':name,'kind':kind,'exit':r.returncode,'killed':killed,'failing':failing}); print(json.dumps(results[-1]),flush=True)
open('/private/tmp/cx-completion-20260922/c11-f6bc-mutations-final.json','w').write(json.dumps(results,indent=1))
