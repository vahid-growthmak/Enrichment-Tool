import { request, type Dispatcher } from "undici";

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  text: string;
}

export interface HttpOptions {
  method?: Dispatcher.HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** retries on network errors and 5xx; 429 honours Retry-After */
  retries?: number;
  retryBaseMs?: number;
}

export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpResponse<T>> {
  const retries = opts.retries ?? 2;
  const base = opts.retryBaseMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await request(url, {
        method: opts.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        headersTimeout: opts.timeoutMs ?? 30_000,
        bodyTimeout: opts.timeoutMs ?? 30_000,
      });
      const text = await res.body.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const out: HttpResponse<T> = { status: res.statusCode, headers: res.headers as HttpResponse["headers"], body: body as T, text };
      const transient = res.statusCode >= 500 || res.statusCode === 429;
      if (transient && attempt < retries) {
        await sleep(retryDelay(out, attempt, base));
        continue;
      }
      return out;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(base * 2 ** attempt + Math.random() * 100);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function retryDelay(res: HttpResponse, attempt: number, base: number): number {
  const ra = res.headers["retry-after"];
  const raw = Array.isArray(ra) ? ra[0] : ra;
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 60_000);
  }
  return Math.min(base * 2 ** attempt + Math.random() * 200, 10_000);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
