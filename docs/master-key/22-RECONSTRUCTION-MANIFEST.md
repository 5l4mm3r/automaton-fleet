# 22 — Reconstruction Manifest

A machine-oriented manifest. Compare a reconstruction against it with `sha256sum -c`. The authoritative JSON is in section 4. **No secret file is hashed** (list under `secret_files_not_hashed`).

## 1. Identity

| Key | Value |
|---|---|
| repository_commit_inspected | `efad2148a3460ab881b0ab845fb13c25d1fa3e74` |
| runtime commit (production, LIVE) | `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` |
| build ID (LIVE) | `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced` |
| lockfile SHA-256 (LIVE; equals `sha256sum pnpm-lock.yaml` at HEAD) | `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` |
| schema version (LIVE) | 8 |
| ChatGPT adapter artifact (RECORD) | commit `6691b4c`, build `62336fee…` |

## 2. Migrations

| Version | Name | Source |
|---|---|---|
| 1 | `shared_fleet_registry` | `src/fleet/postgres/migrations.ts` |
| 2 | `leases_heartbeat_expiry_restricted_api` | `src/fleet/postgres/migrations.ts` |
| 3 | `service_role_runtime_immutability_terminations` | `src/fleet/postgres/migrations.ts` |
| 4 | `lifecycle_health_sessions_provisioning_orphans_custody` | `src/fleet/postgres/migrations.ts` |
| 5 | `treasury_economics` | `src/fleet/postgres/migrations-phase5.ts` |
| 6 | `provisioning_intents_dry_run_child` | `src/fleet/postgres/migrations-phase6.ts` |
| 7 | `capability_scope_witness` | `src/fleet/postgres/migrations-phase7.ts` |
| 8 | `operator_api_read_only` | `src/fleet/postgres/migrations-phase8.ts` |

## 3. File hashes (SHA-256, repository HEAD)

Each block is in `sha256sum -c` format; run it from the root of a reconstructed checkout.

### source_fleet (66 files)

