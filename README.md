# aws-secrets-manager-env-loader

Load a map of AWS Secrets Manager secrets into `process.env` at boot.

- **Env wins.** An env var already set to a non-empty value is kept, not fetched.
  Local dev supplies values via the environment and never calls AWS.
- **Fail fast.** Missing secrets are fetched in parallel; if any fetch or JSON
  parse fails, the call rejects and `process.env` is left unmodified. No
  partial-load mode.
- **JSON blobs.** A value is either a secret ID (whole `SecretString`) or
  `{ secretId, key }` (one property of a JSON secret). Env vars sharing a
  `secretId` fetch and parse it once.
- **Peer dependency.** `@aws-sdk/client-secrets-manager` is not bundled; you
  choose and upgrade the version. Same convention as
  [`@aws-lambda-powertools/parameters`][powertools].

[powertools]: https://www.npmjs.com/package/@aws-lambda-powertools/parameters

## Install

```sh
npm install aws-secrets-manager-env-loader @aws-sdk/client-secrets-manager
```

The peer dependency (`>=3.0.0`) is only loaded when a fetch actually happens, so
it can be skipped if every mapped var is always pre-set in the environment.

## Usage

```ts
import { loadSecrets } from "aws-secrets-manager-env-loader";

await loadSecrets({
  secrets: {
    CHAT_BOT_TOKEN: "example/internal/chat/bot-token/sample-service",
    SERVICE_API_KEY: "example/internal/service/api-key/sample-service",
  },
});
```

Call it once and `await` it before the rest of the app reads those vars.

### Ordering

The loader reads `process.env` only — it does not parse `.env` files. For "env
wins" to apply locally, the values must be in `process.env` *before* the call.
Load them first:

```sh
node --env-file=.env dist/app.js
```

```ts
import "dotenv/config"; // before importing anything that calls loadSecrets
```

Otherwise the var looks missing and the loader tries to fetch it (and throws
without credentials).

## API

```ts
function loadSecrets(options: LoadSecretsOptions): Promise<void>;

interface LoadSecretsOptions {
  secrets: Record<string, SecretSource>;
  /**
   * Pre-constructed client, for control over region, credentials, retry, or SDK
   * version. Default: constructed lazily on first fetch (region from
   * AWS_REGION, else us-east-1; default credential chain).
   */
  client?: SecretsManagerClient | SecretsManagerClientLike;
  /** Progress messages. Default: console.log. Pass `() => {}` to silence. */
  onLog?: (message: string) => void;
}

type SecretSource =
  | string                              // secret ID; whole SecretString
  | { secretId: string; key?: string }; // one key of a JSON secret
```

Supplying a client:

```ts
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

await loadSecrets({
  secrets: { SERVICE_API_KEY: "example/internal/service/api-key/sample-service" },
  client: new SecretsManagerClient({ region: "eu-west-1", maxAttempts: 5 }),
});
```

### JSON-blob secrets

For a secret holding a JSON object (the console's key/value editor, RDS-managed
secrets), point multiple vars at keys of one `secretId`:

```ts
await loadSecrets({
  secrets: {
    DB_USERNAME: { secretId: "example/db/creds", key: "username" },
    DB_PASSWORD: { secretId: "example/db/creds", key: "password" },
    DB_PORT:     { secretId: "example/db/creds", key: "port" }, // 5432 -> "5432"
    SERVICE_API_KEY: "example/internal/service/api-key/sample-service",
  },
});
```

Non-string values are `JSON.stringify`-d before writing.

### Semantics

| Case | Behavior |
| --- | --- |
| Env var set to a non-empty value | Kept; not fetched or parsed |
| Env var unset or empty string | Fetched and written |
| Several env vars, one `secretId` | Fetched once, parsed once, in parallel with other secrets |
| Any fetch or JSON parse fails | Call rejects; `process.env` unmodified |
| Secret has no `SecretString` | `MissingSecretStringError` |
| Keyed source, key not in the JSON object | `SecretKeyNotFoundError` |
| Keyed source, `SecretString` not a JSON object | `SecretJsonParseError` |
| Default client needed, peer dep not installed | `SdkNotInstalledError` |
| Nothing missing | Returns immediately; SDK not loaded |

Exports: `loadSecrets`, `MissingSecretStringError`, `SecretJsonParseError`,
`SecretKeyNotFoundError`, `SdkNotInstalledError`, and the types
`LoadSecretsOptions`, `SecretSource`, `SecretsManagerClientLike`.

## Development

```sh
npm install
npm run typecheck
npm test          # node --test
npm run build     # tsup -> dist/ (ESM + CJS + .d.ts)
```

Tests use Node's runner with native type stripping (Node >=22.18 / >=23.6). The
published package is compiled JavaScript and requires Node >=18.

## License

MIT
