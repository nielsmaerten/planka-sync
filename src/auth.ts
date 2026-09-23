// Login against Planka 2: email/username + password → access token, including the
// terms-acceptance step a fresh server (or a user who never accepted them) requires.
import { ApiError, Client } from "./api.ts";

export interface Terms {
  language: string;
  content: string;
  signature: string;
}

interface TokenReply {
  item: string;
}

interface StepBody {
  step?: string;
  pendingToken?: string;
}

export class LoginError extends Error {}

/** Called when the server demands terms acceptance; return true to accept. */
export type AcceptTerms = (terms: Terms) => Promise<boolean>;

async function acceptTerms(
  anon: Client,
  pendingToken: string,
  accept: AcceptTerms,
): Promise<string> {
  const terms = (await anon.get<{ item: Terms }>("/api/terms")).item;
  if (!(await accept(terms))) throw new LoginError("terms not accepted; login cancelled");
  const reply = await anon.post<TokenReply>("/api/access-tokens/accept-terms", {
    pendingToken,
    signature: terms.signature,
  });
  return reply.item;
}

function loginFailure(err: unknown): never {
  if (err instanceof ApiError && err.status === 401)
    throw new LoginError("Planka rejected the email or password");
  if (err instanceof ApiError && err.code === "E_FORBIDDEN")
    throw new LoginError(`Planka refused the login: ${err.message}`);
  throw err;
}

/** Exchanges credentials for a bearer token. Throws LoginError on refusal. */
export async function login(
  server: string,
  emailOrUsername: string,
  password: string,
  accept: AcceptTerms,
): Promise<string> {
  const anon = new Client(server, null);
  try {
    const reply = await anon.post<TokenReply>("/api/access-tokens", { emailOrUsername, password });
    return reply.item;
  } catch (err) {
    const body = err instanceof ApiError ? (err.body as StepBody | undefined) : undefined;
    if (body?.step === "accept-terms" && body.pendingToken)
      return acceptTerms(anon, body.pendingToken, accept);
    return loginFailure(err);
  }
}