```
32e0bd59e27c64806b8c67ee42d9e08c7e86c3d8bdd9541e82d1b933be280368  src/fleet/attestation.ts
249c713220ac37cfb4762be71afec747462fdd17b030c17984d811eeae52b58f  src/fleet/backend.ts
be6053e1b8d10f1de321374b9a4729cffbd22e2a25946d8e16c6bb9ef1b1f44f  src/fleet/bridge/cli.ts
3c8fc81e7d3ebf6c9ec0d807eff0a3713b119ba15d81a1dd459cbc432c93a964  src/fleet/bridge/client.ts
50aad5df40774da817bb98caab8fd02fb4e03491b2c95b5bf0a640bfe92bf1eb  src/fleet/bridge/config.ts
f320eb107b6c584f5fa7661cca759b1c16757aaf73ec6e8288f65fa1630d4314  src/fleet/bridge/direct.ts
937161692fb7d74dfa19ba7c195ed96f340216630f1fd02bb519085fb263e398  src/fleet/bridge/endpoint.ts
70ac37ff887751aa78cbf97d365769826a3bedeada5b5fa39ff99c9053db2f29  src/fleet/bridge/errors.ts
016bc57dfa066d1c12917842ae600c19fdba23c74da7163133ce01c1b45afbce  src/fleet/bridge/hostkey.ts
789a40f6780c1fac208fde73d993a57d3206c778d00b7df56beb0a46a1b37b4a  src/fleet/bridge/keys.ts
99f96a9eeabcfc6ca57ebd406b78eded356fa0abf3d7745b359f4895c462bd24  src/fleet/bridge/mcp-core.ts
cde9493b8f4010e66609532d88556a2024bfddc2936085d5ece4d975d92a77d2  src/fleet/bridge/mcp.ts
4c08272f9ae1205a87b591e88749ff2464a70cb7b22e4ce04dd8fc352b025050  src/fleet/bridge/tunnel.ts
ce286278ccfb8492731ff54868ab16e2831e99f3cde10e23b2db2c7e0fc33e77  src/fleet/bridge/validate.ts
866e4c3127cb4c034de45600b9da7be44689b3599a203631607107281c7171ff  src/fleet/chatgpt-adapter/config.ts
c983edbd7b8a514e8aaf2c533238ae8de047c5c738dacf05ff14b1eb2a203e6f  src/fleet/chatgpt-adapter/http.ts
db6b0622f2cf733a4914e164d986cd8b8effc234bf8e50dc8c27978d02e414ca  src/fleet/chatgpt-adapter/main.ts
103e34b49aabdbe2637bab1874c0a6a2bca2ee7c0ac93e419605ebe8fb2b128e  src/fleet/config.ts
c78ef36bfcb9896b85a7c24832df169dd606384c76496fe51d112ab9b158e12a  src/fleet/controller.ts
297d934c14f1deae49b0be62289e5c4652ac6737d44b7eaf855341f05996ccb8  src/fleet/doctor.ts
b3d5c794266293ba80c17bb09401c749700b3eeae204be961c06a3b3af089753  src/fleet/dry-run/child-main.ts
fbf474b7bad44a57169b8c82cf4cea1e38508bd8a38e243f5b07734fb9601dfa  src/fleet/dry-run/child.ts
e4eefb08b06a63faa93682f83f0faadcc7c8fcf5ae331198fd42e92c3be4473b  src/fleet/dry-run/operator.ts
beb352c478f068d905aead17226f723f13e8806e0d9e37c1d49a322f3d7d404b  src/fleet/dry-run/root-main.ts
00dbccb8fff15bc666af6998f1feedf9ad737afa62d97316c5bc913f7ce08b31  src/fleet/dry-run/root-witness.ts
b7a9a24d8a8d5ce41c178a0b50891a1afc0478e3e5c2321387727aa2d0610e32  src/fleet/grants.ts
2cf4db43a916990c92ccd716f57e94e97cc7398ce47f9d03a7d51acfd4127e6f  src/fleet/index.ts
5ac548519ab22e967bfc7002e735cff2840b3b83e031dad0f238ba244912079d  src/fleet/operator/admin.ts
a285cd01fb7e6f04e11983b02d9f7aed1d1678164cd7e48489fa2483f8de3fdb  src/fleet/operator/canonical.ts
09021a68963a36c08a272ab40ec17c561883e12b39bfb099fffc32ecbc1c47b5  src/fleet/operator/gateway.ts
c4c7974dc881a99974ed5b480b83ac98cbe5a99401205489211f86267d2ed54d  src/fleet/operator/keygen.ts
9540bb16ebcce5cfd3f8632cfc755a180b1563422ca3574d893dc3f70a0deb55  src/fleet/operator/main.ts
5126c7edb68f311a8dc9b0e37815d8230b4427a11e2263b29879038c880824c8  src/fleet/operator/responses.ts
91df7bd9c57cfe5c5472d0235838df45dd4205f71019af1a4f736f8e81bdfa9d  src/fleet/operator/route-policy.ts
8901fd9fc371727cdc4e61cfa0cfbb9e9ed6d41a2a424c991bc9a7fb41cc7400  src/fleet/operator/server.ts
f345052d146e0eac4ac4710a88b733f8444e9fc4f96485782f931d1369f51987  src/fleet/policy.ts
f08cdcce086fe830f032091059cb6db6af5735fedf8986746bdcd42c4e696c55  src/fleet/postgres/agent-gateway.ts
8fe5f8012d3fc671089a8dfeb130c3cacb15f89e2ad81fbc065ec783053c18ac  src/fleet/postgres/cli.ts
4867898711d3706834cca6da9597e7a87c746bd60f1aeef485bf61a9e33e5fb1  src/fleet/postgres/migrations-phase5.ts
67ec6e7202f5e7afac88b0c32b4e27c1a425230c6d3f5d6afefc8734e58b5261  src/fleet/postgres/migrations-phase6.ts
181a2d7b12a3df19130a6e8e01b6711655c1ec36279483faf210705a7921e532  src/fleet/postgres/migrations-phase7.ts
a9b93dc2cf4dbd7ba0417f681ace4c3520048847acc102cfbf0da62fa27bab9d  src/fleet/postgres/migrations-phase8.ts
49682d4af8f8c55849a2ebdc4fed4bad65f3279fe9f75ec5b6bf1b904ac4b0c4  src/fleet/postgres/migrations.ts
563e3b3176ad5b225058c327226f6faa53125398e208bff01125a9e2f5d9610b  src/fleet/postgres/privileges.ts
ecd883a9387300896cedf4e6242df47630005aa529ca52656486b2541a1657ea  src/fleet/postgres/store.ts
bc4b7d6e84289a2e080fc42bfd013d4208cf97c7d48d197321201e09f13913a5  src/fleet/redact-scan.ts
cb16c678ed37e10714849f2b57684758370dcf907ce338458348796da1814f54  src/fleet/redact.ts
c50908a540d7760ff3240568b56ad4b6fb604fc8398fe8893bfddb6e89da4ddd  src/fleet/registry.ts
39480041dbff73f769287a89b38a6fba1404580181cf86f5f803b31e41a7d35e  src/fleet/runtime-verify.ts
695e7f173f2114e45d6fa3ec7715d7321283e7201275828a8ffe7be7fa85b409  src/fleet/runtime.ts
01c2bf7ab6cf25f5f1bad3b7f178eaf0625dfea45b1e4b85b976c01fb1f67112  src/fleet/secret-files.ts
562ea7a956de647f321da6bf49d3b27b2b8167c01399b1133482c9f6f594aadf  src/fleet/secrets.ts
94fd00a3553338d59f138887d8744cbe061a5b1a31f1f4d398b2983fa14507e2  src/fleet/service/client.ts
9660df45e43f378454a9107446590f46d97322d5a938a1e1205d96f7e40fbadc  src/fleet/service/log.ts
92b61088d1289537b7fa317999ea9ef73d13b13235d6660edb1b6927862601c2  src/fleet/service/main.ts
dd9b75f587539bb153edf535c5b9785a8136766e60670ca73152c0583e68a3fb  src/fleet/service/rate-limit.ts
44ea0917d57692c3fe330efc39f0d076a1ca43750bc6eb37c016c37463b1f29c  src/fleet/service/server-signing.ts
1c5c9329c98604f3998b7c24d3978f30f380c2c7dc4da28136e66abf0d9735ee  src/fleet/service/server.ts
9aa6500b5575233dcbc30690278a108153f9955f94475e8b63e6c3c77087ccd2  src/fleet/service/terminator.ts
d8d8ef2be589df63f9a20a8a0d1df278459a742312d7c21c2c3ed7924af44d04  src/fleet/shared-controller.ts
8d8f9a2329c7794eca7ca656fe7a94d03ee535d29f6a7dfdcc86ba4b7de83b62  src/fleet/shared.ts
5af1e67e9308d227722113ea06ac4692d4c9e3bb86a3c49da972bc52db3087ec  src/fleet/treasury/cli.ts
b0e82a997f2ce4ce8ea746296d1c923101a6acb48ca700803a0a71bbaf6c21e2  src/fleet/treasury/custody.ts
c3d03ff9cd191598294d1393c4d1062111a1576b3c52d548396830bfc62372e2  src/fleet/treasury/engine.ts
3a32a8555d89dc9e959e1cfa17ffea03ddc96b7b6956ecc6a7cbcd1b91583441  src/fleet/treasury/store.ts
7bde6b4aaa710c6173a19661148398439fb559195e63ba17c288db85faa33d0b  src/fleet/types.ts
```

### source_fleet_touched_upstream (18 files)

```
b9081cf0d2a8523bf6b782d296f5620fea900ebfed7964a348c9b40413c668a6  src/__tests__/mocks.ts
a14330a2454ecd3af0cf03a99c7a56ed0e332cdeeb4da2a42dc22636fbc3b4d9  src/__tests__/replication.test.ts
b232af4f01d79de61c79d3dfbcb20a77efee7bd0088d5abe83f7058edcc9449d  src/agent/harnesses/coding-harness.ts
19c36fa6758b817d7f30f3938666d84882f558988d74f683c1b3eb3df38db4c3  src/agent/harnesses/general-harness.ts
492d9206d6123f6aa978ac404edaff6400c8d59b2cdf3684d32e4c463927523a  src/agent/loop.ts
088f6a69be45c76fe9f6d30aded753945dd2fc9841cac331300ccf588ead598f  src/agent/policy-rules/command-safety.ts
1718a3d19ff00d0b1b4af35a4d14a7d581ed15602620dfcf66adc1f227f7c18d  src/agent/policy-rules/fleet.ts
15dcc13c23ec1f45b74c4b15cdf6b4850b141f55bba1d551f0ddc2de5f2dab83  src/agent/policy-rules/index.ts
cb3502d26eb9f5cf63015d487e654b8320bc096f60074e4ceb07580adca58381  src/agent/policy-rules/path-protection.ts
d44105d9f02d0efb4c5ecb43630fac86d366593bfb6f250e7844df987d43092b  src/agent/tools.ts
f052a0c38d9dcd8ea72079fa7d462bd1d5217d40bfa8708270f2b81c166d993a  src/conway/client.ts
67008a30e83674d3d3976793d1a3ae40938139b984fd220e41c40afbd5871e31  src/index.ts
56977888b2d19a40127e2c56db9a651a0a42d95ca2403552957f5e9a9eefd3d3  src/replication/lifecycle.ts
62b8d1e7f245d71a022669c9dc8398b7616587f65f1262def3f929240c1debe7  src/replication/spawn.ts
ebb9eeeb2842c9b02675e950dd18fd1ade87ce607966cf5ea9161feddb00066e  src/self-mod/code.ts
b668b6158a22e5477e1fee3b994fa46b5a301bb681327e6abef94769b4e1be9b  src/state/database.ts
2d30f9aee2a18cce6c5fdf7bf59327c5a3a05e68bebf44210f50bcbb10382c8f  src/state/schema.ts
6dcfb344a62ac136a44aac5e972b57f9cb19de7a43f0d1210a8540fef352a5a9  src/types.ts
```

