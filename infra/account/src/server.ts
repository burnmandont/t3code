// @effect-diagnostics nodeBuiltinImport:off - Node entrypoint owns HTTP startup and its built client asset.
import * as NodeHttp from "node:http";
import { readFileSync } from "node:fs";

import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { loadAccountConfiguration } from "./config.ts";
import { withTrustedOriginCors } from "./corsHandler.ts";
import { makeAccountHealthResponse } from "./health.ts";
import { withPublicClientMetadata } from "./oidcHandler.ts";
import { consentPage, signInPage } from "./pages.ts";
import { accountDatabase, auth } from "./runtimeAuth.ts";
import { withSignupAllowlist } from "./signupHandler.ts";

const configuration = loadAccountConfiguration();
const accountClientScript = readFileSync(
  process.env.T3_ACCOUNT_CLIENT_SCRIPT_PATH ??
    new URL("../dist/account-client.js", import.meta.url),
  "utf8",
);
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const html = (body: string) =>
  HttpServerResponse.text(body, {
    contentType: "text/html; charset=utf-8",
    headers: securityHeaders,
  });

const routes = Layer.mergeAll(
  HttpRouter.add("GET", "/health", makeAccountHealthResponse(accountDatabase)),
  HttpRouter.add(
    "GET",
    "/sign-in",
    html(signInPage(configuration.basePath, configuration.passwordLoginEnabled)),
  ),
  HttpRouter.add("GET", "/consent", html(consentPage(configuration.basePath))),
  HttpRouter.add(
    "GET",
    "/account.js",
    HttpServerResponse.text(accountClientScript, {
      contentType: "text/javascript; charset=utf-8",
      headers: securityHeaders,
    }),
  ),
  HttpRouter.add(
    "*",
    "*",
    HttpEffect.fromWebHandler(
      withTrustedOriginCors(
        withSignupAllowlist(
          withPublicClientMetadata(auth.handler),
          configuration.basePath,
          configuration.signupAllowedEmails,
        ),
        configuration.trustedOrigins,
      ),
    ),
  ),
);

HttpRouter.serve(routes).pipe(
  Layer.provide(
    NodeHttpServer.layer(NodeHttp.createServer, {
      host: configuration.host,
      port: configuration.port,
    }),
  ),
  Layer.launch,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
