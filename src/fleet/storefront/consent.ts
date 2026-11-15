/**
 * The buyer's consent to immediate supply (schema v82; Consumer Contracts Regulations 2013, regs 36 and 37) — one wording,
 * used by the migration that stores it (immutably, by version) and by the public pages that show it.
 *
 *   digital_immediate  a download: the buyer asks for immediate access and acknowledges that the 14-day right to cancel is
 *                      lost once the download is made available (reg 37).
 *   service_start      a quoted service: the buyer asks for the work to start within the cancellation period and acknowledges
 *                      what cancelling costs and when the right ends (reg 36).
 *
 * A change of wording is a NEW version: earlier orders keep the version their buyer accepted.
 */
export const BUYER_CONSENT_VERSION = "2026-10-16.v1";
export type BuyerConsentKind = "digital_immediate" | "service_start";
export const BUYER_CONSENT_WORDING: Readonly<Record<BuyerConsentKind, readonly [string, string]>> = Object.freeze({
  digital_immediate: [
    "I want immediate access: please make my download available as soon as my payment is confirmed, before the 14-day cancellation period ends.",
    "I understand that I lose my 14-day right to cancel this purchase once the download is made available to me.",
  ] as const,
  service_start: [
    "I ask you to start work on my order now, during the 14-day cancellation period.",
    "I understand that if I cancel before the work is finished I must pay for the work done up to then, and that I lose my right to cancel once the work has been fully completed.",
  ] as const,
});
