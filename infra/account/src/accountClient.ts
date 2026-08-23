// @effect-diagnostics globalFetch:off - This source is bundled into an isolated browser client.
import { passkeyClient } from "@better-auth/passkey/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/client";

import { oauthContinuationUrl, passwordSignInErrorMessage } from "./accountClientFlow.ts";
import { hasOauthPrompt } from "./oauthPrompt.ts";
type PasskeySummary = {
  readonly id: string;
  readonly name?: string | null;
  readonly createdAt?: string | Date | null;
};

const script = document.currentScript as HTMLScriptElement | null;
const basePath = script?.dataset.authBasePath || "/api/auth";
const passwordLoginEnabled = script?.dataset.passwordLoginEnabled === "true";
const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath,
  plugins: [passkeyClient(), oauthProviderClient()],
});

const params = new URLSearchParams(window.location.search);
const oauthQuery = (() => {
  if (!params.has("sig")) return undefined;
  const signed = new Set(params.getAll("ba_param"));
  if (signed.size === 0) return undefined;
  const result = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (key === "sig" || key === "ba_param" || signed.has(key)) result.append(key, value);
  }
  return result.toString();
})();
const forceOauthLogin = hasOauthPrompt(oauthQuery, "login");

const message = document.querySelector<HTMLElement>("#message");
const showMessage = (value: unknown, error = true) => {
  if (!message) return;
  message.textContent = value ? String(value) : "";
  message.dataset.kind = error ? "error" : "success";
};

const followOauthContinuation = (value: unknown) => {
  const redirect = oauthContinuationUrl(value);
  if (!redirect) return false;
  window.location.assign(redirect);
  return true;
};

const requireOauthContinuation = (value: unknown) => {
  if (followOauthContinuation(value)) return true;
  if (oauthQuery) {
    throw new Error("The account service did not return the OAuth continuation URL.");
  }
  return false;
};

const continueAuthorization = () => {
  if (!oauthQuery) return false;
  const authorizationUrl = `${basePath}/oauth2/authorize?${oauthQuery}`;
  const continueLink = document.querySelector<HTMLAnchorElement>("#continue-authorization");
  if (continueLink) {
    continueLink.href = authorizationUrl;
    continueLink.hidden = false;
  }
  window.location.assign(authorizationUrl);
  return true;
};

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${basePath}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    readonly message?: string;
    readonly error?: string;
    readonly error_description?: string;
  };
  if (!response.ok) {
    throw new Error(data.message || data.error_description || data.error || response.statusText);
  }
  return data;
};

const passkeyList = document.querySelector<HTMLUListElement>("#passkey-list");
const management = document.querySelector<HTMLElement>("#passkey-management");

const renderPasskeys = async () => {
  if (!passkeyList) return;
  const passkeys = await api<ReadonlyArray<PasskeySummary>>("/passkey/list-user-passkeys");
  passkeyList.replaceChildren();
  for (const passkey of passkeys) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = passkey.name || "Passkey";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger compact";
    remove.textContent = "Remove";
    remove.disabled = !passwordLoginEnabled && passkeys.length <= 2;
    remove.title = remove.disabled
      ? "Keep at least two passkeys while password login is disabled."
      : "Remove this passkey";
    remove.addEventListener("click", async () => {
      showMessage("");
      try {
        await api("/passkey/delete-passkey", {
          method: "POST",
          body: JSON.stringify({ id: passkey.id }),
        });
        await renderPasskeys();
      } catch (error) {
        showMessage(error instanceof Error ? error.message : error);
      }
    });
    item.append(label, remove);
    passkeyList.append(item);
  }
  const count = document.querySelector<HTMLElement>("#passkey-count");
  if (count)
    count.textContent = `${passkeys.length} passkey${passkeys.length === 1 ? "" : "s"} enrolled`;
};

