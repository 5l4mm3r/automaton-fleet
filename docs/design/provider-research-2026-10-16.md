# Provider research: sources (checked 2026-10-16)

The recommendations are in `docs/operations/monitoring-and-alerts.md`, `docs/operations/backup-and-recovery.md` and
`docs/design/bank-debit-card-requirements.md` §8. These are the official pages they rest on. Items marked unverified there
could not be confirmed on an official page.

## Phone push
- Web Push on iOS / iPadOS 16.4: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- RFC 8030 / 8291 / 8292: https://www.rfc-editor.org/rfc/rfc8030 · https://www.rfc-editor.org/rfc/rfc8291 · https://www.rfc-editor.org/rfc/rfc8292
- ntfy: https://docs.ntfy.sh/config/ · https://docs.ntfy.sh/publish/ · https://docs.ntfy.sh/subscribe/phone/ · https://ntfy.sh/#pricing
- Pushover: https://pushover.net/api · https://pushover.net/pricing
- Telegram: https://telegram.org/faq · https://core.telegram.org/bots/faq

## Outside monitoring
- Healthchecks.io: https://healthchecks.io/pricing/ · https://healthchecks.io/docs/ · https://healthchecks.io/integrations/add_pushover/
- UptimeRobot: https://uptimerobot.com/pricing.md
- Better Stack: https://betterstack.com/pricing

## Backups
- Backblaze B2: https://www.backblaze.com/cloud-storage/pricing · https://www.backblaze.com/docs/cloud-storage-object-lock
- Cloudflare R2: https://developers.cloudflare.com/r2/pricing/
- Hetzner Storage Box: https://www.hetzner.com/storage/storage-box/ · https://docs.hetzner.com/storage/storage-box/general/
- OVH Object Storage: https://docs.ovhcloud.com/en/guides/storage-and-backup/object-storage/s3-faq
- restic: https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html · https://restic.readthedocs.io/en/stable/100_references.html
- Borg append-only: https://borgbackup.readthedocs.io/en/stable/usage/notes.html · pgBackRest: https://pgbackrest.org/user-guide.html

## Bank / card
- Starling: https://developer.starlingbank.com/docs · https://api.starlingbank.com/api/openapi.json · https://www.starlingbank.com/sole-trader-bank-account/ ·
  https://www.starlingbank.com/docs/legal/account/starling-business-soletrader-account-schedule-and-rfc-apr-2026.pdf · https://www.starlingbank.com/blog/introducing-3D-secure/ ·
  https://www.starlingbank.com/features/virtual-cards/
- Revolut Business: https://github.com/revolut-engineering/revolut-openapi/blob/master/yaml/business.yaml ·
  https://cdn.revolut.com/terms_and_conditions/pdf/business_terms_b9973fb2_2.3.0_1769686581_en.pdf ·
  https://help.revolut.com/en-US/business/help/integrating-with-external-apps/revolut-business-api/question-using-revolut-business-api/ ·
  https://www.revolut.com/legal/business-fees-all-plans-current/ ·
  https://help.revolut.com/en-US/help/making-paymentsbusiness/cards-general/what-is-3ds-and-how-do-i-authorise-payments-with-it/business/ ·
  https://developer.revolut.com/docs/business/create-card
- Airwallex: https://www.airwallex.com/docs/issuing/transactions/transaction-lifecycle · https://www.airwallex.com/docs/issuing/card-controls/remote-authorization ·
  https://www.airwallex.com/docs/issuing/card-controls/authorization-controls · https://www.airwallex.com/docs/issuing/card-controls/3d-secure-authentication ·
  https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events · https://www.airwallex.com/docs/api/authentication/api_access_token ·
  https://www.airwallex.com/uk/pricing · https://help.airwallex.com/hc/en-gb/articles/900001755746-Documents-required-for-companies-in-the-UK
- Monzo: https://docs.monzo.com/
- Wise: https://docs.wise.com/guides/developer/auth-and-security/personal-api-token · https://docs.wise.com/guides/developer/auth-and-security/sca-and-2fa
- Open banking: https://docs.truelayer.com/docs/connections · https://support.truelayer.com/hc/en-us/articles/360002750513-How-long-do-refresh-tokens-last-for ·
  https://bankaccountdata.gocardless.com/new-signups-disabled
