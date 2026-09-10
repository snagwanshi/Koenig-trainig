/**
 * dev.ucp.shopping.catalog.search / dev.ucp.shopping.catalog.lookup
 *
 * Product discovery, backed by the Storefront API (public catalog data — no
 * Admin token needed).
 */

import { storefrontRequest } from "../storefrontClient.js";

const SEARCH_PRODUCTS = `
  query SearchProducts($query: String, $limit: Int!) {
    products(first: $limit, query: $query) {
      edges {
        node {
          id
          title
          availableForSale
          priceRange { minVariantPrice { amount currencyCode } }
          variants(first: 1) { edges { node { id title } } }
        }
      }
    }
  }
`;

/** catalog.search — free-text product search. */
export async function catalogSearch({ query = "", limit = 10 } = {}) {
  const data = await storefrontRequest(SEARCH_PRODUCTS, { query, limit });
  return data.products.edges.map((e) => ({
    productId: e.node.id,
    title: e.node.title,
    availableForSale: e.node.availableForSale,
    price: e.node.priceRange.minVariantPrice.amount,
    currency: e.node.priceRange.minVariantPrice.currencyCode,
    variantId: e.node.variants.edges[0]?.node.id ?? "",
  }));
}

const LOOKUP_PRODUCT = `
  query LookupProduct($id: ID!) {
    product(id: $id) {
      id
      title
      description
      availableForSale
      priceRange { minVariantPrice { amount currencyCode } }
      variants(first: 20) {
        edges { node { id title availableForSale price { amount currencyCode } } }
      }
    }
  }
`;

const LOOKUP_VARIANT = `
  query LookupVariant($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        title
        availableForSale
        price { amount currencyCode }
        product { id title }
      }
    }
  }
`;

/** catalog.lookup — fetch one product or variant by id. */
export async function catalogLookup({ productId, variantId } = {}) {
  if (variantId) {
    const data = await storefrontRequest(LOOKUP_VARIANT, { id: variantId });
    if (!data.node) throw new Error(`No variant found for id ${variantId}`);
    return {
      type: "variant",
      variantId: data.node.id,
      title: data.node.title,
      availableForSale: data.node.availableForSale,
      price: data.node.price.amount,
      currency: data.node.price.currencyCode,
      productId: data.node.product.id,
      productTitle: data.node.product.title,
    };
  }

  if (productId) {
    const data = await storefrontRequest(LOOKUP_PRODUCT, { id: productId });
    if (!data.product) throw new Error(`No product found for id ${productId}`);
    return {
      type: "product",
      productId: data.product.id,
      title: data.product.title,
      description: data.product.description,
      availableForSale: data.product.availableForSale,
      price: data.product.priceRange.minVariantPrice.amount,
      currency: data.product.priceRange.minVariantPrice.currencyCode,
      variants: data.product.variants.edges.map((e) => ({
        variantId: e.node.id,
        title: e.node.title,
        availableForSale: e.node.availableForSale,
        price: e.node.price.amount,
        currency: e.node.price.currencyCode,
      })),
    };
  }

  throw new Error("catalogLookup requires a productId or a variantId");
}
