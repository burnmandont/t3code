import { createServer } from "node:http";

const port = 8080;
const webhook = process.env.T3_ALERT_WEBHOOK_URL?.trim();
const timeoutMs = Number(process.env.T3_ALERT_WEBHOOK_TIMEOUT_MS ?? "10000");

if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error("T3_ALERT_WEBHOOK_TIMEOUT_MS must be a positive integer");
}

const readBody = async (request) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
};

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end("ok\n");
    return;
  }
  if (request.method !== "POST" || request.url !== "/alerts") {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readBody(request);
    const alert = JSON.parse(body.toString("utf8"));
    console.log(JSON.stringify({ event: "sovereign_alert", alert }));
    if (webhook) {
      const destination = new URL(webhook);
      if (!["http:", "https:"].includes(destination.protocol)) {
        throw new Error("T3_ALERT_WEBHOOK_URL must use HTTP or HTTPS");
      }
      const delivered = await fetch(destination, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await delivered.body?.cancel();
      if (!delivered.ok) throw new Error(`webhook_http_${delivered.status}`);
    }
    response.writeHead(204).end();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "sovereign_alert_delivery_failed",
        reason: error instanceof Error ? error.message : "unknown_failure",
      }),
    );
    response.writeHead(502).end();
  }
}).listen(port, "0.0.0.0");
