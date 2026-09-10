/**
 * dev.ucp.shopping.order — order status lookup and lifecycle events.
 *
 * The real UCP order capability pushes lifecycle events (shipped, delivered,
 * returned, ...) to the platform as webhooks. This lab has no public HTTPS
 * endpoint for Shopify to call, so events are instead appended in-process
 * (checkout.js does this on checkout_created/updated/completed) and read
 * back here as a stand-in for webhook delivery.
 */

import { adminRequest } from "../adminClient.js";
import { getSession } from "../sessionStore.js";

const ORDER_QUERY = `
  query OrderStatus($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      fulfillments(first: 10) {
        status
        trackingInfo { number url company }
      }
    }
  }
`;

/** order.get — look up status, total and fulfillment/tracking for an order id. */
export async function getOrder({ orderId } = {}) {
  if (!orderId) throw new Error("orderId is required");

  const data = await adminRequest(ORDER_QUERY, { id: orderId });
  if (!data.order) throw new Error(`No order found for id ${orderId}`);

  const o = data.order;
  return {
    orderId: o.id,
    name: o.name,
    createdAt: o.createdAt,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    total: o.totalPriceSet.shopMoney,
    fulfillments: o.fulfillments.map((f) => ({
      status: f.status,
      tracking: f.trackingInfo,
    })),
  };
}

/** order.events — the lifecycle event log recorded for a session so far. */
export function getOrderEvents(sessionId) {
  const session = getSession(sessionId);
  return session.events;
}
