import "dotenv/config";

export async function storefrontRequest(query, variables) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN;
  if (!domain || !token) {
    throw new Error(
      "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_STOREFRONT_PRIVATE_TOKEN in lab5-shopify-agent-complete/.env"
    );
  }
  const url = `https://${domain}/api/2026-07/graphql.json`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Shopify-Storefront-Private-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    const cause = e.cause?.code ?? e.cause?.message ?? "no cause";
    throw new Error(`Network error calling ${url}: ${e.message} (${cause})`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}
