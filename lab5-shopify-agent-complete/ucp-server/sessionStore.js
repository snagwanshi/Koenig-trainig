/**
 * In-memory session state shared by the cart and checkout capabilities.
 *
 * A UCP "session" here is one shopper's cart/checkout/order lifecycle. Real
 * deployments would back this with a database keyed by session id; an
 * in-memory Map is enough for a single-process training lab and is wiped on
 * restart.
 */

function newSession() {
  return {
    cartId: null,
    checkoutState: null, // null | "incomplete" | "completed"
    draftOrderId: null,
    draftOrderName: null,
    orderId: null,
    orderName: null,
    events: [],
  };
}

const sessions = new Map();

/** @param {string} sessionId */
export function getSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("sessionId is required");
  }
  let session = sessions.get(sessionId);
  if (session === undefined) {
    session = newSession();
    sessions.set(sessionId, session);
  }
  return session;
}

/**
 * Appends a lifecycle event to a session's log. Stands in for the webhook
 * push that UCP's real dev.ucp.shopping.order capability uses — this lab has
 * no public HTTPS endpoint for Shopify to call.
 *
 * @param {string} sessionId
 * @param {string} type
 * @param {object} [data]
 */
export function recordEvent(sessionId, type, data = {}) {
  const session = getSession(sessionId);
  const event = { type, at: new Date().toISOString(), ...data };
  session.events.push(event);
  return event;
}
