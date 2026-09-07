const { adminRequest } = require("./adminclient");

const LIST_QUERY = `
  query DraftOrders($first: Int!, $after: String, $query: String) {
    draftOrders(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        status
        createdAt
        tags
        totalPriceSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

const DELETE_MUTATION = `
  mutation DeleteDraftOrder($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

// draftOrderBulkDelete runs asynchronously and hands back a Job instead of ids, so
// anything past a single delete goes through here and then polls the job.
const BULK_DELETE_MUTATION = `
  mutation BulkDeleteDraftOrders($ids: [ID!]) {
    draftOrderBulkDelete(ids: $ids) {
      job { id done }
      userErrors { field message }
    }
  }
`;

const JOB_QUERY = `
  query Job($id: ID!) {
    job(id: $id) { id done }
  }
`;

function parseArgs(argv) {
  const opts = { ids: [], query: null, all: false, list: false, yes: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case "--id": opts.ids.push(next()); break;
      case "--query": opts.query = next(); break;
      case "--all": opts.all = true; break;
      case "--list": opts.list = true; break;
      case "--yes":
      case "-y": opts.yes = true; break;
      case "--help":
      case "-h": opts.help = true; break;
      default:
        // Bare arguments are treated as ids so `node delete-draft-order.js D12` works.
        if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
        opts.ids.push(arg);
    }
  }

  const selectors = [opts.ids.length > 0, Boolean(opts.query), opts.all].filter(Boolean);
  if (!opts.list && selectors.length === 0) {
    throw new Error("Nothing selected. Pass --id, --query, --all, or --list (see --help)");
  }
  if (selectors.length > 1) {
    throw new Error("Use only one of --id, --query, --all");
  }

  return opts;
}

function usage() {
  console.log(
    [
      "Delete draft orders via the Admin GraphQL draftOrderDelete mutation.",
      "",
      "  node delete-draft-order.js [options] [id ...]",
      "",
      "Options:",
      "  --id <id>        Draft order to delete. Accepts a gid, a numeric id, or a",
      "                   name like D12. Repeatable; bare arguments work too.",
      "  --query <q>      Delete every draft order matching a search query,",
      '                   e.g. --query "tag:lab-3.4".',
      "  --all            Delete every draft order in the store.",
      "  --list           Show draft orders and exit without deleting.",
      "  -y, --yes        Skip the confirmation prompt.",
      "  -h, --help       Show this help.",
      "",
      "Examples:",
      "  node delete-draft-order.js --list",
      "  node delete-draft-order.js D11 D12",
      "  node delete-draft-order.js --id gid://shopify/DraftOrder/1095118159924",
      '  node delete-draft-order.js --query "tag:lab-3.4" --yes',
    ].join("\n")
  );
}

function toGid(value) {
  const id = String(value).trim();
  if (id.startsWith("gid://")) return id;
  if (/^\d+$/.test(id)) return `gid://shopify/DraftOrder/${id}`;
  throw new Error(`Cannot turn "${id}" into a DraftOrder id -- pass a gid or numeric id`);
}

async function fetchDraftOrders(query, pageSize = 50) {
  const all = [];
  let after = null;

  do {
    const data = await adminRequest(LIST_QUERY, { first: pageSize, after, query });
    const { nodes, pageInfo } = data.draftOrders;
    all.push(...nodes);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);

  return all;
}

// Names like D12 are not ids, so they have to be looked up. Numeric ids and gids are
// converted directly and never cost a request.
async function resolveIds(rawIds) {
  const resolved = [];
  const names = [];

  for (const raw of rawIds) {
    const value = String(raw).trim();
    if (/^#?[Dd]\d+$/.test(value)) names.push(value.replace(/^#/, "").toUpperCase());
    else resolved.push(toGid(value));
  }

  if (names.length > 0) {
    const found = await fetchDraftOrders(names.map((n) => `name:${n}`).join(" OR "));
    for (const name of names) {
      const match = found.find((o) => o.name.replace(/^#/, "").toUpperCase() === name);
      if (!match) throw new Error(`No draft order found named ${name}`);
      resolved.push(match.id);
    }
  }

  return resolved;
}

function describe(order) {
  const total = order.totalPriceSet
    ? `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`
    : "-";
  const tags = order.tags && order.tags.length > 0 ? ` | ${order.tags.join(", ")}` : "";
  return `${order.name} | ${order.status} | ${total} | ${order.createdAt}${tags}`;
}

function confirm(count) {
  return new Promise((resolve) => {
    process.stdout.write(`Delete ${count} draft order(s)? This cannot be undone. [y/N] `);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (answer) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function reportUserErrors(userErrors) {
  if (!userErrors || userErrors.length === 0) return;
  const details = userErrors
    .map((e) => `${(e.field || ["input"]).join(".")}: ${e.message}`)
    .join("\n  ");
  throw new Error(`Mutation rejected the input:\n  ${details}`);
}

async function deleteOne(id) {
  const data = await adminRequest(DELETE_MUTATION, { input: { id } });
  reportUserErrors(data.draftOrderDelete.userErrors);
  return data.draftOrderDelete.deletedId;
}

async function deleteMany(ids) {
  const data = await adminRequest(BULK_DELETE_MUTATION, { ids });
  reportUserErrors(data.draftOrderBulkDelete.userErrors);

  let job = data.draftOrderBulkDelete.job;
  console.log(`Bulk delete job ${job.id} queued...`);

  // The job finishes fast for lab-sized batches, but it is still asynchronous.
  for (let attempt = 0; attempt < 30 && !job.done; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    job = (await adminRequest(JOB_QUERY, { id: job.id })).job;
  }

  if (!job.done) throw new Error(`Job ${job.id} did not finish in time -- check the admin`);
  return ids;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  // --list, --query and --all all read the store first so you can see what is about to
  // go; explicit --id deletes skip the read.
  let targets;
  if (opts.ids.length > 0) {
    const ids = await resolveIds(opts.ids);
    targets = ids.map((id) => ({ id, name: id.split("/").pop() }));
  } else {
    const orders = await fetchDraftOrders(opts.query);
    if (opts.list) {
      console.log(`Found ${orders.length} draft order(s)\n`);
      for (const order of orders) console.log(`  ${describe(order)}`);
      return;
    }
    targets = orders;
  }

  if (targets.length === 0) {
    console.log("No matching draft orders -- nothing to delete.");
    return;
  }

  console.log(`Targeting ${targets.length} draft order(s):`);
  for (const target of targets) {
    console.log(`  ${target.status ? describe(target) : target.id}`);
  }
  console.log();

  if (!opts.yes && !(await confirm(targets.length))) {
    console.log("Aborted, nothing deleted.");
    return;
  }

  const ids = targets.map((t) => t.id);
  if (ids.length === 1) {
    const deletedId = await deleteOne(ids[0]);
    console.log(`Deleted ${deletedId}`);
  } else {
    for (const id of await deleteMany(ids)) console.log(`Deleted ${id}`);
  }
}

main().catch((err) => {
  console.error("Failed to delete draft order(s):", err.message);
  process.exit(1);
});
