import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  loadSecrets,
  MissingSecretStringError,
  type SecretsManagerClientLike,
} from "../src/index.ts";
import {
  __setSdkImporterForTests,
  type SecretsManagerSdk,
} from "../src/sdk.ts";

/** Stand-in for GetSecretValueCommand: just captures its input. */
class FakeCommand {
  input: { SecretId: string };
  constructor(input: { SecretId: string }) {
    this.input = input;
  }
}

/** Feed a fake SDK so tests never touch the real client. */
function useFakeSdk(): void {
  __setSdkImporterForTests(
    async () =>
      ({ GetSecretValueCommand: FakeCommand }) as unknown as SecretsManagerSdk,
  );
}

/** A client whose `send` looks up a canned response by SecretId. */
function stubClient(
  responses: Record<string, { SecretString?: string } | Error>,
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
      if (canned instanceof Error) throw canned;
      return canned;
    },
  };
}

const ENV_KEYS = ["A_TOKEN", "B_TOKEN", "C_TOKEN"];

beforeEach(() => {
  useFakeSdk();
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  __setSdkImporterForTests(undefined);
  mock.restoreAll();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("env wins over fetch", () => {
  it("never touches the client when every mapped env var is already set", async () => {
    process.env.A_TOKEN = "local-a";
    process.env.B_TOKEN = "local-b";
    const client = stubClient({});
    const onLog = mock.fn();

    await loadSecrets({
      secrets: { A_TOKEN: "sm/a", B_TOKEN: "sm/b" },
      client,
      onLog,
    });

    assert.deepEqual(client.calls, []);
    assert.equal(process.env.A_TOKEN, "local-a");
    assert.equal(process.env.B_TOKEN, "local-b");
    assert.deepEqual(onLog.mock.calls[0]?.arguments, [
      "[secrets] all secrets already in env, skipping fetch",
    ]);
  });

  it("fetches only the missing ones and leaves preset values alone", async () => {
    process.env.A_TOKEN = "local-a";
    const client = stubClient({
      "sm/b": { SecretString: "fetched-b" },
      "sm/c": { SecretString: "fetched-c" },
    });

    await loadSecrets({
      secrets: { A_TOKEN: "sm/a", B_TOKEN: "sm/b", C_TOKEN: "sm/c" },
      client,
    });

    assert.deepEqual(client.calls.sort(), ["sm/b", "sm/c"]);
    assert.equal(process.env.A_TOKEN, "local-a");
    assert.equal(process.env.B_TOKEN, "fetched-b");
    assert.equal(process.env.C_TOKEN, "fetched-c");
  });

  it("treats an empty-string env var as missing", async () => {
    process.env.A_TOKEN = "";
    const client = stubClient({ "sm/a": { SecretString: "fetched-a" } });

    await loadSecrets({ secrets: { A_TOKEN: "sm/a" }, client });

    assert.deepEqual(client.calls, ["sm/a"]);
    assert.equal(process.env.A_TOKEN, "fetched-a");
  });
});

describe("failure modes", () => {
  it("throws MissingSecretStringError when a fetched secret has no SecretString", async () => {
    const client = stubClient({ "sm/a": {} });

    await assert.rejects(
      loadSecrets({ secrets: { A_TOKEN: "sm/a" }, client }),
      MissingSecretStringError,
    );
    assert.equal(process.env.A_TOKEN, undefined);
  });

  it("fails fast: one rejected fetch rejects the whole call and writes nothing", async () => {
    const client = stubClient({
      "sm/a": { SecretString: "fetched-a" },
      "sm/b": new Error("AccessDeniedException"),
    });

    await assert.rejects(
      loadSecrets({ secrets: { A_TOKEN: "sm/a", B_TOKEN: "sm/b" }, client }),
      /AccessDeniedException/,
    );

    assert.equal(process.env.A_TOKEN, undefined);
    assert.equal(process.env.B_TOKEN, undefined);
  });
});

describe("fetch behavior", () => {
  it("passes each secret ID through as the GetSecretValueCommand SecretId", async () => {
    const seen: string[] = [];
    const client: SecretsManagerClientLike = {
      async send(command: unknown) {
        seen.push((command as FakeCommand).input.SecretId);
        return { SecretString: "x" };
      },
    };

    await loadSecrets({
      secrets: { A_TOKEN: "path/to/a", B_TOKEN: "path/to/b" },
      client,
    });

    assert.deepEqual(seen.sort(), ["path/to/a", "path/to/b"]);
  });

  it("dispatches all fetches in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    const client: SecretsManagerClientLike = {
      send() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          release.push(() => {
            inFlight--;
            resolve({ SecretString: "x" });
          });
        });
      },
    };

    const p = loadSecrets({
      secrets: { A_TOKEN: "sm/a", B_TOKEN: "sm/b", C_TOKEN: "sm/c" },
      client,
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(maxInFlight, 3);
    for (const r of release) r();
    await p;
  });

  it("uses console.log by default", async () => {
    const logged: string[] = [];
    mock.method(console, "log", (msg: string) => void logged.push(msg));

    await loadSecrets({
      secrets: { A_TOKEN: "sm/a" },
      client: stubClient({ "sm/a": { SecretString: "v" } }),
    });

    assert.ok(logged.includes("[secrets] fetching from Secrets Manager: A_TOKEN"));
    assert.ok(logged.includes("[secrets] provisioned into env: A_TOKEN"));
  });
});
