import { request } from "undici";
export async function httpJson(url, opts = {}) {
    const retries = opts.retries ?? 2;
    const base = opts.retryBaseMs ?? 500;
    let lastErr;
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
            let body = null;
            if (text) {
                try {
                    body = JSON.parse(text);
                }
                catch {
                    body = text;
                }
            }
            const out = { status: res.statusCode, headers: res.headers, body: body, text };
            const transient = res.statusCode >= 500 || res.statusCode === 429;
            if (transient && attempt < retries) {
                await sleep(retryDelay(out, attempt, base));
                continue;
            }
            return out;
        }
        catch (err) {
            lastErr = err;
            if (attempt < retries) {
                await sleep(base * 2 ** attempt + Math.random() * 100);
                continue;
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
function retryDelay(res, attempt, base) {
    const ra = res.headers["retry-after"];
    const raw = Array.isArray(ra) ? ra[0] : ra;
    if (raw) {
        const secs = Number(raw);
        if (Number.isFinite(secs))
            return Math.min(secs * 1000, 60_000);
    }
    return Math.min(base * 2 ** attempt + Math.random() * 200, 10_000);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
//# sourceMappingURL=http.js.map