import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  loadSecrets,
  SecretJsonParseError,
  SecretKeyNotFoundError,
  type SecretsManagerClientLike,
} from "../src/index.ts";
import {
  __setSdkImporterForTests,
  type SecretsManagerSdk,
} from "../src/sdk.ts";

class FakeCommand {
  input: { SecretId: string };
  constructor(input: { SecretId: string }) {
    this.input = input;
  }
}

function stubClient(
  responses: Record<string, string>,
): SecretsManagerClientLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(command: unknown) {
      const secretId = (command as FakeCommand).input.SecretId;
      calls.push(secretId);
      const canned = responses[secretId];
      if (canned === undefined) {
        throw new Error(`unexpected SecretId in test: ${secretId}`);
      }
      return { SecretString: canned };
    },
  };
}

const ENV_KEYS = ["DB_USERNAME", "DB_PASSWORD", "DB_PORT", "DB_OPTIONS", "OTHER"];

beforeEach(() => {
  __setSdkImporterForTests(
    async () =>
      ({ GetSecretValueCommand: FakeCommand }) as unknown as SecretsManagerSdk,
  );
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  __setSdkImporterForTests(undefined);
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("JSON-blob secrets", () => {
  it("extracts a single key from a JSON secret", async () => {
    const client = stubClient({
      "db/creds": JSON.stringify({ username: "admin", password: "s3cr3t" }),
    });

    await loadSecrets({
      secrets: { DB_PASSWORD: { secretId: "db/creds", key: "password" } },
      client,
    });

    assert.equal(process.env.DB_PASSWORD, "s3cr3t");
  });

  it("fetches and parses a shared secret exactly once for multiple keys", async () => {
    const client = stubClient({
      "db/creds": JSON.stringify({
        username: "admin",
        password: "s3cr3t",
        port: 5432,
        options: { ssl: true },
      }),
    });

    await loadSecrets({
      secrets: {
        DB_USERNAME: { secretId: "db/creds", key: "username" },
        DB_PASSWORD: { secretId: "db/creds", key: "password" },
        DB_PORT: { secretId: "db/creds", key: "port" },
        DB_OPTIONS: { secretId: "db/creds", key: "options" },
      },
      client,
    });

    assert.deepEqual(client.calls, ["db/creds"]);
    assert.equal(process.env.DB_USERNAME, "admin");
    assert.equal(process.env.DB_PASSWORD, "s3cr3t");
    // non-string values are JSON.stringify-d
    assert.equal(process.env.DB_PORT, "5432");
    assert.equal(process.env.DB_OPTIONS, '{"ssl":true}');
  });

  it("mixes whole-string and keyed sources in one call", async () => {
    const client = stubClient({
      "db/creds": JSON.stringify({ username: "admin" }),
      "svc/api-key": "raw-api-key",
    });

    await loadSecrets({
      secrets: {
        DB_USERNAME: { secretId: "db/creds", key: "username" },
        OTHER: "svc/api-key",
      },
      client,
    });

    assert.equal(process.env.DB_USERNAME, "admin");
    assert.equal(process.env.OTHER, "raw-api-key");
  });

  it("throws SecretKeyNotFoundError when the key is absent", async () => {
    const client = stubClient({
      "db/creds": JSON.stringify({ username: "admin" }),
    });

    await assert.rejects(
      loadSecrets({
        secrets: { DB_PASSWORD: { secretId: "db/creds", key: "password" } },
        client,
      }),
      (err: unknown) =>
        err instanceof SecretKeyNotFoundError &&
        err.key === "password" &&
        err.envVar === "DB_PASSWORD",
    );
    assert.equal(process.env.DB_PASSWORD, undefined);
  });

  it("throws SecretJsonParseError when the SecretString is not JSON", async () => {
    const client = stubClient({ "db/creds": "not json at all" });

    await assert.rejects(
      loadSecrets({
        secrets: { DB_USERNAME: { secretId: "db/creds", key: "username" } },
        client,
      }),
      SecretJsonParseError,
    );
  });

  it("throws SecretJsonParseError when the JSON is not an object", async () => {
    const client = stubClient({ "db/creds": "[1,2,3]" });

    await assert.rejects(
      loadSecrets({
        secrets: { DB_USERNAME: { secretId: "db/creds", key: "0" } },
        client,
      }),
      SecretJsonParseError,
    );
  });

  it("does not fetch or parse when the keyed env var is already set", async () => {
    process.env.DB_PASSWORD = "local-pw";
    const client = stubClient({});

    await loadSecrets({
      secrets: { DB_PASSWORD: { secretId: "db/creds", key: "password" } },
      client,
    });

    assert.deepEqual(client.calls, []);
    assert.equal(process.env.DB_PASSWORD, "local-pw");
  });
});
