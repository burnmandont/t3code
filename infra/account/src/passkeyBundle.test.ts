import { describe, expect, it } from "@effect/vitest";
import { build } from "esbuild";
import { createRequire } from "node:module";

describe("passkey bundle", () => {
  it("parses ECDSA signatures with one ASN.1 schema registry", async () => {
    const require = createRequire(import.meta.url);
    const passkeyEntry = require.resolve("@better-auth/passkey");
    const simpleWebAuthnEntry = createRequire(passkeyEntry).resolve("@simplewebauthn/server");
    const simpleWebAuthnDirectory = simpleWebAuthnEntry.replace(/[/\\][^/\\]+$/, "");
    const result = await build({
      stdin: {
        contents: `
          import { ECDSASigValue } from "@peculiar/asn1-ecc";
          import { AsnParser } from "@peculiar/asn1-schema";

          const parsed = AsnParser.parse(
            Uint8Array.from([48, 6, 2, 1, 1, 2, 1, 1]),
            ECDSASigValue,
          );

          export const signature = [
            new Uint8Array(parsed.r)[0],
            new Uint8Array(parsed.s)[0],
          ];
        `,
        resolveDir: simpleWebAuthnDirectory,
      },
      bundle: true,
      format: "esm",
      logLevel: "silent",
      platform: "node",
      target: "node24",
      write: false,
    });

    const bundledModule = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.contents).toString("base64")}`
    );

    expect(bundledModule.signature).toEqual([1, 1]);
  });
});
