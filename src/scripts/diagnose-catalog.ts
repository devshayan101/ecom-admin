export default async function diagnoseCatalog({ container }: any) {
  const query = container.resolve("query") as any;
  const logger = container.resolve("logger") as any;

  // 1. Get Beauty Category ID
  const { data: categories } = await query.graph({
    entity: "product_category",
    fields: ["id", "name", "handle"],
    filters: { name: ["Beauty", "Skincare", "Makeup"] }
  });
  
  const beautyIds = categories.map(c => c.id);
  logger.info(`Checking categories: ${JSON.stringify(categories.map(c => c.name))}`);

  // 2. Get Products in Beauty
  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id", 
      "handle", 
      "title", 
      "thumbnail",
      "variants.id",
      "variants.sku",
      "variants.manage_inventory",
      "variants.inventory_items.inventory_item.id",
      "variants.inventory_items.inventory_item.sku",
      "variants.inventory_items.inventory_item.inventory_levels.location_id",
      "variants.inventory_items.inventory_item.inventory_levels.stocked_quantity"
    ],
    // We'll filter in JS if needed or just dump all for better visibility
  });

  const beautyProducts = (products as any).filter((p: any) => true); // Dump all for diagnosis

  for (const p of beautyProducts) {
    logger.info(`Product: ${p.title} (${p.handle})`);
    logger.info(`  Thumbnail: ${p.thumbnail}`);
    for (const v of p.variants) {
      const inv = v.inventory_items?.[0]?.inventory_item;
      const levels = inv?.inventory_levels || [];
      logger.info(`  Variant SKU: ${v.sku} (Manage: ${v.manage_inventory})`);
      logger.info(`    Inventory ID: ${inv?.id || "N/A"}`);
      logger.info(`    Levels: ${JSON.stringify(levels)}`);
    }
  }
}
