/**
 * dev.ucp.shopping.checkout — the create/update/complete checkout-session
 * lifecycle, backed by Shopify Admin draft orders.
 *
 * A UCP checkout session snapshots the session's cart into a draft order
 * ("incomplete"), can be re-synced as the cart changes, and is finished by
 * complete_checkout.
 *
 * SIMULATED PAYMENT: this lab has no real payment processor wired up.
 * complete_checkout calls Shopify's real draftOrderComplete mutation — the
 * same mutation Shopify Admin itself uses to mark a draft order paid and
 * convert it into a real order — to stand in for a successful payment. No
 * card data is collected or transmitted anywhere in this codebase.
 */

import { adminRequest } from "../adminClient.js";
import { getSession, recordEvent } from "../sessionStore.js";
import { getCart } from "./cart.js";

const DRAFT_ORDER_FIELDS = `
  id
  name
  status
  invoiceUrl
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) {
    nodes {
      title
      quantity
      originalUnitPriceSet { shopMoney { amount currencyCode } }
    }
  }
`;

const DRAFT_ORDER_CREATE = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { ${DRAFT_ORDER_FIELDS} }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_UPDATE = `
  mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { ${DRAFT_ORDER_FIELDS} }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_QUERY = `
  query DraftOrder($id: ID!) {
    draftOrder(id: $id) { ${DRAFT_ORDER_FIELDS} }
  }
`;

const DRAFT_ORDER_COMPLETE = `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        status
        order {
          id
          name
          displayFinancialStatus
          displayFulfillmentStatus
        }
      }
      userErrors { field message }
    }
  }
`;

function assertNoErrors(userErrors) {
  if (userErrors && userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
}

function toCheckoutSnapshot(draftOrder, state) {
  return {
    checkoutId: draftOrder.id,
    name: draftOrder.name,
    state,
    total: draftOrder.totalPriceSet.shopMoney,
    invoiceUrl: draftOrder.invoiceUrl,
    lineItems: draftOrder.lineItems.nodes,
    // Empty on success. UCP uses this array for things like
    // requires_escalation prompts — not needed for the simulated-payment path.
    messages: [],
  };
}

/**
 * checkout.create — snapshot the session's current cart into a new checkout
 * session (a draft order). Requires cart.create to have run first.
 */
export async function createCheckout(sessionId, { email, note } = {}) {
  const session = getSession(sessionId);
  const cart = await getCart(sessionId);
  if (cart.lines.length === 0) {
    throw new Error("Cart is empty — add lines before starting checkout.");
  }

  const input = {
    lineItems: cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  };
  if (email) input.email = email;
  if (note) input.note = note;

  const data = await adminRequest(DRAFT_ORDER_CREATE, { input });
  assertNoErrors(data.draftOrderCreate.userErrors);

  const draftOrder = data.draftOrderCreate.draftOrder;
  session.draftOrderId = draftOrder.id;
  session.draftOrderName = draftOrder.name;
  session.checkoutState = "incomplete";
  recordEvent(sessionId, "checkout_created", { draftOrderId: draftOrder.id, name: draftOrder.name });

  return toCheckoutSnapshot(draftOrder, "incomplete");
}

/**
 * checkout.update — re-sync the checkout session's line items from the
 * session's cart (default) and/or update buyer email or note. Stays
 * "incomplete".
 */
export async function updateCheckout(sessionId, { email, note, resyncFromCart = true } = {}) {
  const session = getSession(sessionId);
  if (!session.draftOrderId || session.checkoutState !== "incomplete") {
    throw new Error("No incomplete checkout for this session — call create_checkout first.");
  }

  const input = {};
  if (resyncFromCart) {
    const cart = await getCart(sessionId);
    input.lineItems = cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
  }
  if (email) input.email = email;
  if (note) input.note = note;

  const data = await adminRequest(DRAFT_ORDER_UPDATE, { id: session.draftOrderId, input });
  assertNoErrors(data.draftOrderUpdate.userErrors);

  const draftOrder = data.draftOrderUpdate.draftOrder;
  session.draftOrderName = draftOrder.name;
  recordEvent(sessionId, "checkout_updated", { draftOrderId: draftOrder.id });

  return toCheckoutSnapshot(draftOrder, "incomplete");
}

/**
 * checkout.complete — finish the checkout session. See the SIMULATED PAYMENT
 * note at the top of this file: this marks the draft order paid and converts
 * it to a real order via Shopify's own mutation, standing in for a payment
 * that was never actually collected.
 *
 * Guardrail: the caller must echo back the total it believes it is paying.
 * This is re-checked against the checkout's current total fetched fresh from
 * Shopify — not against whatever createCheckout/updateCheckout last
 * returned — so a stale or guessed total is rejected rather than silently
 * charged. This is a data-integrity check, not a substitute for asking the
 * human shopper to confirm; that confirmation happens in the agent, which is
 * the one process with a human on the other end.
 */
export async function completeCheckout(sessionId, { expectedTotal } = {}) {
  const session = getSession(sessionId);
  if (!session.draftOrderId || session.checkoutState !== "incomplete") {
    throw new Error("No incomplete checkout for this session — call create_checkout first.");
  }
  if (!expectedTotal || typeof expectedTotal.amount !== "string" || !expectedTotal.currencyCode) {
    throw new Error(
      "expectedTotal (amount + currencyCode) is required — fetch the checkout's current total " +
        "and pass it back to confirm you're completing the checkout you think you are.",
    );
  }

  const current = await adminRequest(DRAFT_ORDER_QUERY, { id: session.draftOrderId });
  if (!current.draftOrder) {
    throw new Error("Checkout not found — it may have already been completed or expired.");
  }
  const actualTotal = current.draftOrder.totalPriceSet.shopMoney;
  if (actualTotal.amount !== expectedTotal.amount || actualTotal.currencyCode !== expectedTotal.currencyCode) {
    throw new Error(
      `expectedTotal (${expectedTotal.amount} ${expectedTotal.currencyCode}) does not match the checkout's ` +
        `current total (${actualTotal.amount} ${actualTotal.currencyCode}). Call update_checkout or get the ` +
        "checkout's current total, re-confirm with the shopper, and try again.",
    );
  }

  const data = await adminRequest(DRAFT_ORDER_COMPLETE, {
    id: session.draftOrderId,
    paymentPending: false,
  });
  assertNoErrors(data.draftOrderComplete.userErrors);

  const { order } = data.draftOrderComplete.draftOrder;
  session.checkoutState = "completed";
  session.orderId = order.id;
  session.orderName = order.name;
  recordEvent(sessionId, "checkout_completed", {
    orderId: order.id,
    name: order.name,
    simulatedPayment: true,
  });

  return {
    checkoutId: session.draftOrderId,
    state: "completed",
    order: {
      orderId: order.id,
      name: order.name,
      financialStatus: order.displayFinancialStatus,
      fulfillmentStatus: order.displayFulfillmentStatus,
    },
    messages: [
      {
        type: "info",
        code: "simulated_payment",
        text: "Payment was simulated for this training lab — no real payment processor was used.",
      },
    ],
  };
}
