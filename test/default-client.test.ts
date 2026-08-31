import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadSecrets, SdkNotInstalledError } from "../src/index.ts";
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

/** Records every config the loader constructs a client with. */
const ctorConfigs: Array<Record<string, unknown>> = [];

class FakeClient {
  constructor(config: Record<string, unknown>) {
    ctorConfigs.push(config);
  }
  async send(command: FakeCommand) {
    return { SecretString: `value:${command.input.SecretId}` };
  }
}

function useFakeSdk(): void {
  __setSdkImporterForTests(
    async () =>
      ({
        SecretsManagerClient: FakeClient,
        GetSecretValueCommand: FakeCommand,
      }) as unknown as SecretsManagerSdk,
  );
}

beforeEach(() => {
  ctorConfigs.length = 0;
  delete process.env.A_TOKEN;
  delete process.env.AWS_REGION;
});
afterEach(() => {
  __setSdkImporterForTests(undefined);
  delete process.env.A_TOKEN;
  delete process.env.AWS_REGION;
});

describe("lazy default client", () => {
  it("constructs a client with the region from AWS_REGION", async () => {
    useFakeSdk();
    process.env.AWS_REGION = "eu-west-1";

    await loadSecrets({ secrets: { A_TOKEN: "sm/a" } });

    assert.deepEqual(ctorConfigs, [{ region: "eu-west-1" }]);
    assert.equal(process.env.A_TOKEN, "value:sm/a");
  });

  it("falls back to us-east-1 when AWS_REGION is unset", async () => {
    useFakeSdk();

    await loadSecrets({ secrets: { A_TOKEN: "sm/a" } });

    assert.deepEqual(ctorConfigs, [{ region: "us-east-1" }]);
  });

  it("does not construct a client when nothing is missing", async () => {
    useFakeSdk();
    process.env.A_TOKEN = "preset";

    await loadSecrets({ secrets: { A_TOKEN: "sm/a" } });

    assert.deepEqual(ctorConfigs, []);
  });
});

describe("missing peer dependency", () => {
  it("throws SdkNotInstalledError when a fetch is needed but the SDK is absent", async () => {
    __setSdkImporterForTests(async () => {
      throw new Error("Cannot find package '@aws-sdk/client-secrets-manager'");
    });

    await assert.rejects(
      loadSecrets({ secrets: { A_TOKEN: "sm/a" } }),
      SdkNotInstalledError,
    );
  });

  it("still succeeds without the SDK when every env var is already set", async () => {
    __setSdkImporterForTests(async () => {
      throw new Error("Cannot find package");
    });
    process.env.A_TOKEN = "preset";

    await loadSecrets({ secrets: { A_TOKEN: "sm/a" } });

    assert.equal(process.env.A_TOKEN, "preset");
  });
});
