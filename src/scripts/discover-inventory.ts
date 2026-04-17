export default async function discoverInventory({ container }: any) {
  const query = container.resolve("query") as any;
  const logger = container.resolve("logger") as any;

  const { data: locations } = await query.graph({
    entity: "stock_location",
    fields: ["id", "name"],
  });
  
  logger.info(`Stock Locations: ${JSON.stringify(locations, null, 2)}`);

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "prices.amount", "prices.currency_code"],
    take: 10
  });
  logger.info(`Sample Variants & Prices: ${JSON.stringify(variants, null, 2)}`);

  const { data: items } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku"],
    take: 5
  });
  logger.info(`Sample Inventory Items: ${JSON.stringify(items, null, 2)}`);
}

