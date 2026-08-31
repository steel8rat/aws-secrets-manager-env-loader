# aws-secrets-manager-env-loader

Load a map of **AWS Secrets Manager** secrets into `process.env` at boot.

- **Env wins over fetch.** Any env var that is already set is left alone and
  never fetched — so local dev can supply secrets with a plain `.env`-style
  export and **no AWS credentials at all**, while a deployed runtime (which has
  none of those set) always fetches using its execution role.
- **Fail fast.** Missing secrets are fetched in parallel; if any fetch or JSON
  parse fails the whole call rejects and `process.env` is left untouched. A
  service that boots with only some of its secrets is worse than one that
  refuses to boot.
- **JSON-blob aware.** A secret value can be a plain secret ID, or
  `{ secretId, key }` to pull one property out of a JSON secret — several env
  vars can share one `secretId` and it is fetched and parsed once.
- **The AWS SDK client is a `peerDependency`**, not bundled — you pick and
  upgrade `@aws-sdk/client-secrets-manager` on your own schedule, and it is
  never installed twice in your tree. Same convention AWS's own
  [`@aws-lambda-powertools/parameters`][powertools] uses for this client.

[powertools]: https://www.npmjs.com/package/@aws-lambda-powertools/parameters

## Install

```sh
npm install aws-secrets-manager-env-loader @aws-sdk/client-secrets-manager
```

`@aws-sdk/client-secrets-manager` is a peer dependency (`>=3.0.0`). Install it
yourself unless you will always pre-set every mapped env var (in which case no
fetch happens and the SDK is never loaded).

## Usage

```ts
import { loadSecrets } from "aws-secrets-manager-env-loader";

await loadSecrets({
  // env var name -> Secrets Manager secret ID
  secrets: {
    CHAT_BOT_TOKEN: "example/internal/chat/bot-token/sample-service",
    CHAT_APP_TOKEN: "example/internal/chat/app-token/sample-service",
    SERVICE_API_KEY: "example/internal/service/api-key/sample-service",
  },
});

// process.env.CHAT_BOT_TOKEN etc. are now populated. Start your server.
```

Call it once, early, and `await` it before you start serving traffic — this is
the "fail at boot, not on the first request" pattern.

### Local development without AWS

Set the same env vars any way you like — a shell export, a `.env` file loaded by
your process manager, `agentcore/.env.local`, etc. Because **env wins**,
`loadSecrets()` sees them already present and skips Secrets Manager entirely. No
credentials, no VPN, no IAM.

## API

```ts
function loadSecrets(options: LoadSecretsOptions): Promise<void>;

interface LoadSecretsOptions {
  /** Map of env var name -> where to get its value. */
  secrets: Record<string, SecretSource>;

  /**
   * Pre-constructed client. Supply this to control region, credentials,
   * retry/backoff, or the exact SDK version. If omitted, a SecretsManagerClient
   * is constructed lazily on first fetch (region from AWS_REGION, else
   * us-east-1; default credential chain).
   */
  client?: SecretsManagerClient | SecretsManagerClientLike;

  /** Progress messages. Defaults to console.log; pass `() => {}` to silence. */
  onLog?: (message: string) => void;
}

type SecretSource =
  | string                            // secret ID; whole SecretString is the value
  | { secretId: string; key?: string }; // fetch secretId, take `key` from its JSON object
```

Supplying your own client:

```ts
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { loadSecrets } from "aws-secrets-manager-env-loader";

await loadSecrets({
  secrets: { SERVICE_API_KEY: "example/internal/service/api-key/sample-service" },
  client: new SecretsManagerClient({ region: "eu-west-1", maxAttempts: 5 }),
});
```

### JSON-blob secrets

A single Secrets Manager secret often holds a JSON object of several values
(the console's "Other type of secret" → key/value editor stores it this way, and
RDS-managed secrets look like `{"username":"...","password":"..."}`). Point
multiple env vars at keys of the same `secretId` — it is fetched and parsed
**once**:

```ts
await loadSecrets({
  secrets: {
    DB_USERNAME: { secretId: "example/db/creds", key: "username" },
    DB_PASSWORD: { secretId: "example/db/creds", key: "password" },
    DB_PORT:     { secretId: "example/db/creds", key: "port" }, // 5432 -> "5432"
    // plain string still means "use the whole SecretString"
    SERVICE_API_KEY: "example/internal/service/api-key/sample-service",
  },
});
```