### tests_fleet (26 files)

```
c49aaea33e07df6b8ccd60f81ef100ab9df3abeda0c6bfc9fb240a40ad9af2b3  src/__tests__/fleet/bridge-integration.test.ts
68ce3d9139974e18789be72e0821c3c8db75d7c7418f8a3a31fa3d8432e23e00  src/__tests__/fleet/bridge-mcp.test.ts
6bbc8ac2d965018c794c14bf223813fb970e7eeb2abc279eb012b9e2a654b010  src/__tests__/fleet/bridge-tunnel.test.ts
2ceb53cae95beda181ee954d8cca17ca653fc924168f323cb5aeb2b92df0b019  src/__tests__/fleet/bridge-unit.test.ts
8cf5e83272e5138164fe5021d4981eb30f1f40c0f2d2dba20f09350858ffebf6  src/__tests__/fleet/chatgpt-adapter-imports.test.ts
95153cbe07fe0ae9e2adb8fcf3f4c44c4ffd723468c629093109889767028197  src/__tests__/fleet/chatgpt-adapter.test.ts
c26eee491a8fb8a4e6d5a4b5ad2b27fd591970b573892b2b0c073a9a2e5863f7  src/__tests__/fleet/chatgpt-tunnel-key.test.ts
944bd869aa7983e3c28d5ee1ff5baff46c0e7dfeba3c6ec3c29756eb02f929f0  src/__tests__/fleet/fixtures/ephemeral-pg.ts
97bf335db9ac21fc62908c99acdb7d58135e43c7c4cd2854ba64346105df1cdc  src/__tests__/fleet/fixtures/fake-ssh.ts
1882b8f95ed07eaaa8c0c6b13f26dae1175c6f398162740d1a441a07d1026bb4  src/__tests__/fleet/fixtures/pg-reserve-worker.ts
0d9759a3dbd1340ac931d6551884c54e86a294454f617736b4a06a8c99984bc5  src/__tests__/fleet/fixtures/redaction-corpus.ts
e3e6bb3ca00941b45675990712db2bdad0746cd91e68b6876aa5af6d8fe3dcae  src/__tests__/fleet/fixtures/reserve-worker.ts
65f440c196a4fe63f2cd1d979cbc0aca31753f04b9b46ee79e70f9b1c654b38e  src/__tests__/fleet/fixtures/wipe.ts
eac8c0d77ae775dcada0e0683041749880d7d29b1cc0ccb19b778b55c6e91f8d  src/__tests__/fleet/fleet-phase2.test.ts
bd948256ff33b2c9e42dbdf52d150ac2ebac3174d0da4f2866755c3824587679  src/__tests__/fleet/fleet-phase3.test.ts
24767d7aea58d3a44296a47be57471b04e0efe1a88d130f37ee8005c15f99d4b  src/__tests__/fleet/fleet-phase4.test.ts
5e7ecb5f3f73ffaa313cf017a9e3e031ac55984e5cc54cf1f6021b08cae8999d  src/__tests__/fleet/fleet-phase5.test.ts
579f9d85653e36dabe2a14c58e796f9c63a6fd93014440c1df1f851f78fb67cc  src/__tests__/fleet/fleet-phase6.test.ts
c5dd7d30ddbf42a4142f21e9442ef64edf8a38ceb4bd42f4bfab3682ba38812c  src/__tests__/fleet/fleet-witness-imports.test.ts
0c2c2729757ae0fb3beb8e99fd02d8c7e97c8ab44cfbc348c2d13bbeddce4606  src/__tests__/fleet/fleet-witness.test.ts
008de5c47fc188c87e565cfdac5f28389d83f38084b7ff2698302eea86ba1d1f  src/__tests__/fleet/fleet.test.ts
795e68dcff4a8482ffaa09246f989420891a37a975058cf99827c2126c2fa3e4  src/__tests__/fleet/operator-canonical.test.ts
567506898ecd28c47ad1fc2f364e7ee75e7322f912053e070f81f46e25d5fe46  src/__tests__/fleet/operator-pg.test.ts
3b518c0453d168914d125edac64659cb9adbbfbfd4ca3dfd552fd99237b0f8ec  src/__tests__/fleet/operator-server.test.ts
9ef90ca7575de169dbce78ebc62d8375685725ecfcb099420f4d4bb1f454d8fd  src/__tests__/fleet/redact-sinks.test.ts
91aa1129663c8d4ffb199b3cf292c2764cd270045675530f7faf2575b5abc4e9  src/__tests__/fleet/redact.test.ts
```

### deployment_scripts (9 files)

```
1d3bba87eb427e1c8b006e858a939694b51224ec3c003a54f1501da9b71031bc  scripts/fleet-build-runtime.sh
4ce1eadb0d4edc5316830b2067bb5b48b175524ef94de0a07d71b7ce7e1b214d  scripts/fleet-chatgpt-setup.sh
9c8ff3d69423a1f3898c1de2b4266798d2fff38f675e510714d51c99be5570ff  scripts/fleet-chatgpt-tunnel-key.sh
fa80e6add2b8e48d39ca0c28f9c22a27d91c1cd4b0ef02c591fcccc4d5c32d95  scripts/fleet-db-roles.sql
15fc1b23843a2a6a4584a76286338c0b16397dd8bd32f7ca7e7a567a33152d76  scripts/fleet-db-setup.sh
60bdca449e266ec50baeddcfe3a69b9dc1b76b44dfa59c407b2230a17ad28d11  scripts/fleet-deploy-chatgpt-adapter.sh
50d03dbe5440095dbb866b4c4d12d31049b0caf6c5576b06a057048189ee084f  scripts/fleet-deploy-release.sh
df7919ad313401cdeb1871e41d5a60aa259ef13ec6fd6d376681778980cd795d  scripts/fleet-os-setup.sh
80e80a37784151ec5ecb241ce23f221a7aa145c44fdbb8edd508cba884e9b641  scripts/fleet-verify-deployment.sh
```

