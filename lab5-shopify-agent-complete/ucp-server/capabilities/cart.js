/**
 * dev.ucp.shopping.cart — pre-checkout basket management, backed by the
 * Storefront Cart API. One Shopify cart per UCP session.
 */

import { storefrontRequest } from "../storefrontClient.js";
import { getSession } from "../sessionStore.js";

const CART_FIELDS = `
  id
  checkoutUrl
  totalQuantity
  cost {
    subtotalAmount { amount currencyCode }
    totalAmount { amount currencyCode }
  }
  lines(first: 50) {
    edges {
      node {
        id
        quantity
        merchandise {
          ... on ProductVariant {
            id
            title
            price { amount currencyCode }
            product { title }
          }
        }
      }
    }
  }
`;

const CART_CREATE = `
  mutation CartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart { ${CART_FIELDS} }
      userErrors { field message }
    }
  }
`;

const CART_QUERY = `
  query CartQuery($id: ID!) {
    cart(id: $id) { ${CART_FIELDS} }
  }
`;

const CART_LINES_ADD = `
  mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart { ${CART_FIELDS} }
      userErrors { field message }
    }
  }
`;

const CART_LINES_UPDATE = `
  mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart { ${CART_FIELDS} }
      userErrors { field message }
    }
  }
`;

const CART_LINES_REMOVE = `
  mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
      cart { ${CART_FIELDS} }
      userErrors { field message }
    }
  }
`;

function assertNoErrors(userErrors) {
  if (userErrors && userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
}

function toSnapshot(cart) {
  return {
    cartId: cart.id,
    checkoutUrl: cart.checkoutUrl,
    totalQuantity: cart.totalQuantity,
    subtotal: cart.cost.subtotalAmount,
    total: cart.cost.totalAmount,
    lines: cart.lines.edges.map((e) => ({
      lineId: e.node.id,
      variantId: e.node.merchandise.id,
      title: `${e.node.merchandise.product.title} — ${e.node.merchandise.title}`,
      quantity: e.node.quantity,
      unitPrice: e.node.merchandise.price,
    })),
  };
}

/** cart.create — start a new cart for this session with an initial set of lines. */
export async function createCart(sessionId, { lines = [] } = {}) {
  const session = getSession(sessionId);
  const input = {
    lines: lines.map((l) => ({ merchandiseId: l.variantId, quantity: l.quantity ?? 1 })),
  };

  const data = await storefrontRequest(CART_CREATE, { input });
  assertNoErrors(data.cartCreate.userErrors);

  session.cartId = data.cartCreate.cart.id;
  return toSnapshot(data.cartCreate.cart);
}

/** cart.update — add, change the quantity of, or remove lines on the session's cart. */
export async function updateCart(
  sessionId,
  { addLines = [], updateLines = [], removeLineIds = [] } = {},
) {
  const session = getSession(sessionId);
  if (!session.cartId) {
    throw new Error("No cart for this session yet — call create_cart first.");
  }

  let cart = null;

  if (addLines.length > 0) {
    const data = await storefrontRequest(CART_LINES_ADD, {
      cartId: session.cartId,
      lines: addLines.map((l) => ({ merchandiseId: l.variantId, quantity: l.quantity ?? 1 })),
    });
    assertNoErrors(data.cartLinesAdd.userErrors);
    cart = data.cartLinesAdd.cart;
  }

  if (updateLines.length > 0) {
    const data = await storefrontRequest(CART_LINES_UPDATE, {
      cartId: session.cartId,
      lines: updateLines.map((l) => ({ id: l.lineId, quantity: l.quantity })),
    });
    assertNoErrors(data.cartLinesUpdate.userErrors);
    cart = data.cartLinesUpdate.cart;
  }

  if (removeLineIds.length > 0) {
    const data = await storefrontRequest(CART_LINES_REMOVE, {
      cartId: session.cartId,
      lineIds: removeLineIds,
    });
    assertNoErrors(data.cartLinesRemove.userErrors);
    cart = data.cartLinesRemove.cart;
  }

  if (cart === null) {
    // Nothing to mutate — just return the current state.
    const data = await storefrontRequest(CART_QUERY, { id: session.cartId });
    cart = data.cart;
  }

  return toSnapshot(cart);
}

/** cart.get — read the session's current cart. */
export async function getCart(sessionId) {
  const session = getSession(sessionId);
  if (!session.cartId) {
    throw new Error("No cart for this session yet — call create_cart first.");
  }
  const data = await storefrontRequest(CART_QUERY, { id: session.cartId });
  if (!data.cart) {
    throw new Error("Cart not found — it may have expired.");
  }
  return toSnapshot(data.cart);
}
