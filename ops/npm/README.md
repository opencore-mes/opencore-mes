# npm packages

`node ops/npm/build.mjs` stages and packs, into `.local/npm/` (kept out of git):

| Package | From | Version |
| --- | --- | --- |
| `@opencore-mes/juris-kit` | Juris, packed in its own repository (`JURIS_KIT_DIR`, `../juris-kit` by default) | 0.91.1 |
| `@opencore-mes/server` | `app/mes`, `docs/contracts`, the script runner's sandbox, and the framework bundled at the version installed here (`bundleDependencies`: an installation runs the framework it was tested with, offline too); the `opencore-mes` command (`app/mes/cli.mjs`) | 0.1.1 |
| `@opencore-mes/equipment-adapter` | `docs/contracts/equipment-adapter` | 1.0.0 |
| `@opencore-mes/http-apis` | `docs/contracts/http-apis` | 1.0.0 |

The versions are in `build.mjs`. A contract package's major version is the contract's: a change its
CHANGELOG calls breaking is a new major version, under the notice its README promises.

The script never publishes. To publish, a maintainer:

1. runs `npm ci` and `npm run test:all`, then `node ops/npm/build.mjs`;
2. checks a tarball before it goes out: `tar tzf .local/npm/<file>.tgz`, then installs the server's
   into an empty folder and runs `opencore-mes init`, `db reset --yes` (with a database of its own) and
   `start`;
3. publishes the packages from their staged folders, signed in to npm as a member of the `opencore-mes`
   organisation: `cd .local/npm/<package> && npm publish --access public`.

The framework is `@opencore-mes/juris-kit` for now: the name `juris` on npm is the earlier framework's
(its `latest` is 0.9.0), which sites still run.
