import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    // Get overall stats
    const stats = await prisma.$queryRaw`
      SELECT 
        COUNT(*) as total_products,
        SUM(CASE WHEN "parentId" IS NULL THEN 1 ELSE 0 END) as top_level_items,
        SUM(CASE WHEN "parentId" IS NOT NULL THEN 1 ELSE 0 END) as child_items,
        SUM(CASE WHEN "isParent" = true THEN 1 ELSE 0 END) as marked_as_parent
      FROM "Product"
    `;
    
    console.log('Database Statistics:');
    const stat = (stats as any[])[0];
    console.log(`  Total products: ${stat.total_products}`);
    console.log(`  Top-level items: ${stat.top_level_items}`);
    console.log(`  Child items: ${stat.child_items}`);
    console.log(`  Marked as parent: ${stat.marked_as_parent}`);
    
    // Get parents with children
    const parentsWithChildren = await prisma.$queryRaw`
      SELECT 
        p.sku as parent_sku,
        COUNT(c.id) as child_count
      FROM "Product" p
      LEFT JOIN "Product" c ON c."parentId" = p.id
      WHERE p."parentId" IS NULL AND p."isParent" = true
      GROUP BY p.id, p.sku
      ORDER BY COUNT(c.id) DESC
      LIMIT 15
    `;
    
    console.log('\nParents with their child counts:');
    (parentsWithChildren as any[]).forEach((row: any) => {
      console.log(`  ${row.parent_sku}: ${row.child_count} children`);
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
