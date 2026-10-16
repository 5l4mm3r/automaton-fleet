# Web search and image generation for the agents (schema v85, charged since v87; built, NOT CONNECTED)

## In short
- Agents can search the web (`web_search`) and generate images (`generate_image`) through the Fleet's **media gateway**:
  its own service, holding only the provider keys, with outbound internet only.
- **Nothing is connected yet.** Until you choose a provider and give the gateway its key, agents are told "no search
  provider is connected" or "no image provider is connected". They keep working with `web_fetch` on sites' own search
  pages, and draw images with code.
- **The agent pays for every job (v87).** Before a job runs, the most it can cost is reserved from the agent's own cash
  (not enough cash: no job; nothing is advanced). When it finishes, the agent is charged the actual cost and the rest is
  returned. Work for one of the agent's active missions names that mission, and the mission's beneficiaries (another
  agent, or the Fleet) pay their share when it ends, as with any mission cost.
- **The provider is paid on your card**, so each job's cost is owed to you, like AI credit: the money stays in the treasury
  as "held for the owner". A cost beyond the job's limit is a Fleet expense and an alert; the agent is never charged more
  than it reserved.
- Each agent has a daily cap of 60 searches and 10 images by default. Fleet HQ → Agents → Capabilities shows usage,
  charges, reservations and anything to resolve.

## State
| Part | Built | Installed | Connected | Enabled | Live-proven |
|---|---|---|---|---|---|
| `web_search` / `generate_image` tools (runtime founder-v10) | yes (tested) | needs deploy + Agent-1's runtime upgrade | — | — | no |
| Job queue, daily caps (v85); reservation, charge, statements (v87) | yes (tested against simulated providers) | needs deploy | — | — | no |
| Media gateway service (Brave Search, OpenAI Images adapters) | yes (tested against simulated providers) | no (`fleet-media-setup.sh`) | **no** (your keys) | no | no |

## Providers (checked 2026-10-16; candidates, your choice)
| Need | Adapter built | Price (official page) | Notes |
|---|---|---|---|
| Web search | **Brave Search API** | $5 per 1,000 searches; $5 free credit each month; 50 queries/s ([brave.com/search/api](https://brave.com/search/api/)) | A card is needed to subscribe. Storing results needs a plan that grants storage rights: the Fleet keeps an agent's results only as job records, so check Brave's terms for your use |
| Image generation | **OpenAI Images** (`gpt-image-1` by default; `FLEET_MEDIA_IMAGE_MODEL` can name a newer `gpt-image-*` model) | priced by tokens (e.g. gpt-image-1 image output $40 per 1M tokens); the per-image cost depends on size and quality: use OpenAI's calculator ([pricing](https://developers.openai.com/api/docs/pricing)) | Images carry provider usage terms; agents are told to disclose AI generation where required and never to fake product photos |

**What a job costs (v87)**, set in `media.env`:
- `FLEET_MEDIA_SEARCH_COST_CENTS`: a search's price (USD cents). It is both the reservation and the charge ("flat").
- `FLEET_MEDIA_IMAGE_COST_CENTS`: the most one image may cost (USD cents), reserved first. Set it from the provider's price
  list for the sizes agents may ask for (1024×1024 up to 1536×1024).
- `FLEET_MEDIA_IMAGE_TOKEN_PRICES="<input>,<output>"`: USD per million tokens from OpenAI's price list. With it, an image is
  charged from the tokens OpenAI reports for that call ("usage"); without it, the limit is charged ("estimate").
- A provider with no cost set takes no jobs at all: spend the Fleet cannot bound is never started.
- Costs convert to pounds at the controlled USD rate (the same one AI charges use), rounded up.

**Reconciling with the provider:**
- A job the gateway was running when it stopped has an **unknown cost**. Its reservation stays (the provider may have
  charged), and you are alerted. Resolve it in Agents → Capabilities with the cost from the provider's usage page (0 if
  none).
- Each month, record the provider's statement (period and amount billed). The difference from what the Fleet recorded is
  booked as owed to you, so no provider spend goes untracked, and you are alerted when the provider billed more. A period
  with unresolved jobs cannot be recorded until they are resolved.

## Set-up (each step is yours)
1. Choose providers. Create the account(s) with 2FA and an API key limited to this use.
2. Deploy the release with v85, then `sudo /opt/automaton-fleet/current/scripts/fleet-media-setup.sh install --apply`.
3. Give it the key(s): `sudo …/fleet-media-setup.sh set-keys --apply --search` (paste the key, then Ctrl-D), and the same
   with `--image`.
4. In `/etc/automaton-fleet/media.env` set `FLEET_MEDIA_SEARCH_PROVIDER=brave` and/or `FLEET_MEDIA_IMAGE_PROVIDER=openai`, the
   costs above (a provider without one takes no jobs), and optionally the image token prices. Then `systemctl restart
   automaton-fleet-media`. Without a key file the unit still starts and reports "not configured".
5. Fleet HQ → Agents → Capabilities shows "connected". The agent's next `capabilities op check` shows it too.

## Safety
- The gateway holds only the provider keys, as systemd credentials. It reaches only those providers' API hosts, and
  refuses to start as root, with any safety switch on, or with another service's credential visible.
- An agent sees only its own jobs. An image's bytes are handed over once, then dropped from the database.
- A job left by a gateway that stopped is marked failed, never silently re-run (it could cost twice).
