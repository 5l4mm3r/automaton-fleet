# Web search and image generation for the agents (schema v85; built, NOT CONNECTED)

## In short
- Agents can search the web (`web_search`) and generate images (`generate_image`) through the Fleet's **media gateway**:
  its own service, holding only the provider keys, with outbound internet only.
- **Nothing is connected yet.** Until you choose a provider and give the gateway its key, agents are told "no search
  provider is connected" or "no image provider is connected". They keep working with `web_fetch` on sites' own search
  pages, and draw images with code.
- **Every job's cost is recorded** per agent: Agents → Capabilities in Fleet HQ. Each agent has a daily cap of 60 searches
  and 10 images by default.

## State
| Part | Built | Installed | Connected | Enabled | Live-proven |
|---|---|---|---|---|---|
| `web_search` / `generate_image` tools (runtime founder-v10) | yes (tested) | needs deploy + Agent-1's runtime upgrade | — | — | no |
| Job queue, costs, daily caps (v85) | yes (tested) | needs deploy | — | — | no |
| Media gateway service (Brave Search, OpenAI Images adapters) | yes (tested against simulated providers) | no (`fleet-media-setup.sh`) | **no** (your keys) | no | no |

## Providers (checked 2026-10-16; candidates, your choice)
| Need | Adapter built | Price (official page) | Notes |
|---|---|---|---|
| Web search | **Brave Search API** | $5 per 1,000 searches; $5 free credit each month; 50 queries/s ([brave.com/search/api](https://brave.com/search/api/)) | A card is needed to subscribe. Storing results needs a plan that grants storage rights: the Fleet keeps an agent's results only as job records, so check Brave's terms for your use |
| Image generation | **OpenAI Images** (`gpt-image-1` by default; `FLEET_MEDIA_IMAGE_MODEL` can name a newer `gpt-image-*` model) | priced by tokens (e.g. gpt-image-1 image output $40 per 1M tokens); the per-image cost depends on size and quality: use OpenAI's calculator ([pricing](https://developers.openai.com/api/docs/pricing)) | Images carry provider usage terms; agents are told to disclose AI generation where required and never to fake product photos |

**The cost an agent sees is your estimate per job** (`FLEET_MEDIA_SEARCH_COST_CENTS`, `FLEET_MEDIA_IMAGE_COST_CENTS` in
`media.env`). The provider's own dashboard shows the exact charge. Charging media cost to agent wallets in the ledger is
not built: it needs the same decision as AI-credit funding (owner card or treasury lots), so today the cost is recorded and
shown, not booked.

## Set-up (each step is yours)
1. Choose providers. Create the account(s) with 2FA and an API key limited to this use.
2. Deploy the release with v85, then `sudo /opt/automaton-fleet/current/scripts/fleet-media-setup.sh install --apply`.
3. Give it the key(s): `sudo …/fleet-media-setup.sh set-keys --apply --search` (paste the key, then Ctrl-D), and the same
   with `--image`.
4. In `/etc/automaton-fleet/media.env` set `FLEET_MEDIA_SEARCH_PROVIDER=brave` and/or `FLEET_MEDIA_IMAGE_PROVIDER=openai`, and
   the per-job cost estimates. Then `systemctl restart automaton-fleet-media`.
5. Fleet HQ → Agents → Capabilities shows "connected". The agent's next `capabilities op check` shows it too.

## Safety
- The gateway holds only the provider keys, as systemd credentials. It reaches only those providers' API hosts, and
  refuses to start as root, with any safety switch on, or with another service's credential visible.
- An agent sees only its own jobs. An image's bytes are handed over once, then dropped from the database.
- A job left by a gateway that stopped is marked failed, never silently re-run (it could cost twice).
