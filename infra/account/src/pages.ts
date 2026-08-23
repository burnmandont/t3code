const pageStyles = `
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #fafafa; }
* { box-sizing: border-box; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
main { width: min(420px, 100%); border: 1px solid #27272a; border-radius: 16px; padding: 28px; background: #111113; }
h1 { margin: 0 0 8px; font-size: 24px; }
p { color: #a1a1aa; line-height: 1.5; }
form { display: grid; gap: 14px; }
label { display: grid; gap: 6px; color: #d4d4d8; }
input, select { width: 100%; border: 1px solid #3f3f46; border-radius: 8px; padding: 10px 12px; background: #18181b; color: inherit; }
button { border: 0; border-radius: 8px; padding: 11px 14px; font: inherit; font-weight: 650; cursor: pointer; background: #fafafa; color: #18181b; }
button.secondary { border: 1px solid #3f3f46; background: transparent; color: #fafafa; }
button.danger { border: 1px solid #7f1d1d; background: transparent; color: #fca5a5; }
button.compact { padding: 6px 9px; font-size: 13px; }
button:disabled { cursor: not-allowed; opacity: 0.5; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
#message { min-height: 24px; color: #fca5a5; }
#message[data-kind="success"] { color: #86efac; }
[hidden] { display: none !important; }
ul { display: grid; gap: 8px; padding: 0; list-style: none; }
li { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid #27272a; border-radius: 8px; padding: 9px 10px; }
code { overflow-wrap: anywhere; }
`;

function page(
  title: string,
  body: string,
  basePath: string,
  passwordLoginEnabled: boolean,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title}</title>
  <style>${pageStyles}</style>
</head>
<body>${body}<script src="/account.js" data-auth-base-path="${basePath}" data-password-login-enabled="${String(passwordLoginEnabled)}" defer></script></body>
</html>`;
}

export const signInPage = (basePath: string, passwordLoginEnabled: boolean) =>
  page(
    "Sign in to T3 Code",
    `<main data-page="sign-in">
    <h1>Sign in to T3 Code</h1>
    <p>This account is served by your own T3 infrastructure.</p>
    <button type="button" data-action="passkey-sign-in" id="passkey-sign-in">Sign in with a passkey</button>
    <form id="account-form"${passwordLoginEnabled ? "" : " hidden"}>
      <p>Password sign-in and account creation are restricted to approved operator networks. Use a passkey on remote devices.</p>
      <label>Name <input id="name" autocomplete="name"></label>
      <label>Email <input id="email" type="email" autocomplete="username webauthn" required></label>
      <label>Password <input id="password" type="password" autocomplete="current-password" minlength="12" required></label>
      <div class="actions">
        <button type="submit" data-action="sign-in">Sign in</button>
        <button type="button" class="secondary" data-action="sign-up">Create account</button>
      </div>
    </form>
    <section id="passkey-management" hidden>
      <h2>Passkeys</h2>
      <p id="passkey-count"></p>
      <label>Passkey name <input id="passkey-name" autocomplete="off" placeholder="MacBook or security key"></label>
      <label>Authenticator
        <select id="passkey-authenticator">
          <option value="">This device or password manager</option>
          <option value="cross-platform">External security key</option>
        </select>
      </label>
      <button type="button" data-action="passkey-add">Add passkey</button>
      <ul id="passkey-list"></ul>
      <button type="button" class="secondary" data-action="sign-out">Sign out to test a passkey</button>
    </section>
    <div id="message" role="status" aria-live="polite"></div>
    <a id="continue-authorization" hidden>Continue authorization</a>
  </main>`,
    basePath,
    passwordLoginEnabled,
  );

export const consentPage = (basePath: string) =>
  page(
    "Authorize T3 Code",
    `<main data-page="consent">
    <h1>Authorize this T3 client</h1>
    <p>The client is requesting: <code id="requested-scopes"></code></p>
    <div class="actions">
      <button type="button" data-action="consent-accept">Allow</button>
      <button type="button" class="secondary" data-action="consent-deny">Deny</button>
    </div>
    <div id="message" role="status" aria-live="polite"></div>
  </main>`,
    basePath,
    true,
  );
