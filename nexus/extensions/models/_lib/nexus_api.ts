// Nexus Repository REST API client shared by the nexus models: basic auth
// (UTF-8, so any password works), JSON or text bodies, and errors that say
// which call failed.

/** Returns true once Nexus answers at the given base URL. Injectable for tests. */
export type Probe = (url: string) => Promise<boolean>;

/** One request to the Nexus REST API under /service/rest. */
export interface ApiRequest {
  method: "GET" | "PUT" | "POST" | "DELETE";
  path: string;
  user: string;
  password: string;
  json?: unknown;
  text?: string;
}

/** Status and body of one Nexus REST API response. */
export interface ApiResponse {
  status: number;
  body: string;
}

/** Calls the Nexus REST API. Injectable for tests. */
export type Api = (req: ApiRequest) => Promise<ApiResponse>;

/** Asks Nexus's status endpoint whether it is ready to serve requests. */
export const statusProbe: Probe = async (url) => {
  try {
    const res = await fetch(`${url}/service/rest/v1/status`, {
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
};

/** HTTP basic credentials, UTF-8 encoded so any password works. */
export function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** Calls the Nexus REST API at `url` with basic auth. */
export function apiClient(url: string): Api {
  return async (req) => {
    const headers: Record<string, string> = {
      Authorization: basicAuth(req.user, req.password),
    };
    let body: string | undefined;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.text !== undefined) {
      headers["Content-Type"] = "text/plain";
      body = req.text;
    }
    try {
      const res = await fetch(`${url}/service/rest${req.path}`, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(30000),
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      throw new Error(
        `${req.method} ${url}/service/rest${req.path} failed: ${
          (err as Error).message
        }`,
      );
    }
  };
}

/**
 * Polls `probe` until it succeeds or `timeoutMs` passes. `alive`, if given,
 * is asked after each miss so a container that crashed fails fast instead of
 * waiting out the timeout.
 */
export async function waitUntilReady(
  probe: Probe,
  url: string,
  timeoutMs: number,
  intervalMs = 2000,
  alive?: () => Promise<string | null>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe(url))) {
    const died = alive ? await alive() : null;
    if (died) throw new Error(died);
    if (Date.now() >= deadline) {
      throw new Error(
        `Nexus at ${url} was not ready after ${timeoutMs / 1000}s`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Fails with Nexus's message unless the response status is 2xx. */
export function expectOk(r: ApiResponse, what: string): ApiResponse {
  if (r.status < 200 || r.status > 299) {
    throw new Error(`${what} failed: HTTP ${r.status} ${errorText(r)}`.trim());
  }
  return r;
}

/**
 * The useful part of an error response. Nexus answers some errors (such as
 * 429 Too many authentication attempts) with a full HTML page.
 */
export function errorText(r: ApiResponse): string {
  if (!/^\s*</.test(r.body)) return r.body.trim().slice(0, 500);
  const text = r.body.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const desc = text.match(/Error \d+ (.*)$/)?.[1] ?? text;
  const hint = r.status === 429
    ? " (Nexus is throttling sign-ins after failed attempts; wait a minute)"
    : "";
  return desc.slice(0, 200) + hint;
}
