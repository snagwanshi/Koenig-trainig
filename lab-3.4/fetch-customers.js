const { adminRequest } = require("./adminclient");

const QUERY = `
  query Customers($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        displayName
        email
        createdAt
        numberOfOrders
        amountSpent { amount currencyCode }
        defaultAddress { city province country }
        tags
      }
    }
  }
`;

async function fetchAllCustomers(pageSize = 50) {
  const all = [];
  let after = null;

  do {
    const data = await adminRequest(QUERY, { first: pageSize, after });
    const { nodes, pageInfo } = data.customers;
    all.push(...nodes);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);

  return all;
}

fetchAllCustomers()
  .then((customers) => {
    console.log(`Fetched ${customers.length} customer(s)\n`);
    for (const c of customers) {
      const loc = c.defaultAddress
        ? [c.defaultAddress.city, c.defaultAddress.province, c.defaultAddress.country]
            .filter(Boolean)
            .join(", ")
        : "-";
      console.log(
        [
          c.displayName,
          c.email || "(no email)",
          `${c.numberOfOrders} order(s)`,
          `${c.amountSpent.amount} ${c.amountSpent.currencyCode}`,
          loc,
        ].join(" | ")
      );
    }
  })
  .catch((err) => {
    console.error("Failed to fetch customers:", err.message);
    process.exit(1);
  });
