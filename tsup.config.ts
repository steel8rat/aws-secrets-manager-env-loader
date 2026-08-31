import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  // The AWS SDK client is a peer dependency and is only ever loaded via a
  // dynamic import at fetch time - never bundle it.
  external: ["@aws-sdk/client-secrets-manager"],
});
