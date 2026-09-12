import { beforeEach, expect, it, vi } from 'vitest'
const m=vi.hoisted(()=>({db:{$executeRaw:vi.fn(),category:{count:vi.fn()},product:{updateMany:vi.fn()},productCategory:{deleteMany:vi.fn(),createMany:vi.fn(),findMany:vi.fn(),update:vi.fn()}},emit:vi.fn(),notify:vi.fn()}))
vi.mock('../../db.js',()=>({default:m.db}))
vi.mock('../product-event.service.js',()=>({productEventService:{emitTx:m.emit,notifyCommitted:m.notify}}))
import { CategoryTreeService } from '../category-tree.service.js'
const service=new CategoryTreeService(m.db as never)
beforeEach(()=>{vi.resetAllMocks();m.db.category.count.mockResolvedValue(2);m.db.product.updateMany.mockResolvedValue({count:1})})
it('stores one primary membership, bumps the product revision and records the event in the same transaction',async()=>{
 await service.assign('product',['a','b','a'],{primaryId:'b'})
 expect(m.db.product.updateMany).toHaveBeenCalledWith({where:{id:'product',deletedAt:null},data:{version:{increment:1}}})
 expect(m.db.productCategory.createMany).toHaveBeenCalledWith({data:[{productId:'product',categoryId:'a',isPrimary:false},{productId:'product',categoryId:'b',isPrimary:true}]})
 expect(m.emit.mock.calls[0][0]).toBe(m.db)
 expect(m.notify).not.toHaveBeenCalled() // transaction owner notifies only after commit
})
it('refuses a primary category outside the selected set or an unavailable product before replacing memberships',async()=>{
 await expect(service.assign('product',['a','b'],{primaryId:'c'})).rejects.toThrow('primary category')
 m.db.product.updateMany.mockResolvedValue({count:0})
 await expect(service.assign('product',['a','b'])).rejects.toThrow('Product not found')
 expect(m.db.productCategory.deleteMany).not.toHaveBeenCalled();expect(m.emit).not.toHaveBeenCalled()
})
it('promotes a remaining membership and invalidates stale classification forms after removing the primary',async()=>{
 m.db.productCategory.deleteMany.mockResolvedValue({count:1});m.db.productCategory.findMany.mockResolvedValue([{categoryId:'b',isPrimary:false}])
 await service.unassign('product','a')
 expect(m.db.productCategory.update).toHaveBeenCalledWith(expect.objectContaining({data:{isPrimary:true}}))
 expect(m.db.product.updateMany).toHaveBeenCalledOnce();expect(m.emit).toHaveBeenCalledOnce()
})
