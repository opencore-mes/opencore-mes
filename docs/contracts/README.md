# OpenCore MES contracts

Every way into OpenCore MES that something outside the core builds on is a published, versioned
contract: a specification a person reads, a machine-readable schema beside it, and a conformance kit
anyone runs against what they built. The internals (the store, the database, the policy engine's
functions, the framework) are not a contract and nothing outside the core may use them.

| Contract | Who builds on it | Version | Here |
| --- | --- | --- | --- |
| `equipment-adapter` | One adapter per protocol: what holds the link to a machine (SECS/GEM over HSMS, OPC UA, MQTT, …) | 1.0 | [`equipment-adapter/`](equipment-adapter/README.md): specification, `schema.json`, `kit.mjs` |
| `http-apis` | Outside systems calling `/svc/v1`, AI agents calling `/ai/v1` | 1.1 | [`http-apis/`](http-apis/README.md): what `/v1` promises, `API-Version`, notice before a change, `kit.mjs` (the API kit) |
| `embedding` | A site the plant names that shows OpenCore MES in a frame beside its own content (a course, a work instruction) | 1.0 | [`embedding/`](embedding/README.md): `EMBED_ORIGINS`, the window messages (where the person is; outline by visible name), `kit.mjs` |
| `core-api` | Suites | planned | today a suite is handed the core's context (see the developer's guide) |

## How a contract changes

- **Semantic versions, per contract.** A minor version adds (a new call, a new optional field); a
  major version may remove or change. Each contract's `CHANGELOG.md` lists its versions.
- **Declared.** What builds on a contract says which version it implements (an adapter's `contract`),
  and what loads it refuses one it does not satisfy, saying why.
- **Deprecated before removed.** What a major version will remove is marked deprecated in a minor
  one first and kept for at least two releases of the core.
- **Read by AI too.** The AI design API's `get_contract` serves each contract by name (`GET
  /ai/v1/contracts/equipment-adapter`), so an agent builds on the contract the core provides.
