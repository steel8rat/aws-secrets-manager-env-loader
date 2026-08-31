import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getDefaultClient, loadSdk, SdkNotInstalledError } from "./sdk.ts";

export { SdkNotInstalledError };

/**
 * The minimal shape this package needs from a Secrets Manager client: a `send`
 * method that resolves a `GetSecretValueCommand` to something carrying a
 * `SecretString`. The real `SecretsManagerClient` satisfies this, and so does
 * any stub with a compatible `send` (handy for tests).
 */
export interface SecretsManagerClientLike {
  send(command: unknown): Promise<{ SecretString?: string }>;
}

/**
 * How to source one env var's value:
 *
 * - a plain **string** is a Secrets Manager secret ID whose entire
 *   `SecretString` becomes the value;
 * - **`{ secretId, key }`** fetches `secretId`, parses its `SecretString` as a
 *   JSON object, and writes property `key` (non-string values are
 *   `JSON.stringify`-d). Several env vars may read different keys of the same
 *   `secretId` - it is fetched and parsed exactly once.
 */
export type SecretSource =
  | string
  | {
      /** Secrets Manager secret ID. */
      secretId: string;
      /**
       * Property to read from the secret's JSON object. Omit to use the whole
       * `SecretString` verbatim.
       */
      key?: string;
    };

export interface LoadSecretsOptions {
  /**
   * Map of env var name -> where to get its value. See {@link SecretSource}.
   *
   * @example
   * {
   *   // whole SecretString
   *   SERVICE_API_KEY: "example/internal/service/api-key/sample-service",
   *   // two keys out of one JSON secret, fetched once
   *   DB_USERNAME: { secretId: "example/db/creds", key: "username" },
   *   DB_PASSWORD: { secretId: "example/db/creds", key: "password" },
   * }
   */
  secrets: Record<string, SecretSource>;
  /**
   * Pre-constructed client. Supply this to control region, credentials,
   * retry/backoff, or the exact SDK version in play. If omitted, a
   * `SecretsManagerClient` is constructed lazily on first fetch (region from
   * `AWS_REGION`, else `us-east-1`; default credential chain).
   */
  client?: SecretsManagerClient | SecretsManagerClientLike;
  /**
   * Called with human-readable progress messages. Defaults to `console.log`.
   * Pass `() => {}` to silence, or route through your own logger.
   */
  onLog?: (message: string) => void;
}

/** Thrown when a fetched secret exists but carries no `SecretString`. */
export class MissingSecretStringError extends Error {
  readonly secretId: string;
  constructor(secretId: string) {
    super(
      `aws-secrets-manager-env-loader: secret "${secretId}" has no SecretString`,
    );
    this.name = "MissingSecretStringError";
    this.secretId = secretId;
  }
}

/** Thrown when a keyed source points at a secret whose `SecretString` is not a JSON object. */
export class SecretJsonParseError extends Error {
  readonly secretId: string;
  constructor(secretId: string, cause: unknown) {
    super(
      `aws-secrets-manager-env-loader: secret "${secretId}" is not a JSON object`,
      { cause },
    );
    this.name = "SecretJsonParseError";
    this.secretId = secretId;
  }
}

/** Thrown when a keyed source names a property missing from the secret's JSON object. */
export class SecretKeyNotFoundError extends Error {
  readonly secretId: string;
  readonly key: string;
  readonly envVar: string;
  constructor(secretId: string, key: string, envVar: string) {
    super(
      `aws-secrets-manager-env-loader: key "${key}" (for env var ${envVar}) is not present in JSON secret "${secretId}"`,
    );
    this.name = "SecretKeyNotFoundError";
    this.secretId = secretId;
    this.key = key;
    this.envVar = envVar;
  }
}

/**
 * Load the mapped secrets into `process.env`.
 *
 * Behavior, deliberately matching the small boot-time loader this package was
 * extracted from:
 *
 * - **Env wins over fetch.** Any env var already set to a non-empty value is
 *   left untouched and never fetched. This lets local dev supply secrets via a
 *   `.env`-style export with no AWS credentials at all, while a deployed runtime
 *   (which has none of those set) always fetches using its execution role.
 * - **Fetch only what is missing.** Each distinct secret ID is fetched once,
 *   in parallel, even when several env vars read different keys from it.
 * - **Fail fast.** Fetching uses `Promise.all`, so if any single fetch or JSON
 *   parse fails, the whole call rejects and `process.env` is left unmodified.
 *   A service that boots with only some of its secrets is worse than one that
 *   refuses to boot. There is no partial-load mode.
 *
 * Call this once, early, and `await` it before starting your server / handler.
 */
export async function loadSecrets(options: LoadSecretsOptions): Promise<void> {
  const { secrets, onLog = defaultLog } = options;

  const missing = Object.keys(secrets).filter(
    (envVar) => !process.env[envVar],
  );
  if (missing.length === 0) {
    onLog("[secrets] all secrets already in env, skipping fetch");
    return;
  }

  onLog(`[secrets] fetching from Secrets Manager: ${missing.join(", ")}`);

  const { GetSecretValueCommand } = await loadSdk();
  const client = options.client ?? (await getDefaultClient());

  const sources = new Map(
    missing.map((envVar) => [envVar, normalize(secrets[envVar]!)] as const),
  );
  const distinctIds = [
    ...new Set([...sources.values()].map((source) => source.secretId)),
  ];

  const rawById = new Map<string, string>();
  await Promise.all(
    distinctIds.map(async (secretId) => {
      const res = await client.send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      if (!res.SecretString) throw new MissingSecretStringError(secretId);
      rawById.set(secretId, res.SecretString);
    }),
  );

  const jsonById = new Map<string, Record<string, unknown>>();
  const parseJsonSecret = (secretId: string): Record<string, unknown> => {
    const cached = jsonById.get(secretId);
    if (cached) return cached;
    let value: unknown;
    try {
      value = JSON.parse(rawById.get(secretId)!);
    } catch (err) {
      throw new SecretJsonParseError(secretId, err);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new SecretJsonParseError(
        secretId,
        new Error("SecretString is not a JSON object"),
      );
    }
    const parsed = value as Record<string, unknown>;
    jsonById.set(secretId, parsed);
    return parsed;
  };

  const resolved = missing.map((envVar) => {
    const { secretId, key } = sources.get(envVar)!;
    if (key === undefined) {
      return [envVar, rawById.get(secretId)!] as const;
    }
    const parsed = parseJsonSecret(secretId);
    if (!(key in parsed)) {
      throw new SecretKeyNotFoundError(secretId, key, envVar);
    }
    const value = parsed[key];
    return [
      envVar,
      typeof value === "string" ? value : JSON.stringify(value),
    ] as const;
  });

  for (const [envVar, value] of resolved) {
    process.env[envVar] = value;
  }
  onLog(`[secrets] provisioned into env: ${missing.join(", ")}`);
}

function normalize(source: SecretSource): { secretId: string; key?: string } {
  return typeof source === "string" ? { secretId: source } : source;
}

function defaultLog(message: string): void {
  console.log(message);
}