### systemd_templates (9 files)

```
e8f90f6dc23bb046419da45dcc66c900a5fb5e70f25c3b136c12f0dd9669205a  deploy/systemd/automaton-agent.service
331a1422269b5248d9b3a4949dc83b37dba33865abb1e0eeb74906d32c4d54d7  deploy/systemd/automaton-fleet-chatgpt-adapter.service
1ef46f613e5d7577f8768b49b81284cf63cf406c9716f1c9bd52be8d4dc3eb67  deploy/systemd/automaton-fleet-chatgpt-adapter.socket
69098a0b01906c4b6e90630a65dd64c03be4ff1fd642889df10a4cfbc2555d07  deploy/systemd/automaton-fleet-chatgpt-tunnel.path
8f2888c4d0b616e23e9e86adbd3721591e826a81b7be0941df50c81a4d04d7fd  deploy/systemd/automaton-fleet-chatgpt-tunnel.service
5f2454cf37accbba401eb5d624561d449360e88b622fe75c7db8789457b2d871  deploy/systemd/automaton-fleet-operator-api.service
b3447b8c26445f21dce2929ebd65dcd57fae6ae6a1eab22a22b343174e008b58  deploy/systemd/automaton-fleet-witness.service
388f78e9b59bc9d4f7882d080eef2131448078189693c5533c4591428679d760  deploy/systemd/automaton-fleet.service
a90d9f396efdb8dee08a73cee2c914dacd65b7f84d8ebcc671416366a41991e2  deploy/systemd/automaton-fleet.service.d/remote.conf.example
```

### configuration_templates (6 files)

```
57927daa1f938bf8f19c1834e89715f5c69f3df81473d5fd898e6b2ac074b5b8  deploy/etc/admin.env.example
f72d6f55d6925ee9c31b1909b4a5986fb2735ff4c246a8cbf1b2c273d5d8912b  deploy/etc/operator.env.example
5fa32c4dcc4a3a1cbd038c34c7558e0642e554d5e04cfa2b9b36ab27286aca70  deploy/etc/runtime.env.example
24acb2e6c6171df9661ff65b352a64321d1b3266b4d6015c694cc71d1ddbd931  deploy/etc/service.env.example
2ddf4372715b1c7230dd06299f4d6366d6ccd8df27264a70b6cb00ced695f1f5  deploy/firewall/fleet-firewall.sh
6709a5401923f28fde0ca16478d460e62877a31edb7e1eecdceb559ac18f9238  deploy/logrotate/automaton-fleet
```

### build_configuration (6 files)

```
ca91918749e59afc5ee68cad9b9ebe5ab9d615a2c7ebe7ecacb0546d89713165  package.json
eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811  pnpm-lock.yaml
0fb360452b0231d114d0b0ad6cc76bb48fe528382f55827cf93739bf64ec79e1  pnpm-workspace.yaml
7a9a7c36771fcaaf2ca0f10ce03590d9d1b4e5957b67452630853cbc6184bd57  tsconfig.json
f85ee8f218fec8c42fd1dd6e1653d63956cae42ece05ed2286404f7a852d6c44  vitest.config.ts
aa30d8abf33a7728dc3e3040eecf588bb90af3753d637b3af6da35829abc466d  .gitignore
```

### documentation (10 files)

```
fd28399aa376fd73fccaa6a7452d5d5053ee78592f793421b198aa7990c486a9  CLAUDE.md
3fe9cef564562df98a130f40e41b99ba4c1dfff5c59c6ef10b909d4c67392a79  FLEET.md
6947261d51e2da3598ad3c47b753d72216743baaa743d98f1e35fa7b2c41af7d  ARCHITECTURE.md
c02a31179cc2ff19d2d6bc1e9ad0b6a6ff7ef70adf3274f839d6e7f3b43e903c  DOCUMENTATION.md
fc1437dcaa218ec1c6998b0876da829d177b88bed68fc729640c283cb07911e0  README.md
b56a598024cae88cae28b036c30179794f9674e4dc95f84074ae624741e74b57  docs/design/phase-b-operator-api.md
1fd0f19699616b15ffbde62abd20fc5b6916d31ff19074b1170eb63366d18e53  docs/design/phase-c-chatgpt-adapter.md
9422fda2ff89b3d6e6e6fdc2396435442ccb01c41498b2b705f04f5e8b303c1f  docs/design/phase-d-claude-bridge.md
00bd3669b7c75b5890a963e9ffed51b5d0f70046920a7edda33a9612e27a1977  docs/fleet-known-issues.md
b6b08f0298a4986dbd57c8887a82e8b3254ed6b329d73b2d077edec081c923d6  docs/fleet-production-runbook.md
```

### Installed production units

NOT CAPTURED in this pass (no host access; see 14-PRODUCTION-SNAPSHOT.md section 0 and Appendix A). Operator record: the installed units were byte-identical to the repo templates at their deployment gates.

### Source-archive volumes

Each file in `source/VOLUME-*.md` carries its own SHA-256, and they match section 3.

## 4. Machine-readable manifest (JSON)

