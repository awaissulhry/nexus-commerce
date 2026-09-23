import prisma from '../../db.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { raiseChannelAlert } from './channel-alerts.service.js'

/** ChannelApp is shared. Notify each owning business explicitly, even from a platform job's legacy context. */
export async function raiseAmazonRotationAlert(title:string,body:string) {
  const seen=new Set<string>()
  let after:string|undefined
  const report={profiles:0,recipients:0,created:0,deduped:0}
  do {
    // The ingress index is the existing non-secret, cross-profile account index.
    const routes=await prisma.channelAccountRoute.findMany({
      where:{channelType:'AMAZON',workspace:{status:'active'}},
      select:{connectionId:true,workspaceId:true},
      orderBy:{connectionId:'asc'},take:50,
      ...(after?{cursor:{connectionId:after},skip:1}:{}),
    })
    for(const route of routes) {
      if(seen.has(route.workspaceId))continue
      seen.add(route.workspaceId)
      const result=await withWorkspace({workspaceId:route.workspaceId,actorUserId:null,membershipId:null,roleKeys:[]},()=>raiseChannelAlert({
        kind:'channel-secret-rotation-failed',severity:'danger',title,body,
        entityType:'ChannelApp',entityId:'AMAZON_SP:production',href:'/settings/channels?tab=diagnostics',
      }))
      report.profiles++;report.recipients+=result.recipients;report.created+=result.created;report.deduped+=result.deduped
    }
    after=routes.length===50?routes[routes.length-1].connectionId:undefined
  } while(after)
  return report
}
