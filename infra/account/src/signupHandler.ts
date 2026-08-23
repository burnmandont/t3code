import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type WebHandler = (request: Request) => Promise<Response>;

const SignupRequest = Schema.Struct({ email: Schema.String });
const decodeSignupRequest = Schema.decodeUnknownOption(SignupRequest);

async function readSignupEmail(request: Request): Promise<string | undefined> {
  try {
    const decoded = decodeSignupRequest(await request.clone().json());
    return Option.isSome(decoded) ? decoded.value.email.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Restricts account creation without changing existing-user sign-in. */
export function withSignupAllowlist(
  handler: WebHandler,
  basePath: string,
  allowedEmails: ReadonlyArray<string>,
): WebHandler {
  const allowed = new Set(allowedEmails.map((email) => email.trim().toLowerCase()));
  const signupPath = `${basePath}/sign-up/email`;

  return async (request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== signupPath) {
      return handler(request);
    }

    const email = await readSignupEmail(request);
    if (email === undefined) {
      return Response.json({ message: "Invalid account creation request." }, { status: 400 });
    }
    if (!allowed.has(email)) {
      return Response.json({ message: "Account creation is not permitted." }, { status: 403 });
    }
    return handler(request);
  };
}
