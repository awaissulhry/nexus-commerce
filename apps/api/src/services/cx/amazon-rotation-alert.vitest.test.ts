import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { workspaceContext, withWorkspace } from '../../lib/workspace-context.js'
const m=vi.hoisted(()=>({notices:[] as any[],reads:[] as any[],events:[] as any[],emails:[] as any[],store:vi.fn(),gateway:vi.fn(),routes:[] as Array<{connectionId:string;workspaceId:string;channelType:string}>}))
vi.mock('@aws-sdk/client-sqs',()=>({
  DeleteMessageCommand:class{},ReceiveMessageCommand:class{},GetQueueAttributesCommand:class{},
  SQSClient:class{async send(){return {Attributes:{QueueArn:'arn:aws:sqs:eu-west-1:123456789012:unused',Policy:JSON.stringify({Statement:[{Effect:'Allow',Principal:{AWS:'arn:aws:iam::437568002678:root'},Action:['sqs:SendMessage','sqs:GetQueueAttributes'],Resource:'arn:aws:sqs:eu-west-1:123456789012:unused'}]})}}}},
}))
vi.mock('../../db.js',()=>({default:{
  channelAccountRoute:{findMany:async(q:any)=>{
    m.reads.push(q)
    const rows=m.routes.filter(r=>!q.where?.channelType||r.channelType===q.where.channelType)
    const start=q.cursor?rows.findIndex(r=>r.connectionId===q.cursor.connectionId)+(q.skip??0):0
    return rows.slice(start,start+q.take)
  }},
  workspaceMembership:{findMany:async(q:any)=>{
    expect(q.where).toMatchObject({workspaceId:workspaceContext()!.workspaceId,status:'active',user:{status:'active'},roles:{some:{role:{key:'OWNER'}}}})
    return [{userId:`owner-${q.where.workspaceId}`}]
  }},
  notification:{
    findFirst:async({where}:any)=>m.notices.find(n=>n.workspaceId===workspaceContext()?.workspaceId&&n.userId===where.userId&&n.type===where.type&&n.entityId===where.entityId)??null,
    create:async({data}:any)=>{const row={id:`n${m.notices.length}`,workspaceId:workspaceContext()!.workspaceId,...data};m.notices.push(row);return row},
  },
}}))
vi.mock('./apps.service.js',()=>({getChannelApp:async()=>({clientId:'fixture-app',clientSecret:'old-private-secret'}),storeClientSecret:m.store}))
vi.mock('./events.service.js',()=>({SYSTEM_ACTOR:{kind:'system'},CRON_ACTOR:{kind:'cron'},recordConnectionEvent:async(event:any)=>{m.events.push(event)}}))
vi.mock('../monitoring/alert.service.js',()=>({AlertType:{CONNECTION_HEALTH:'CONNECTION_HEALTH'},alertService:{createAlert:async(...args:any[])=>{m.emails.push(args)}}}))
vi.mock('../gateway/amazon-sdk.js',()=>({amazonGrantlessFetch:m.gateway}))
vi.mock('../../utils/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}))
const {handleAmazonCredentialMessage,requestAmazonSecretRotation}=await import('./amazon-secret-rotation.service.js')
beforeEach(()=>{
  m.notices=[];m.reads=[];m.events=[];m.emails=[];m.store.mockReset()
  m.routes=[
    {connectionId:'a1',workspaceId:'business-a',channelType:'AMAZON'},
    {connectionId:'a2',workspaceId:'business-a',channelType:'AMAZON'},
    {connectionId:'b1',workspaceId:'business-b',channelType:'AMAZON'},
    {connectionId:'c1',workspaceId:'etsy-only',channelType:'ETSY'},
  ]
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED','1');vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:401})))
  vi.stubEnv('AMAZON_APP_CREDENTIAL_QUEUE_URL','https://sqs.eu-west-1.amazonaws.com/123456789012/unused')
})
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})
const incoming=JSON.stringify({notificationType:'APPLICATION_OAUTH_CLIENT_NEW_SECRET',payload:{applicationOAuthClientNewSecret:{clientId:'fixture-app',newClientSecret:'new-private-secret'}}})
const fromPlatform=()=>withWorkspace({workspaceId:'nexus_legacy_workspace',actorUserId:'unrelated-actor',membershipId:null,roleKeys:[]},()=>handleAmazonCredentialMessage(incoming))
it('persists a rotation failure to the active owning profiles even from the platform legacy context',async()=>{
  expect(await fromPlatform()).toBe('test_failed')
  expect(m.notices.map(n=>[n.workspaceId,n.userId])).toEqual([['business-a','owner-business-a'],['business-b','owner-business-b']])
  expect(m.notices.every(n=>n.type==='channel-secret-rotation-failed'&&n.severity==='danger')).toBe(true)
  expect(JSON.stringify(m.notices)).not.toMatch(/new-private-secret|old-private-secret|fixture-app/)
  expect(m.reads[0]).toMatchObject({take:50,where:{channelType:'AMAZON',workspace:{status:'active'}}})
})
it('deduplicates both repeated profile routes and repeated failures on unread owner notices',async()=>{
  await fromPlatform();await fromPlatform()
  expect(m.notices).toHaveLength(2)
})
it('visits the next bounded page instead of losing owners beyond the first fifty routes',async()=>{
  m.routes=Array.from({length:51},(_,i)=>({connectionId:`route-${String(i).padStart(3,'0')}`,workspaceId:`business-${i}`,channelType:'AMAZON'}))
  await fromPlatform()
  expect(m.notices).toHaveLength(51)
  expect(m.reads).toHaveLength(2)
  expect(m.reads[1]).toMatchObject({cursor:{connectionId:'route-049'},skip:1,take:50})
})
it('does not persist or email a secret-bearing provider error',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({access_token:'fixture-token'}),{status:200})))
  m.gateway.mockResolvedValueOnce({status:403,text:async()=>'new-private-secret old-private-secret'})
  const result=await requestAmazonSecretRotation('test')
  expect(result.requested).toBe(false)
  expect(m.notices).toHaveLength(2)
  expect(JSON.stringify({result,notices:m.notices,events:m.events,emails:m.emails})).not.toMatch(/new-private-secret|old-private-secret/)
})
it('does not put a credential-store exception into the connection-event ledger',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({access_token:'fixture-token'}),{status:200})))
  m.store.mockRejectedValueOnce(new Error('Cannot save new-private-secret'))
  expect(await fromPlatform()).toBe('store_failed')
  expect(JSON.stringify({notices:m.notices,events:m.events,emails:m.emails})).not.toContain('new-private-secret')
})
