const { adminRequest } = require("./adminclient");

// Shared between draftOrderCreate and draftOrderCalculate: DraftOrderLineItem and
// CalculatedDraftOrderLineItem expose the same money fields, so one selection set
// works for both.
const LINE_ITEM_FIELDS = `
  title
  variantTitle
  sku
  quantity
  originalUnitPriceSet { shopMoney { amount currencyCode } }
  totalDiscountSet { shopMoney { amount currencyCode } }
  discountedTotalSet { shopMoney { amount currencyCode } }
`;

const TOTALS_FIELDS = `
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }
  totalTaxSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
`;

const CREATE_MUTATION = `
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        invoiceUrl
        email
        note2
        tags
        createdAt
        customer { id displayName email }
        lineItems(first: 50) { nodes { ${LINE_ITEM_FIELDS} } }
        ${TOTALS_FIELDS}
      }
      userErrors { field message }
    }
  }
`;

// Same input type, but nothing is persisted. Used by --dry-run so you can see the
// priced-out order before committing to it.
const CALCULATE_MUTATION = `
  mutation CalculateDraftOrder($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder {
        currencyCode
        customer { id displayName email }
        lineItems { ${LINE_ITEM_FIELDS} }
        ${TOTALS_FIELDS}
      }
      userErrors { field message }
    }
  }
`;

const FIRST_VARIANT_QUERY = `
  query FirstVariant {
    productVariants(first: 1) {
      nodes { id title price product { title } }
    }
  }
`;

const CUSTOMER_BY_EMAIL_QUERY = `
  query CustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes { id displayName email }
    }
  }
`;