Non-string key values are `JSON.stringify`-d before being written (numbers become
their digits, objects/arrays become JSON). A missing key throws
`SecretKeyNotFoundError`; a secret that is not a JSON object throws
`SecretJsonParseError`. **Env still wins** — a keyed env var that is already set
is neither fetched nor parsed.

### Semantics

| Aspect | Behavior |
| --- | --- |
| Env var already set to a **non-empty** value | Kept — not fetched, not parsed |
| Env var unset or **empty string** | Fetched and written |
| Multiple env vars, one `secretId` | Fetched once, parsed once, in parallel with other secrets (`Promise.all`) |
| Any fetch or JSON parse fails | Whole call rejects, `process.env` **unmodified** (fail fast — no partial-load mode) |
| Secret has no `SecretString` (binary-only) | Throws `MissingSecretStringError` |
| Keyed source, key absent from the JSON object | Throws `SecretKeyNotFoundError` |
| Keyed source, `SecretString` is not a JSON object | Throws `SecretJsonParseError` |
| Default client needed but peer dep not installed | Throws `SdkNotInstalledError` |
| Nothing missing | Returns immediately; SDK never loaded |

Exports: `loadSecrets`, `MissingSecretStringError`, `SecretJsonParseError`,
`SecretKeyNotFoundError`, `SdkNotInstalledError`, and the types
`LoadSecretsOptions`, `SecretSource`, `SecretsManagerClientLike`.

## Migrating from a hardcoded loader

If you have the common hand-rolled version — a fixed `SECRET_MAP`, a
module-scope client, `Promise.all`, env-wins — the diff is:

```diff
-import {
-  SecretsManagerClient,
-  GetSecretValueCommand,
-} from "@aws-sdk/client-secrets-manager";
-
-const SECRET_MAP = {
-  CHAT_BOT_TOKEN: "example/internal/chat/bot-token/sample-service",
-  CHAT_APP_TOKEN: "example/internal/chat/app-token/sample-service",
-  CHAT_SIGNING_SECRET: "example/internal/chat/signing-secret/sample-service",
-  SERVICE_API_KEY: "example/internal/service/api-key/sample-service",
-} as const;
-
-const client = new SecretsManagerClient({
-  region: process.env.AWS_REGION ?? "us-east-1",
-});
-
-async function fetchSecret(secretId: string): Promise<string> {
-  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
-  if (!res.SecretString) throw new Error(`secret ${secretId} has no SecretString`);
-  return res.SecretString;
-}
-
-export async function loadSecrets(): Promise<void> {
-  const missing = (Object.keys(SECRET_MAP) as (keyof typeof SECRET_MAP)[]).filter(
-    (envVar) => !process.env[envVar],
-  );
-  if (missing.length === 0) return;
-  const results = await Promise.all(
-    missing.map(async (envVar) => [envVar, await fetchSecret(SECRET_MAP[envVar])] as const),
-  );
-  for (const [envVar, value] of results) process.env[envVar] = value;
-}
+import { loadSecrets } from "aws-secrets-manager-env-loader";
+
+export async function loadAppSecrets(): Promise<void> {
+  await loadSecrets({
+    secrets: {
+      CHAT_BOT_TOKEN: "example/internal/chat/bot-token/sample-service",
+      CHAT_APP_TOKEN: "example/internal/chat/app-token/sample-service",
+      CHAT_SIGNING_SECRET: "example/internal/chat/signing-secret/sample-service",
+      SERVICE_API_KEY: "example/internal/service/api-key/sample-service",
+    },
+  });
+}
```

`@aws-sdk/client-secrets-manager` stays exactly where it already is in your
app's `package.json` — this package just stops shipping its own copy.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit over src + test
npm test            # node --test (runs the TypeScript tests directly)
npm run build       # tsup -> dist/ (ESM + CJS + .d.ts)
```

The test suite runs on Node's built-in runner with native type stripping, so it
needs Node ≥ 22.18 (or ≥ 23.6). The **published** package is plain compiled
JavaScript and only requires Node ≥ 18.

## License

MIT