```json
{
 "manifest_version": 1,
 "generated_utc": "2026-09-25",
 "repository": "https://github.com/5l4mm3r/automaton-fleet",
 "repository_commit_inspected": "efad2148a3460ab881b0ab845fb13c25d1fa3e74",
 "production_runtime": {
  "commit": "4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790",
  "build_id": "54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced",
  "lockfile_sha256": "eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811",
  "source": "live Operator API fleet_status 2026-09-25"
 },
 "chatgpt_adapter_artifact": {
  "commit": "6691b4c9db9d5dedb246d4e984b495f7c4cf0251",
  "build_id_prefix": "62336fee (full value: see 14-PRODUCTION-SNAPSHOT.md / runbook)"
 },
 "schema_version": 8,
 "migrations": [
  {
   "version": 1,
   "file": "src/fleet/postgres/migrations.ts",
   "name": "shared_fleet_registry"
  },
  {
   "version": 2,
   "file": "src/fleet/postgres/migrations.ts",
   "name": "leases_heartbeat_expiry_restricted_api"
  },
  {
   "version": 3,
   "file": "src/fleet/postgres/migrations.ts",
   "name": "service_role_runtime_immutability_terminations"
  },
  {
   "version": 4,
   "file": "src/fleet/postgres/migrations.ts",
   "name": "lifecycle_health_sessions_provisioning_orphans_custody"
  },
  {
   "version": 5,
   "file": "src/fleet/postgres/migrations-phase5.ts",
   "name": "treasury_economics"
  },
  {
   "version": 6,
   "file": "src/fleet/postgres/migrations-phase6.ts",
   "name": "provisioning_intents_dry_run_child"
  },
  {
   "version": 7,
   "file": "src/fleet/postgres/migrations-phase7.ts",
   "name": "capability_scope_witness"
  },
  {
   "version": 8,
   "file": "src/fleet/postgres/migrations-phase8.ts",
   "name": "operator_api_read_only"
  }
 ],
 "groups": {
  "source_fleet": {
   "src/fleet/attestation.ts": "32e0bd59e27c64806b8c67ee42d9e08c7e86c3d8bdd9541e82d1b933be280368",
   "src/fleet/backend.ts": "249c713220ac37cfb4762be71afec747462fdd17b030c17984d811eeae52b58f",
   "src/fleet/bridge/cli.ts": "be6053e1b8d10f1de321374b9a4729cffbd22e2a25946d8e16c6bb9ef1b1f44f",
   "src/fleet/bridge/client.ts": "3c8fc81e7d3ebf6c9ec0d807eff0a3713b119ba15d81a1dd459cbc432c93a964",
   "src/fleet/bridge/config.ts": "50aad5df40774da817bb98caab8fd02fb4e03491b2c95b5bf0a640bfe92bf1eb",
   "src/fleet/bridge/direct.ts": "f320eb107b6c584f5fa7661cca759b1c16757aaf73ec6e8288f65fa1630d4314",
   "src/fleet/bridge/endpoint.ts": "937161692fb7d74dfa19ba7c195ed96f340216630f1fd02bb519085fb263e398",
   "src/fleet/bridge/errors.ts": "70ac37ff887751aa78cbf97d365769826a3bedeada5b5fa39ff99c9053db2f29",
   "src/fleet/bridge/hostkey.ts": "016bc57dfa066d1c12917842ae600c19fdba23c74da7163133ce01c1b45afbce",
   "src/fleet/bridge/keys.ts": "789a40f6780c1fac208fde73d993a57d3206c778d00b7df56beb0a46a1b37b4a",
   "src/fleet/bridge/mcp-core.ts": "99f96a9eeabcfc6ca57ebd406b78eded356fa0abf3d7745b359f4895c462bd24",
   "src/fleet/bridge/mcp.ts": "cde9493b8f4010e66609532d88556a2024bfddc2936085d5ece4d975d92a77d2",
   "src/fleet/bridge/tunnel.ts": "4c08272f9ae1205a87b591e88749ff2464a70cb7b22e4ce04dd8fc352b025050",
   "src/fleet/bridge/validate.ts": "ce286278ccfb8492731ff54868ab16e2831e99f3cde10e23b2db2c7e0fc33e77",
   "src/fleet/chatgpt-adapter/config.ts": "866e4c3127cb4c034de45600b9da7be44689b3599a203631607107281c7171ff",
   "src/fleet/chatgpt-adapter/http.ts": "c983edbd7b8a514e8aaf2c533238ae8de047c5c738dacf05ff14b1eb2a203e6f",
   "src/fleet/chatgpt-adapter/main.ts": "db6b0622f2cf733a4914e164d986cd8b8effc234bf8e50dc8c27978d02e414ca",
   "src/fleet/config.ts": "103e34b49aabdbe2637bab1874c0a6a2bca2ee7c0ac93e419605ebe8fb2b128e",
   "src/fleet/controller.ts": "c78ef36bfcb9896b85a7c24832df169dd606384c76496fe51d112ab9b158e12a",
   "src/fleet/doctor.ts": "297d934c14f1deae49b0be62289e5c4652ac6737d44b7eaf855341f05996ccb8",
   "src/fleet/dry-run/child-main.ts": "b3d5c794266293ba80c17bb09401c749700b3eeae204be961c06a3b3af089753",
   "src/fleet/dry-run/child.ts": "fbf474b7bad44a57169b8c82cf4cea1e38508bd8a38e243f5b07734fb9601dfa",
   "src/fleet/dry-run/operator.ts": "e4eefb08b06a63faa93682f83f0faadcc7c8fcf5ae331198fd42e92c3be4473b",
   "src/fleet/dry-run/root-main.ts": "beb352c478f068d905aead17226f723f13e8806e0d9e37c1d49a322f3d7d404b",
   "src/fleet/dry-run/root-witness.ts": "00dbccb8fff15bc666af6998f1feedf9ad737afa62d97316c5bc913f7ce08b31",
   "src/fleet/grants.ts": "b7a9a24d8a8d5ce41c178a0b50891a1afc0478e3e5c2321387727aa2d0610e32",
   "src/fleet/index.ts": "2cf4db43a916990c92ccd716f57e94e97cc7398ce47f9d03a7d51acfd4127e6f",
   "src/fleet/operator/admin.ts": "5ac548519ab22e967bfc7002e735cff2840b3b83e031dad0f238ba244912079d",
   "src/fleet/operator/canonical.ts": "a285cd01fb7e6f04e11983b02d9f7aed1d1678164cd7e48489fa2483f8de3fdb",
   "src/fleet/operator/gateway.ts": "09021a68963a36c08a272ab40ec17c561883e12b39bfb099fffc32ecbc1c47b5",
   "src/fleet/operator/keygen.ts": "c4c7974dc881a99974ed5b480b83ac98cbe5a99401205489211f86267d2ed54d",
   "src/fleet/operator/main.ts": "9540bb16ebcce5cfd3f8632cfc755a180b1563422ca3574d893dc3f70a0deb55",
   "src/fleet/operator/responses.ts": "5126c7edb68f311a8dc9b0e37815d8230b4427a11e2263b29879038c880824c8",
   "src/fleet/operator/route-policy.ts": "91df7bd9c57cfe5c5472d0235838df45dd4205f71019af1a4f736f8e81bdfa9d",
   "src/fleet/operator/server.ts": "8901fd9fc371727cdc4e61cfa0cfbb9e9ed6d41a2a424c991bc9a7fb41cc7400",
   "src/fleet/policy.ts": "f345052d146e0eac4ac4710a88b733f8444e9fc4f96485782f931d1369f51987",
   "src/fleet/postgres/agent-gateway.ts": "f08cdcce086fe830f032091059cb6db6af5735fedf8986746bdcd42c4e696c55",
   "src/fleet/postgres/cli.ts": "8fe5f8012d3fc671089a8dfeb130c3cacb15f89e2ad81fbc065ec783053c18ac",
   "src/fleet/postgres/migrations-phase5.ts": "4867898711d3706834cca6da9597e7a87c746bd60f1aeef485bf61a9e33e5fb1",
   "src/fleet/postgres/migrations-phase6.ts": "67ec6e7202f5e7afac88b0c32b4e27c1a425230c6d3f5d6afefc8734e58b5261",
   "src/fleet/postgres/migrations-phase7.ts": "181a2d7b12a3df19130a6e8e01b6711655c1ec36279483faf210705a7921e532",
   "src/fleet/postgres/migrations-phase8.ts": "a9b93dc2cf4dbd7ba0417f681ace4c3520048847acc102cfbf0da62fa27bab9d",
   "src/fleet/postgres/migrations.ts": "49682d4af8f8c55849a2ebdc4fed4bad65f3279fe9f75ec5b6bf1b904ac4b0c4",
   "src/fleet/postgres/privileges.ts": "563e3b3176ad5b225058c327226f6faa53125398e208bff01125a9e2f5d9610b",
   "src/fleet/postgres/store.ts": "ecd883a9387300896cedf4e6242df47630005aa529ca52656486b2541a1657ea",
   "src/fleet/redact-scan.ts": "bc4b7d6e84289a2e080fc42bfd013d4208cf97c7d48d197321201e09f13913a5",
   "src/fleet/redact.ts": "cb16c678ed37e10714849f2b57684758370dcf907ce338458348796da1814f54",
   "src/fleet/registry.ts": "c50908a540d7760ff3240568b56ad4b6fb604fc8398fe8893bfddb6e89da4ddd",
   "src/fleet/runtime-verify.ts": "39480041dbff73f769287a89b38a6fba1404580181cf86f5f803b31e41a7d35e",
   "src/fleet/runtime.ts": "695e7f173f2114e45d6fa3ec7715d7321283e7201275828a8ffe7be7fa85b409",
   "src/fleet/secret-files.ts": "01c2bf7ab6cf25f5f1bad3b7f178eaf0625dfea45b1e4b85b976c01fb1f67112",
   "src/fleet/secrets.ts": "562ea7a956de647f321da6bf49d3b27b2b8167c01399b1133482c9f6f594aadf",
   "src/fleet/service/client.ts": "94fd00a3553338d59f138887d8744cbe061a5b1a31f1f4d398b2983fa14507e2",
   "src/fleet/service/log.ts": "9660df45e43f378454a9107446590f46d97322d5a938a1e1205d96f7e40fbadc",
   "src/fleet/service/main.ts": "92b61088d1289537b7fa317999ea9ef73d13b13235d6660edb1b6927862601c2",
   "src/fleet/service/rate-limit.ts": "dd9b75f587539bb153edf535c5b9785a8136766e60670ca73152c0583e68a3fb",
   "src/fleet/service/server-signing.ts": "44ea0917d57692c3fe330efc39f0d076a1ca43750bc6eb37c016c37463b1f29c",
   "src/fleet/service/server.ts": "1c5c9329c98604f3998b7c24d3978f30f380c2c7dc4da28136e66abf0d9735ee",
   "src/fleet/service/terminator.ts": "9aa6500b5575233dcbc30690278a108153f9955f94475e8b63e6c3c77087ccd2",
   "src/fleet/shared-controller.ts": "d8d8ef2be589df63f9a20a8a0d1df278459a742312d7c21c2c3ed7924af44d04",
   "src/fleet/shared.ts": "8d8f9a2329c7794eca7ca656fe7a94d03ee535d29f6a7dfdcc86ba4b7de83b62",
   "src/fleet/treasury/cli.ts": "5af1e67e9308d227722113ea06ac4692d4c9e3bb86a3c49da972bc52db3087ec",
   "src/fleet/treasury/custody.ts": "b0e82a997f2ce4ce8ea746296d1c923101a6acb48ca700803a0a71bbaf6c21e2",
   "src/fleet/treasury/engine.ts": "c3d03ff9cd191598294d1393c4d1062111a1576b3c52d548396830bfc62372e2",
   "src/fleet/treasury/store.ts": "3a32a8555d89dc9e959e1cfa17ffea03ddc96b7b6956ecc6a7cbcd1b91583441",
   "src/fleet/types.ts": "7bde6b4aaa710c6173a19661148398439fb559195e63ba17c288db85faa33d0b"
  },
  "source_fleet_touched_upstream": {
   "src/__tests__/mocks.ts": "b9081cf0d2a8523bf6b782d296f5620fea900ebfed7964a348c9b40413c668a6",
   "src/__tests__/replication.test.ts": "a14330a2454ecd3af0cf03a99c7a56ed0e332cdeeb4da2a42dc22636fbc3b4d9",
   "src/agent/harnesses/coding-harness.ts": "b232af4f01d79de61c79d3dfbcb20a77efee7bd0088d5abe83f7058edcc9449d",
   "src/agent/harnesses/general-harness.ts": "19c36fa6758b817d7f30f3938666d84882f558988d74f683c1b3eb3df38db4c3",
   "src/agent/loop.ts": "492d9206d6123f6aa978ac404edaff6400c8d59b2cdf3684d32e4c463927523a",
   "src/agent/policy-rules/command-safety.ts": "088f6a69be45c76fe9f6d30aded753945dd2fc9841cac331300ccf588ead598f",
   "src/agent/policy-rules/fleet.ts": "1718a3d19ff00d0b1b4af35a4d14a7d581ed15602620dfcf66adc1f227f7c18d",
   "src/agent/policy-rules/index.ts": "15dcc13c23ec1f45b74c4b15cdf6b4850b141f55bba1d551f0ddc2de5f2dab83",
   "src/agent/policy-rules/path-protection.ts": "cb3502d26eb9f5cf63015d487e654b8320bc096f60074e4ceb07580adca58381",
   "src/agent/tools.ts": "d44105d9f02d0efb4c5ecb43630fac86d366593bfb6f250e7844df987d43092b",
   "src/conway/client.ts": "f052a0c38d9dcd8ea72079fa7d462bd1d5217d40bfa8708270f2b81c166d993a",
   "src/index.ts": "67008a30e83674d3d3976793d1a3ae40938139b984fd220e41c40afbd5871e31",
   "src/replication/lifecycle.ts": "56977888b2d19a40127e2c56db9a651a0a42d95ca2403552957f5e9a9eefd3d3",
   "src/replication/spawn.ts": "62b8d1e7f245d71a022669c9dc8398b7616587f65f1262def3f929240c1debe7",
   "src/self-mod/code.ts": "ebb9eeeb2842c9b02675e950dd18fd1ade87ce607966cf5ea9161feddb00066e",
   "src/state/database.ts": "b668b6158a22e5477e1fee3b994fa46b5a301bb681327e6abef94769b4e1be9b",
   "src/state/schema.ts": "2d30f9aee2a18cce6c5fdf7bf59327c5a3a05e68bebf44210f50bcbb10382c8f",
   "src/types.ts": "6dcfb344a62ac136a44aac5e972b57f9cb19de7a43f0d1210a8540fef352a5a9"
  },
  "tests_fleet": {
   "src/__tests__/fleet/bridge-integration.test.ts": "c49aaea33e07df6b8ccd60f81ef100ab9df3abeda0c6bfc9fb240a40ad9af2b3",
   "src/__tests__/fleet/bridge-mcp.test.ts": "68ce3d9139974e18789be72e0821c3c8db75d7c7418f8a3a31fa3d8432e23e00",
   "src/__tests__/fleet/bridge-tunnel.test.ts": "6bbc8ac2d965018c794c14bf223813fb970e7eeb2abc279eb012b9e2a654b010",
   "src/__tests__/fleet/bridge-unit.test.ts": "2ceb53cae95beda181ee954d8cca17ca653fc924168f323cb5aeb2b92df0b019",
   "src/__tests__/fleet/chatgpt-adapter-imports.test.ts": "8cf5e83272e5138164fe5021d4981eb30f1f40c0f2d2dba20f09350858ffebf6",
   "src/__tests__/fleet/chatgpt-adapter.test.ts": "95153cbe07fe0ae9e2adb8fcf3f4c44c4ffd723468c629093109889767028197",
   "src/__tests__/fleet/chatgpt-tunnel-key.test.ts": "c26eee491a8fb8a4e6d5a4b5ad2b27fd591970b573892b2b0c073a9a2e5863f7",
   "src/__tests__/fleet/fixtures/ephemeral-pg.ts": "944bd869aa7983e3c28d5ee1ff5baff46c0e7dfeba3c6ec3c29756eb02f929f0",
   "src/__tests__/fleet/fixtures/fake-ssh.ts": "97bf335db9ac21fc62908c99acdb7d58135e43c7c4cd2854ba64346105df1cdc",
   "src/__tests__/fleet/fixtures/pg-reserve-worker.ts": "1882b8f95ed07eaaa8c0c6b13f26dae1175c6f398162740d1a441a07d1026bb4",
   "src/__tests__/fleet/fixtures/redaction-corpus.ts": "0d9759a3dbd1340ac931d6551884c54e86a294454f617736b4a06a8c99984bc5",
   "src/__tests__/fleet/fixtures/reserve-worker.ts": "e3e6bb3ca00941b45675990712db2bdad0746cd91e68b6876aa5af6d8fe3dcae",
   "src/__tests__/fleet/fixtures/wipe.ts": "65f440c196a4fe63f2cd1d979cbc0aca31753f04b9b46ee79e70f9b1c654b38e",
   "src/__tests__/fleet/fleet-phase2.test.ts": "eac8c0d77ae775dcada0e0683041749880d7d29b1cc0ccb19b778b55c6e91f8d",
   "src/__tests__/fleet/fleet-phase3.test.ts": "bd948256ff33b2c9e42dbdf52d150ac2ebac3174d0da4f2866755c3824587679",
   "src/__tests__/fleet/fleet-phase4.test.ts": "24767d7aea58d3a44296a47be57471b04e0efe1a88d130f37ee8005c15f99d4b",
   "src/__tests__/fleet/fleet-phase5.test.ts": "5e7ecb5f3f73ffaa313cf017a9e3e031ac55984e5cc54cf1f6021b08cae8999d",
   "src/__tests__/fleet/fleet-phase6.test.ts": "579f9d85653e36dabe2a14c58e796f9c63a6fd93014440c1df1f851f78fb67cc",
   "src/__tests__/fleet/fleet-witness-imports.test.ts": "c5dd7d30ddbf42a4142f21e9442ef64edf8a38ceb4bd42f4bfab3682ba38812c",
   "src/__tests__/fleet/fleet-witness.test.ts": "0c2c2729757ae0fb3beb8e99fd02d8c7e97c8ab44cfbc348c2d13bbeddce4606",
   "src/__tests__/fleet/fleet.test.ts": "008de5c47fc188c87e565cfdac5f28389d83f38084b7ff2698302eea86ba1d1f",
   "src/__tests__/fleet/operator-canonical.test.ts": "795e68dcff4a8482ffaa09246f989420891a37a975058cf99827c2126c2fa3e4",
   "src/__tests__/fleet/operator-pg.test.ts": "567506898ecd28c47ad1fc2f364e7ee75e7322f912053e070f81f46e25d5fe46",
   "src/__tests__/fleet/operator-server.test.ts": "3b518c0453d168914d125edac64659cb9adbbfbfd4ca3dfd552fd99237b0f8ec",
   "src/__tests__/fleet/redact-sinks.test.ts": "9ef90ca7575de169dbce78ebc62d8375685725ecfcb099420f4d4bb1f454d8fd",
   "src/__tests__/fleet/redact.test.ts": "91aa1129663c8d4ffb199b3cf292c2764cd270045675530f7faf2575b5abc4e9"
  },
  "deployment_scripts": {
   "scripts/fleet-build-runtime.sh": "1d3bba87eb427e1c8b006e858a939694b51224ec3c003a54f1501da9b71031bc",
   "scripts/fleet-chatgpt-setup.sh": "4ce1eadb0d4edc5316830b2067bb5b48b175524ef94de0a07d71b7ce7e1b214d",
   "scripts/fleet-chatgpt-tunnel-key.sh": "9c8ff3d69423a1f3898c1de2b4266798d2fff38f675e510714d51c99be5570ff",
   "scripts/fleet-db-roles.sql": "fa80e6add2b8e48d39ca0c28f9c22a27d91c1cd4b0ef02c591fcccc4d5c32d95",
   "scripts/fleet-db-setup.sh": "15fc1b23843a2a6a4584a76286338c0b16397dd8bd32f7ca7e7a567a33152d76",
   "scripts/fleet-deploy-chatgpt-adapter.sh": "60bdca449e266ec50baeddcfe3a69b9dc1b76b44dfa59c407b2230a17ad28d11",
   "scripts/fleet-deploy-release.sh": "50d03dbe5440095dbb866b4c4d12d31049b0caf6c5576b06a057048189ee084f",
   "scripts/fleet-os-setup.sh": "df7919ad313401cdeb1871e41d5a60aa259ef13ec6fd6d376681778980cd795d",
   "scripts/fleet-verify-deployment.sh": "80e80a37784151ec5ecb241ce23f221a7aa145c44fdbb8edd508cba884e9b641"
  },
  "systemd_templates": {
   "deploy/systemd/automaton-agent.service": "e8f90f6dc23bb046419da45dcc66c900a5fb5e70f25c3b136c12f0dd9669205a",
   "deploy/systemd/automaton-fleet-chatgpt-adapter.service": "331a1422269b5248d9b3a4949dc83b37dba33865abb1e0eeb74906d32c4d54d7",
   "deploy/systemd/automaton-fleet-chatgpt-adapter.socket": "1ef46f613e5d7577f8768b49b81284cf63cf406c9716f1c9bd52be8d4dc3eb67",
   "deploy/systemd/automaton-fleet-chatgpt-tunnel.path": "69098a0b01906c4b6e90630a65dd64c03be4ff1fd642889df10a4cfbc2555d07",
   "deploy/systemd/automaton-fleet-chatgpt-tunnel.service": "8f2888c4d0b616e23e9e86adbd3721591e826a81b7be0941df50c81a4d04d7fd",
   "deploy/systemd/automaton-fleet-operator-api.service": "5f2454cf37accbba401eb5d624561d449360e88b622fe75c7db8789457b2d871",
   "deploy/systemd/automaton-fleet-witness.service": "b3447b8c26445f21dce2929ebd65dcd57fae6ae6a1eab22a22b343174e008b58",
   "deploy/systemd/automaton-fleet.service": "388f78e9b59bc9d4f7882d080eef2131448078189693c5533c4591428679d760",
   "deploy/systemd/automaton-fleet.service.d/remote.conf.example": "a90d9f396efdb8dee08a73cee2c914dacd65b7f84d8ebcc671416366a41991e2"
  },
  "configuration_templates": {
   "deploy/etc/admin.env.example": "57927daa1f938bf8f19c1834e89715f5c69f3df81473d5fd898e6b2ac074b5b8",
   "deploy/etc/operator.env.example": "f72d6f55d6925ee9c31b1909b4a5986fb2735ff4c246a8cbf1b2c273d5d8912b",
   "deploy/etc/runtime.env.example": "5fa32c4dcc4a3a1cbd038c34c7558e0642e554d5e04cfa2b9b36ab27286aca70",
   "deploy/etc/service.env.example": "24acb2e6c6171df9661ff65b352a64321d1b3266b4d6015c694cc71d1ddbd931",
   "deploy/firewall/fleet-firewall.sh": "2ddf4372715b1c7230dd06299f4d6366d6ccd8df27264a70b6cb00ced695f1f5",
   "deploy/logrotate/automaton-fleet": "6709a5401923f28fde0ca16478d460e62877a31edb7e1eecdceb559ac18f9238"
  },
  "build_configuration": {
   "package.json": "ca91918749e59afc5ee68cad9b9ebe5ab9d615a2c7ebe7ecacb0546d89713165",
   "pnpm-lock.yaml": "eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811",
   "pnpm-workspace.yaml": "0fb360452b0231d114d0b0ad6cc76bb48fe528382f55827cf93739bf64ec79e1",
   "tsconfig.json": "7a9a7c36771fcaaf2ca0f10ce03590d9d1b4e5957b67452630853cbc6184bd57",
   "vitest.config.ts": "f85ee8f218fec8c42fd1dd6e1653d63956cae42ece05ed2286404f7a852d6c44",
   ".gitignore": "aa30d8abf33a7728dc3e3040eecf588bb90af3753d637b3af6da35829abc466d"
  },
  "documentation": {
   "CLAUDE.md": "fd28399aa376fd73fccaa6a7452d5d5053ee78592f793421b198aa7990c486a9",
   "FLEET.md": "3fe9cef564562df98a130f40e41b99ba4c1dfff5c59c6ef10b909d4c67392a79",
   "ARCHITECTURE.md": "6947261d51e2da3598ad3c47b753d72216743baaa743d98f1e35fa7b2c41af7d",
   "DOCUMENTATION.md": "c02a31179cc2ff19d2d6bc1e9ad0b6a6ff7ef70adf3274f839d6e7f3b43e903c",
   "README.md": "fc1437dcaa218ec1c6998b0876da829d177b88bed68fc729640c283cb07911e0",
   "docs/design/phase-b-operator-api.md": "b56a598024cae88cae28b036c30179794f9674e4dc95f84074ae624741e74b57",
   "docs/design/phase-c-chatgpt-adapter.md": "1fd0f19699616b15ffbde62abd20fc5b6916d31ff19074b1170eb63366d18e53",
   "docs/design/phase-d-claude-bridge.md": "9422fda2ff89b3d6e6e6fdc2396435442ccb01c41498b2b705f04f5e8b303c1f",
   "docs/fleet-known-issues.md": "00bd3669b7c75b5890a963e9ffed51b5d0f70046920a7edda33a9612e27a1977",
   "docs/fleet-production-runbook.md": "b6b08f0298a4986dbd57c8887a82e8b3254ed6b329d73b2d077edec081c923d6"
  }
 },
 "release_history": [
  {
   "event": 8,
   "commit": "241dcf927d56e91e9e684f3aa15655d4bc2dd119",
   "build_id": "34c86eff2c6eab707642c79338670e239f65591084144b57d3e62b071cff0e4c"
  },
  {
   "event": 11,
   "commit": "11c0c7c02592d43a2c1350b779eaa795a237f3b7",
   "build_id": "e388571a140f7cb20e289e1e64d152571adea5f207c2290c09888f80f6e3c624"
  },
  {
   "event": 47,
   "commit": "cdfd70c842f43c8e3b8576ac07ebcd80cc3d4633",
   "build_id": "6d0eee3427415918d91d5a88b4fa8814cf1574c141226fb15bc6c7d41ac70d0c"
  },
  {
   "event": 59,
   "commit": "03f8760618335918011c74d88e3a81266281b7a3",
   "build_id": "955698a66bf777d8c4bc2ccbdfd37d882bfd733e90dd33e568f079a6c729ae12"
  },
  {
   "event": 74,
   "commit": "4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790",
   "build_id": "54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced"
  }
 ],
 "installed_production_unit_hashes": "NOT CAPTURED in this pass (no host access; see 14-PRODUCTION-SNAPSHOT.md section 0 and Appendix A). Operator record: the installed units were byte-identical to the repo templates at their deployment gates.",
 "secret_files_not_hashed": [
  "/etc/automaton-fleet/admin.env",
  "/etc/automaton-fleet/service.env",
  "/etc/automaton-fleet/operator.env",
  "/etc/automaton-fleet/tls/*",
  "/etc/automaton-fleet/chatgpt-tunnel/*",
  "ChatGPT adapter signing key",
  "~/.config/automaton-fleet/operator/*.key",
  "~/.ssh/*"
 ]
}
```
