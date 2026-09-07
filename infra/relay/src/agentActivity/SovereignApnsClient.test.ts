import * as NodeHttp2 from "node:http2";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { sendHttp2ApnsRequest } from "./SovereignApnsClient.ts";

const servers = new Set<ReturnType<typeof NodeHttp2.createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers.clear();
});

describe("sovereign APNs HTTP/2 transport", () => {
  it("sends an HTTP/2 provider request and returns the APNs response metadata", async () => {
    const server = NodeHttp2.createServer();
    servers.add(server);
    const received: Array<{
      path: string | undefined;
      authorization: string | undefined;
      body: string;
    }> = [];
    server.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push({
          path: headers[":path"],
          authorization:
            typeof headers.authorization === "string" ? headers.authorization : undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        stream.respond({ ":status": 400, "apns-id": "apns-test-id" });
        stream.end(JSON.stringify({ reason: "BadDeviceToken" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");

    const response = await sendHttp2ApnsRequest({
      origin: `http://127.0.0.1:${address.port}`,
      path: "/3/device/test-token",
      headers: { authorization: "bearer test-jwt" },
      payload: { aps: { alert: { title: "Test" } } },
    });

    expect(response).toEqual({
      status: 400,
      body: JSON.stringify({ reason: "BadDeviceToken" }),
      apnsId: "apns-test-id",
    });
    expect(received).toEqual([
      {
        path: "/3/device/test-token",
        authorization: "bearer test-jwt",
        body: JSON.stringify({ aps: { alert: { title: "Test" } } }),
      },
    ]);
  });
});
