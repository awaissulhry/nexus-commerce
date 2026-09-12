import { emptyShopifyContent } from '../../../../../packages/shared/dist/shopify-content.js'
export const variants = [
 {id:'red-s',sku:'XV-RED-S',options:{Colour:'Red',Size:'S'},price:'199.00',stock:5},
 {id:'red-l',sku:'XV-RED-L',options:{Colour:'Red',Size:'L'},price:'209.00',stock:0},
 {id:'blue-s',sku:'XV-BLUE-S',options:{Colour:'Blue',Size:'S'},price:'189.00',stock:8},
 {id:'blue-l',sku:'XV-BLUE-L',options:{Colour:'Blue',Size:'L'},price:'219.00',stock:2},
]
export const draft = emptyShopifyContent(['Colour','Size'])
draft.assets = ['family','red-front','red-side','blue-front','blue-side','large-detail'].map((id,i)=>({id,url:`https://fixture.example/${id}.svg`,alt:['Family helmet overview','Red helmet — front','Red helmet — side','Blue helmet — front','Blue helmet — side','Large helmet detail'][i],translations:{it:['Casco della famiglia','Casco rosso — fronte','Casco rosso — lato','Casco blu — fronte','Casco blu — lato','Dettaglio casco grande'][i],en:['Family helmet overview','Red helmet — front','Red helmet — side','Blue helmet — front','Blue helmet — side','Large helmet detail'][i]}}))
draft.groups=[{id:'family',name:'Family overview',assetIds:['family'],featuredId:'family'},{id:'red',name:'Red · studio gallery',assetIds:['red-front','red-side'],featuredId:'red-front'},{id:'blue',name:'Blue · studio gallery',assetIds:['blue-front','blue-side'],featuredId:'blue-front'},{id:'detail',name:'Large size details',assetIds:['large-detail'],featuredId:'large-detail'}]
draft.fields=[{namespace:'custom',key:'fit_note',label:'Fit and materials',type:'multi_line_text_field',storefront:true}]
draft.assignments[0].gallery={mode:'replace',groupIds:['family'],featuredId:null}
draft.assignments[0].values={'custom.fit_note':{value:'Protezione e comfort per ogni viaggio.',translations:{en:'Protection and comfort for every ride.'}}}
for(const colour of ['Red','Blue']) draft.assignments.push({id:colour.toLowerCase(),name:`${colour} colour`,target:{kind:'options',values:{Colour:colour}},priority:0,gallery:{mode:'replace',groupIds:[colour.toLowerCase()],featuredId:null},values:{'custom.fit_note':{value:colour==='Red'?'Finitura rossa. Interni rimovibili.':'Finitura blu. Interni rimovibili.',translations:{en:`${colour} finish. Removable lining.`}}}})
draft.assignments.push({id:'blue-large',name:'Blue + large',target:{kind:'options',values:{Colour:'Blue',Size:'L'}},priority:0,gallery:{mode:'append',groupIds:['detail'],featuredId:'blue-front'},values:{'custom.fit_note':{value:'Blu, taglia L. Imbottitura extra inclusa.',translations:{en:'Blue, size L. Extra padding included.'}}}})
