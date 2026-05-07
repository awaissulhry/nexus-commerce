// CR.2 smoke: verifyCredentials in dryRun + real-mode behavior.
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })

const sendcloud = await import('/Users/awais/nexus-commerce/apps/api/src/services/sendcloud/client.ts')

// (1) dryRun (default): any creds should pass.
process.env.NEXUS_ENABLE_SENDCLOUD_REAL = 'false'
const dry = await sendcloud.verifyCredentials({ publicKey: 'pk_dry', privateKey: 'sk_dry' })
console.log('dryRun verify:', dry)

// (2) "real" mode but with empty creds: should fail with missing-creds reason.
process.env.NEXUS_ENABLE_SENDCLOUD_REAL = 'true'
const empty = await sendcloud.verifyCredentials({ publicKey: '', privateKey: '' })
console.log('empty creds verify:', empty)

// (3) real mode with garbage creds: hits Sendcloud, expects 401.
const bad = await sendcloud.verifyCredentials({ publicKey: 'fake_PK_does_not_exist', privateKey: 'fake_SK_does_not_exist' })
console.log('bad creds verify:', bad)

process.env.NEXUS_ENABLE_SENDCLOUD_REAL = 'false'
console.log('CR.2 smoke complete')
