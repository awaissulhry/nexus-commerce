import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer } from 'vite'
const root=fileURLToPath(new URL('.', import.meta.url)), repo=resolve(root, '../../../..')
const server=await createServer({configFile:false,root,resolve:{alias:[
 {find:'@/lib/auth/AuthProvider',replacement:root+'/auth.ts'},
 {find:'../contracts',replacement:root+'/contracts.ts'},
 {find:'@/lib/backend-url',replacement:root+'/backend.ts'},
 {find:'next/link',replacement:root+'/link.tsx'},
 {find:'@',replacement:repo+'/apps/web/src'},
 {find:'@nexus/shared',replacement:repo+'/packages/shared'},
 {find:'react-dom',replacement:repo+'/node_modules/react-dom'},
 {find:'react',replacement:repo+'/node_modules/react'},
 ]},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:3126,strictPort:true,fs:{allow:[root,repo]},proxy:{'/api':'http://127.0.0.1:4108'}},define:{'process.env.NODE_ENV':'"development"'}, optimizeDeps:{include:['react','react-dom/client']}})
await server.listen(); console.log('Isolated product transfer UI: http://127.0.0.1:3126')
