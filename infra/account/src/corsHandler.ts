const AUTH_PATH_PREFIX = "/api/auth";
const ALLOWED_METHODS = "GET, HEAD, POST, OPTIONS";
const ALLOWED_HEADERS = "content-type";

type WebHandler = (request: Request) => Promise<Response>;

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("vary");
  const values = new Set(
    (existing ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  values.add(value);
  headers.set("vary", [...values].join(", "));
}

function corsHeaders(origin: string): Headers {
  const headers = new Headers({
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-origin": origin,
  });
  appendVary(headers, "Origin");
  return headers;
}

/**
 * Allows the static T3 browser client to exchange and refresh OAuth codes at
 * the account origin. Origins are exact values already validated by account
 * configuration; unknown origins receive no readable cross-origin response.
 */
export function withTrustedOriginCors(
  handler: WebHandler,
  trustedOrigins: ReadonlyArray<string>,
): WebHandler {
  const allowedOrigins = new Set(trustedOrigins);
  return async (request) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const isAuthPath =
      url.pathname === AUTH_PATH_PREFIX || url.pathname.startsWith(`${AUTH_PATH_PREFIX}/`);
    if (!isAuthPath || origin === null) {
      return handler(request);
    }
    if (!allowedOrigins.has(origin)) {
      return new Response("Origin is not trusted.", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const response = await handler(request);
    const headers = new Headers(response.headers);
    const allowed = corsHeaders(origin);
    for (const [name, value] of allowed) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
