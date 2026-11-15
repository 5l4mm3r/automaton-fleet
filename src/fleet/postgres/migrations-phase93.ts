/**
 * Schema v93 — a sealed card is RECOGNISABLE without being readable (owner, 2026-10-17: "it should show … name on card
 * and last 4 digits … the rest obscured"), and its expiry is known.
 *
 * The owner's browser seals the whole card to the identity broker (unchanged) and, beside it, sends a short MASKED label
 * it composes itself — brand, the last four digits, the name on the card, the expiry month (e.g. "Visa •••• 1234 · J SMITH
 * · exp 08/28") — and the expiry as a date. The server refuses a label that carries a run of five or more digits (never a
 * card number by mistake). The label is kept with the vault entry once the broker installs it, and shown in Fleet HQ; the
 * expiry makes an expired card unusable (cards are chosen only while not expired, v90). Agents never see either.
 */
import { V36_SQL } from "./migrations-phase36.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V92_SQL } from "./migrations-phase92.js";
import { restate } from "./migrations-phase42.js";

const LABEL_CHECK = `CHECK (display_label IS NULL OR (length(display_label) BETWEEN 3 AND 80 AND display_label !~ '[0-9]{5,}'))`;

const INSTALLED = restate(V36_SQL, "ix_vault_installed", [
  [`    INSERT INTO fleet_owner_identity_classes (class_key, vault_ref, expires_at, status, updated_by) VALUES (u.class_key, 'ovault:' || u.class_key, u.expires_at, 'configured', u.uploaded_by)
      ON CONFLICT (class_key) DO UPDATE SET vault_ref = EXCLUDED.vault_ref, expires_at = EXCLUDED.expires_at, status = 'configured', updated_by = EXCLUDED.updated_by, updated_at = now();`,
   `    INSERT INTO fleet_owner_identity_classes (class_key, vault_ref, expires_at, status, updated_by, display_label) VALUES (u.class_key, 'ovault:' || u.class_key, u.expires_at, 'configured', u.uploaded_by, u.display_label)
      ON CONFLICT (class_key) DO UPDATE SET vault_ref = EXCLUDED.vault_ref, expires_at = EXCLUDED.expires_at, status = 'configured', updated_by = EXCLUDED.updated_by, updated_at = now(),
        display_label = EXCLUDED.display_label;`],
]);

const AUTONOMY_JSON = restate(V51_SQL, "fleet_identity_autonomy_json", [
  [`jsonb_build_object('status', status, 'expiresAt', expires_at)`, `jsonb_build_object('status', status, 'expiresAt', expires_at, 'label', display_label)`],
]);

const DASH_CALL = restate(V92_SQL, "dash_call", [
  [`fleet_admin_owner_vault_upload(a ->> 'class', decode(a ->> 'sealedB64', 'base64'), a ->> 'contentType', (a ->> 'expiresAt')::timestamptz, `,
   `fleet_admin_owner_vault_upload(a ->> 'class', decode(a ->> 'sealedB64', 'base64'), a ->> 'contentType', (a ->> 'expiresAt')::timestamptz, NULLIF(a ->> 'displayLabel', ''), `],
]);

export const V93_SQL = `
ALTER TABLE fleet_owner_vault_inbox ADD COLUMN display_label text ${LABEL_CHECK};
ALTER TABLE fleet_owner_identity_classes ADD COLUMN display_label text ${LABEL_CHECK};

-- The upload with its masked label (the 5-argument form stays for older callers: no label).
CREATE FUNCTION fleet_admin_owner_vault_upload(p_class text, p_sealed bytea, p_content_type text, p_expires timestamptz, p_label text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid(); v_label text := NULLIF(btrim(COALESCE(p_label, '')), '');
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_owner_identity');
  IF p_sealed IS NULL OR substring(p_sealed FROM 1 FOR 4) <> '\\x46534231'::bytea THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: the upload must be sealed to the broker key (FSB1)'; END IF;
  IF v_label IS NOT NULL AND (length(v_label) NOT BETWEEN 3 AND 80 OR v_label ~ '[0-9]{5,}') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the label is a short masked description (at most the last four digits)';
  END IF;
  INSERT INTO fleet_owner_vault_inbox (upload_id, class_key, sealed, content_type, expires_at, uploaded_by, display_label)
    VALUES (v_id, p_class, p_sealed, p_content_type, p_expires, p_actor, v_label);
  PERFORM fleet_event('owner_identity_uploaded', NULL, p_actor, jsonb_build_object('uploadId', v_id, 'class', p_class, 'contentType', p_content_type, 'bytes', octet_length(p_sealed)));
  RETURN jsonb_build_object('ok', true, 'uploadId', v_id, 'status', 'pending', 'next', 'the identity broker installs it into the sealed owner vault');
END $$;

${INSTALLED}

${AUTONOMY_JSON}

${DASH_CALL}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
