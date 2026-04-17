
export default async function checkRegions({ container }: any) {
  const query = container.resolve("query");
  const { data: regions } = await query.graph({
    entity: "region",
    fields: ["id", "name", "countries.iso_2"]
  });
  console.log("Regions configuration:", JSON.stringify(regions, null, 2));
}
