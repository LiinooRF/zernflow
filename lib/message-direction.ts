/**
 * Zernio labels message direction `incoming` / `outgoing`.
 *
 * Both call sites used to compare against the string "outbound", which Zernio
 * never sends, so every message the account had SENT was classified as
 * received: replies rendered on the contact's side of the thread, making a
 * conversation impossible to read, and the webhook's loop guard for outbound
 * messages never matched.
 *
 * Accepts the synonyms rather than one spelling, so a rename on their side
 * degrades to the old behaviour instead of flipping every thread.
 */
const OUTBOUND = new Set(["outbound", "outgoing", "out", "sent"]);

export type MessageDirection = "inbound" | "outbound";

export function normalizeDirection(direction: unknown): MessageDirection {
  return typeof direction === "string" && OUTBOUND.has(direction.toLowerCase())
    ? "outbound"
    : "inbound";
}

export function isOutbound(direction: unknown): boolean {
  return normalizeDirection(direction) === "outbound";
}