const showAuthenticatedState = async () => {
  management?.removeAttribute("hidden");
  document.querySelector<HTMLElement>("#account-form")?.setAttribute("hidden", "");
  document.querySelector<HTMLElement>("#passkey-sign-in")?.setAttribute("hidden", "");
  await renderPasskeys();
  showMessage(
    "Signed in. Add at least two independent passkeys before disabling password login.",
    false,
  );
};

document
  .querySelector<HTMLFormElement>("#account-form")
  ?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!passwordLoginEnabled) return;
    showMessage("");
    try {
      const data = await api("/sign-in/email", {
        method: "POST",
        body: JSON.stringify({
          email: document.querySelector<HTMLInputElement>("#email")?.value,
          password: document.querySelector<HTMLInputElement>("#password")?.value,
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        }),
      });
      if (!requireOauthContinuation(data)) await showAuthenticatedState();
    } catch (error) {
      showMessage(passwordSignInErrorMessage(error));
    }
  });

document.querySelector("[data-action='sign-up']")?.addEventListener("click", async () => {
  if (!passwordLoginEnabled) return;
  showMessage("");
  try {
    const data = await api("/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name:
          document.querySelector<HTMLInputElement>("#name")?.value ||
          document.querySelector<HTMLInputElement>("#email")?.value,
        email: document.querySelector<HTMLInputElement>("#email")?.value,
        password: document.querySelector<HTMLInputElement>("#password")?.value,
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
      }),
    });
    if (!requireOauthContinuation(data)) await showAuthenticatedState();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : error);
  }
});

document.querySelector("[data-action='passkey-sign-in']")?.addEventListener("click", async () => {
  showMessage("");
  const result = await authClient.signIn.passkey();
  if (result.error) {
    showMessage(result.error.message || "Passkey authentication failed.");
    return;
  }
  if (!requireOauthContinuation(result.data)) await showAuthenticatedState();
});

document.querySelector("[data-action='passkey-add']")?.addEventListener("click", async () => {
  showMessage("");
  const name = document.querySelector<HTMLInputElement>("#passkey-name")?.value.trim();
  const authenticatorAttachment =
    document.querySelector<HTMLSelectElement>("#passkey-authenticator")?.value;
  const result = await authClient.passkey.addPasskey({
    ...(name ? { name } : {}),
    ...(authenticatorAttachment === "cross-platform"
      ? { authenticatorAttachment: "cross-platform" as const }
      : {}),
  });
  if (result.error) {
    showMessage(
      ("code" in result.error &&
        result.error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") ||
        /previously registered/iu.test(result.error.message || "")
        ? "That authenticator already holds this account's passkey. Choose a different password manager, device account, or external security key for an independent recovery path."
        : result.error.message || "Passkey enrollment failed.",
    );
    return;
  }
  await renderPasskeys();
  showMessage("Passkey enrolled successfully.", false);
});

document.querySelector("[data-action='sign-out']")?.addEventListener("click", async () => {
  showMessage("Signing out…", false);
  const result = await authClient.signOut();
  if (result.error) {
    showMessage(result.error.message || "Sign out failed.");
    return;
  }
  window.location.reload();
});

const scopes = params.get("scope") || "account access";
const scopeElement = document.querySelector("#requested-scopes");
if (scopeElement) scopeElement.textContent = scopes;
for (const [selector, accept] of [
  ["[data-action='consent-accept']", true],
  ["[data-action='consent-deny']", false],
] as const) {
  document.querySelector(selector)?.addEventListener("click", async () => {
    showMessage("");
    try {
      const data = await api<{ readonly url?: string; readonly redirect_uri?: string }>(
        "/oauth2/consent",
        { method: "POST", body: JSON.stringify({ accept }) },
      );
      const redirect = data.url || data.redirect_uri;
      if (redirect) window.location.assign(redirect);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : error);
    }
  });
}

void authClient.getSession().then(({ data }) => {
  if (!data?.session) return;
  if (forceOauthLogin) {
    showMessage("Sign in with the account you want to use.", false);
    return;
  }
  if (!continueAuthorization()) void showAuthenticatedState();
});
