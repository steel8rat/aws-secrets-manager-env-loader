import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** Thrown when the AWS SDK client peer dependency cannot be resolved at runtime. */
export class SdkNotInstalledError extends Error {
  constructor(cause: unknown) {
    super(
      "aws-secrets-manager-env-loader: could not load '@aws-sdk/client-secrets-manager'. " +
        "It is a peer dependency - install it in your app to use the default client, " +
        "or pass an explicit `client`. (If every mapped env var is already set, no fetch " +
        "happens and the SDK is never needed.) " +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "SdkNotInstalledError";
  }
}

export type SecretsManagerSdk = typeof import("@aws-sdk/client-secrets-manager");

const realImport = (): Promise<SecretsManagerSdk> =>
  import("@aws-sdk/client-secrets-manager");

let importSdk: () => Promise<SecretsManagerSdk> = realImport;
let sdkPromise: Promise<SecretsManagerSdk> | undefined;
let defaultClientPromise: Promise<SecretsManagerClient> | undefined;

/**
 * Load `@aws-sdk/client-secrets-manager` lazily and only once. Kept out of
 * module scope so that importing this package never requires the peer
 * dependency - only an actual fetch does.
 */
export async function loadSdk(): Promise<SecretsManagerSdk> {
  if (!sdkPromise) {
    sdkPromise = importSdk().catch((err: unknown) => {
      sdkPromise = undefined;
      throw new SdkNotInstalledError(err);
    });
  }
  return sdkPromise;
}

/**
 * A `SecretsManagerClient` constructed lazily on first use, with its region from
 * `AWS_REGION` (falling back to `us-east-1`) and default-chain credentials.
 */
export async function getDefaultClient(): Promise<SecretsManagerClient> {
  if (!defaultClientPromise) {
    defaultClientPromise = (async () => {
      const { SecretsManagerClient } = await loadSdk();
      return new SecretsManagerClient({
        region: process.env.AWS_REGION ?? "us-east-1",
      });
    })().catch((err: unknown) => {
      defaultClientPromise = undefined;
      throw err;
    });
  }
  return defaultClientPromise;
}

/**
 * Test seam. Deliberately NOT re-exported from `index.ts`, so it never reaches
 * the published entry point or type definitions. Swaps how the AWS SDK is
 * imported and clears the memoized SDK + default client. Pass `undefined` to
 * restore the real dynamic import.
 *
 * @internal
 */
export function __setSdkImporterForTests(
  fn: (() => Promise<SecretsManagerSdk>) | undefined,
): void {
  importSdk = fn ?? realImport;
  sdkPromise = undefined;
  defaultClientPromise = undefined;
}
