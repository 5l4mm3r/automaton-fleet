/**
 * LIVE-mode UI constants (labels, enumerations, reasons). Plain data with no network code, so both builds can use them.
 */
export const OWNER_IDENTITY_CLASSES = ["legal_name", "date_of_birth", "residential_address", "contact_email", "contact_phone", "id_document",
  "proof_of_address", "tax_identifier", "bank_account_owner", "other_fact", "passport", "driving_licence", "payment_card"] as const;

/** Live-only UI choices (the simulation uses its own lists). */
export const LIVE_MISSION_KINDS: string[][] = [["marketing", "Marketing"], ["opportunity_hunt", "Opportunity hunt"], ["knowledge_data", "Research (knowledge & data)"]];
export const LIVE_BIRTH_MISSIONS: string[][] = [["independent", "Independent"], ...LIVE_MISSION_KINDS];
export const CONSENT_PURPOSES = ["account_verification", "seller_verification", "payment_profile", "domain_registration", "other_legitimate"];

/** UI controls that have no live meaning (simulation-only devices), with the reason shown to the owner. */
export const LIVE_UNAVAILABLE: Readonly<Record<string, string>> = Object.freeze({
  topup: "Owner funding is real money arriving from outside: it is recorded with its bank/processor reference on the Fleet host, never created from the web.",
  role: "Permanent roles are set at birth; temporary roles are missions (use Assign mission).",
  provision: "Provisioning a birth order into a running agent is a privileged host step (scripts/fleet-founders.sh birth <order id>).",
  limits: "The Fleet has no runway-warning or missions-per-agent limit: risk is reported to each agent, and missions follow the mission policy.",
  genesis: "Owner-contributed capital is a ledger fact (recorded owner funding), not an editable setting.",
  passkey: "Add a passkey with a new one-time enrollment link from the Fleet host (fleet:admin hub-dashboard-enroll <this origin>).",
  tick: "Trading days are simulation devices; the live Fleet runs on its own.",
  scenario: "Scenarios are simulation devices; live alerts come from FleetController.",
  reset: "The live Fleet cannot be reset.",
});