function parseArgs(argv) {
  const opts = {
    variants: [],
    qty: 1,
    tags: [],
    discountPct: null,
    dryRun: false,
    help: false,
    email: null,
    customer: null,
    note: null,
    shippingTitle: null,
    shippingPrice: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case "--variant": opts.variants.push(next()); break;
      case "--qty": opts.qty = Number(next()); break;
      case "--email": opts.email = next(); break;
      case "--customer": opts.customer = next(); break;
      case "--note": opts.note = next(); break;
      case "--tag": opts.tags.push(next()); break;
      case "--discount-pct": opts.discountPct = Number(next()); break;
      case "--shipping-title": opts.shippingTitle = next(); break;
      case "--shipping-price": opts.shippingPrice = next(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--help":
      case "-h": opts.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(opts.qty) || opts.qty < 1) {
    throw new Error("--qty must be a positive integer");
  }
  if (opts.discountPct !== null && !(opts.discountPct > 0 && opts.discountPct <= 100)) {
    throw new Error("--discount-pct must be between 1 and 100");
  }
  if (Boolean(opts.shippingTitle) !== Boolean(opts.shippingPrice)) {
    throw new Error("--shipping-title and --shipping-price must be used together");
  }

  return opts;
}

function usage() {
  console.log(
    [
      "Create a draft order via the Admin GraphQL draftOrderCreate mutation.",
      "",
      "  node create-draft-order.js [options]",
      "",
      "Options:",
      "  --variant <id>          Variant to add. Accepts a numeric id or a full",
      "                          gid://shopify/ProductVariant/... gid. Repeatable.",
      "                          Defaults to the first variant in the store.",
      "  --qty <n>               Quantity for every --variant (default 1).",
      "  --email <address>       Contact email for the draft order.",
      "  --customer <id|email>   Attach a customer, by gid or by email lookup.",
      "  --note <text>           Internal note on the draft order.",
      "  --tag <tag>             Tag to apply. Repeatable.",
      "  --discount-pct <n>      Order-level percentage discount (1-100).",
      "  --shipping-title <t>    Custom shipping line title (needs --shipping-price).",
      "  --shipping-price <amt>  Custom shipping line amount.",
      "  --dry-run               Price it with draftOrderCalculate; create nothing.",
      "  -h, --help              Show this help.",
      "",
      "Examples:",
      "  node create-draft-order.js",
      '  node create-draft-order.js --qty 2 --note "Phone order" --tag lab-3.4',
      "  node create-draft-order.js --variant 51234567890 --discount-pct 10 --dry-run",
      '  node create-draft-order.js --customer buyer@example.com --shipping-title "Local delivery" --shipping-price 4.99',
    ].join("\n")
  );
}

// The lab flags accept a bare numeric id; the API only takes gids.
function toGid(value, type) {
  const id = String(value).trim();
  if (id.startsWith("gid://")) return id;
  if (/^\d+$/.test(id)) return `gid://shopify/${type}/${id}`;
  throw new Error(`Cannot turn "${id}" into a ${type} id`);
}

async function resolveVariantIds(rawVariants) {
  if (rawVariants.length > 0) {
    return rawVariants.map((v) => toGid(v, "ProductVariant"));
  }

  const data = await adminRequest(FIRST_VARIANT_QUERY);
  const variant = data.productVariants.nodes[0];
  if (!variant) {
    throw new Error("Store has no product variants -- pass --variant explicitly");
  }

  console.log(
    `No --variant given, using "${variant.product.title} / ${variant.title}" (${variant.price})\n`
  );
  return [variant.id];
}

async function resolveCustomerId(customer) {
  if (!customer) return null;

  if (customer.includes("@")) {
    const data = await adminRequest(CUSTOMER_BY_EMAIL_QUERY, { query: `email:${customer}` });
    const found = data.customers.nodes[0];
    if (!found) throw new Error(`No customer found with email ${customer}`);
    return found.id;
  }

  return toGid(customer, "Customer");
}

let cachedCurrency = null;
async function shopCurrency() {
  if (!cachedCurrency) {
    const data = await adminRequest(`query { shop { currencyCode } }`);
    cachedCurrency = data.shop.currencyCode;
  }
  return cachedCurrency;
}

async function buildInput(opts) {
  const variantIds = await resolveVariantIds(opts.variants);
  const customerId = await resolveCustomerId(opts.customer);

  const input = {
    lineItems: variantIds.map((variantId) => ({ variantId, quantity: opts.qty })),
  };

  if (opts.email) input.email = opts.email;
  if (opts.note) input.note = opts.note;
  if (opts.tags.length > 0) input.tags = opts.tags;

  if (customerId) {
    // customerId is no longer a top-level DraftOrderInput field; it lives under
    // purchasingEntity now.
    input.purchasingEntity = { customerId };
    input.useCustomerDefaultAddress = true;
  }

  if (opts.discountPct !== null) {
    input.appliedDiscount = {
      valueType: "PERCENTAGE",
      value: opts.discountPct,
      title: `${opts.discountPct}% off`,
      description: "Applied by create-draft-order.js",
    };
  }

  if (opts.shippingTitle) {
    input.shippingLine = {
      title: opts.shippingTitle,
      priceWithCurrency: {
        amount: opts.shippingPrice,
        currencyCode: await shopCurrency(),
      },
    };
  }

  return input;
}

function money(moneySet) {
  if (!moneySet) return "-";
  const { amount, currencyCode } = moneySet.shopMoney;
  return `${amount} ${currencyCode}`;
}

function printOrder(order, lineItems) {
  console.log(`Draft order ${order.name || "(not persisted)"} (${order.status || "CALCULATED"})`);
  console.log(`  id            ${order.id || "-"}`);
  if (order.customer) {
    const email = order.customer.email || "no email";
    console.log(`  customer      ${order.customer.displayName} <${email}>`);
  }
  if (order.email) console.log(`  email         ${order.email}`);
  if (order.note2) console.log(`  note          ${order.note2}`);
  if (order.tags && order.tags.length > 0) console.log(`  tags          ${order.tags.join(", ")}`);

  console.log("\n  Line items:");
  for (const item of lineItems) {
    const name = [item.title, item.variantTitle].filter(Boolean).join(" / ");
    console.log(
      `    ${item.quantity} x ${name} | ${item.sku || "(no sku)"} | ` +
        `${money(item.originalUnitPriceSet)} each | -${money(item.totalDiscountSet)} | ` +
        `= ${money(item.discountedTotalSet)}`
    );
  }

  console.log("\n  Totals:");
  console.log(`    subtotal    ${money(order.subtotalPriceSet)}`);
  console.log(`    discounts  -${money(order.totalDiscountsSet)}`);
  console.log(`    shipping    ${money(order.totalShippingPriceSet)}`);
  console.log(`    tax         ${money(order.totalTaxSet)}`);
  console.log(`    total       ${money(order.totalPriceSet)}`);

  if (order.invoiceUrl) console.log(`\n  Invoice URL: ${order.invoiceUrl}`);
}

// userErrors are validation failures on an otherwise successful HTTP 200 request, so
// they have to be checked separately from the transport errors adminRequest throws.
function reportUserErrors(userErrors) {
  if (!userErrors || userErrors.length === 0) return;
  const details = userErrors
    .map((e) => `${(e.field || ["input"]).join(".")}: ${e.message}`)
    .join("\n  ");
  throw new Error(`Mutation rejected the input:\n  ${details}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const input = await buildInput(opts);

  if (opts.dryRun) {
    const data = await adminRequest(CALCULATE_MUTATION, { input });
    reportUserErrors(data.draftOrderCalculate.userErrors);
    const calculated = data.draftOrderCalculate.calculatedDraftOrder;
    console.log("Dry run -- draftOrderCalculate only, nothing was created.\n");
    printOrder(calculated, calculated.lineItems);
    return;
  }

  const data = await adminRequest(CREATE_MUTATION, { input });
  reportUserErrors(data.draftOrderCreate.userErrors);
  const draftOrder = data.draftOrderCreate.draftOrder;
  printOrder(draftOrder, draftOrder.lineItems.nodes);
}

main().catch((err) => {
  console.error("Failed to create draft order:", err.message);
  process.exit(1);
});
