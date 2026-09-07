const { adminRequest } = require("./adminclient");

const QUERY = `
  query Products($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        productType
        vendor
        totalInventory
        tags
        createdAt
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 20) {
          nodes {
            id
            title
            sku
            price
            inventoryQuantity
          }
        }
      }
    }
  }
`;

async function fetchAllProducts(pageSize = 50) {
  const all = [];
  let after = null;

  do {
    const data = await adminRequest(QUERY, { first: pageSize, after });
    const { nodes, pageInfo } = data.products;
    all.push(...nodes);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);

  return all;
}

function priceLabel(range) {
  const { minVariantPrice: min, maxVariantPrice: max } = range;
  return min.amount === max.amount
    ? `${min.amount} ${min.currencyCode}`
    : `${min.amount}-${max.amount} ${min.currencyCode}`;
}

fetchAllProducts()
  .then((products) => {
    console.log(`Fetched ${products.length} product(s)\n`);
    for (const p of products) {
      console.log(
        [
          p.title,
          p.status,
          p.productType || "(no type)",
          priceLabel(p.priceRangeV2),
          `${p.totalInventory} in stock`,
          `${p.variants.nodes.length} variant(s)`,
        ].join(" | ")
      );
      for (const v of p.variants.nodes) {
        console.log(
          `    - ${v.title} | ${v.sku || "(no sku)"} | ${v.price} | qty ${v.inventoryQuantity}`
        );
      }
    }
  })
  .catch((err) => {
    console.error("Failed to fetch products:", err.message);
    process.exit(1);
  });
