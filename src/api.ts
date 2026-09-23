// Minimal Planka 2 REST client: one instance per server and credential.

export type CredentialType = "bearer" | "apiKey";

export interface Credential {
  type: CredentialType;
  token: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly request: string;
  readonly body: unknown;
  constructor(
    request: string,
    status: number,
    detail: { code: string; message: string; body?: unknown },
  ) {
    super(detail.message);
    this.request = request;
    this.status = status;
    this.code = detail.code;
    this.body = detail.body;
  }
}

interface ErrorBody {
  code?: string;
  message?: string;
  problems?: string[];
}

/** Planka error bodies: {code, message, problems?}. Falls back to the raw text. */
function describe(status: number, text: string): { code: string; message: string; body: unknown } {
  let code = `HTTP_${status}`;
  let message = text.slice(0, 200);
  let body: unknown;
  try {
    body = JSON.parse(text);
    const parsed = body as ErrorBody;
    code = parsed.code ?? code;
    message = parsed.problems?.join("; ") ?? parsed.message ?? message;
  } catch {
    // Non-JSON error body: keep the raw text.
  }
  if (status === 404) message += " (Planka also answers 404 when the user lacks access)";
  return { code, message, body };
}

export const normalizeServer = (url: string): string => url.trim().replace(/\/+$/, "");

export class Client {
  readonly server: string;
  private readonly credential: Credential | null;

  constructor(server: string, credential: Credential | null) {
    this.server = normalizeServer(server);
    this.credential = credential;
  }

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.credential?.type === "bearer")
      headers.Authorization = `Bearer ${this.credential.token}`;
    if (this.credential?.type === "apiKey") headers["X-API-Key"] = this.credential.token;
    if (contentType) headers["Content-Type"] = contentType;
    return headers;
  }

  async send(method: string, path: string, body?: BodyInit, type?: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.server + path, { method, headers: this.headers(type), body });
    } catch (err) {
      const cause = (err as Error & { cause?: Error }).cause?.message ?? (err as Error).message;
      throw new ApiError(`${method} ${path}`, 0, {
        code: "UNREACHABLE",
        message: `${this.server}: ${cause}`,
      });
    }
    if (res.ok) return res;
    throw new ApiError(`${method} ${path}`, res.status, describe(res.status, await res.text()));
  }

  /** A request whose response is handed back verbatim (the `api` verb). */
  async raw(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ status: number; text: string }> {
    const type = body === undefined ? undefined : "application/json";
    const res = await this.send(method, path, body, type);
    return { status: res.status, text: await res.text() };
  }

  get = async <T>(path: string): Promise<T> => (await this.send("GET", path)).json() as Promise<T>;
  del = async (path: string): Promise<void> => void (await this.send("DELETE", path));
  post = async <T>(path: string, body: object): Promise<T> =>
    (await this.send("POST", path, JSON.stringify(body), "application/json")).json() as Promise<T>;
  patch = async <T>(path: string, body: object): Promise<T> =>
    (await this.send("PATCH", path, JSON.stringify(body), "application/json")).json() as Promise<T>;
  postForm = async <T>(path: string, form: FormData): Promise<T> =>
    (await this.send("POST", path, form)).json() as Promise<T>;

  /**
   * Downloads a Planka-hosted URL. Attachment routes live outside /api and take a bearer token
   * only as a cookie; an API key works through the usual header.
   */
  async download(url: string): Promise<Uint8Array> {
    const path = url.startsWith(this.server) ? url.slice(this.server.length) : url;
    const headers = this.headers();
    if (this.credential?.type === "bearer") {
      delete headers.Authorization;
      headers.Cookie = `accessToken=${this.credential.token}`;
    }
    let res: Response;
    try {
      res = await fetch(this.server + encodeURI(path), { headers });
    } catch (err) {
      throw new ApiError(`GET ${path}`, 0, {
        code: "UNREACHABLE",
        message: (err as Error).message,
      });
    }
    if (!res.ok)
      throw new ApiError(`GET ${path}`, res.status, describe(res.status, await res.text()));
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** One line for logs: code and message, never the credential. */
export function apiError(err: unknown): string {
  if (err instanceof ApiError) return `${err.request}: ${err.code} ${err.message}`;
  return (err as Error).message;
}
