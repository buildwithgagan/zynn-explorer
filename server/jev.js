// Thin client for TypeSafe's System One API (https://docs.typesafe.ai/api).
// Jev returns typed judgments (Choice / Noul / Score) with probabilities; it never generates text.

const ENDPOINT = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";
const RETRYABLE = new Set([429, 500, 502, 503, 529]);

export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
export const noul = (instructions, criteria) =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };

export function isConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ask(state, questions, { attempts = 4, timeoutMs = 30_000 } = {}) {
  if (!isConfigured()) {
    const err = new Error("TYPESAFE_API_KEY is not set. Add it to .env to enable natural-language queries.");
    err.status = 503;
    throw err;
  }
  const body = JSON.stringify({ state, model: MODEL, questions });
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(Math.min(400 * 2 ** attempt, 5_000));
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = new Error(`Could not reach TypeSafe: ${err.message}`);
      lastError.status = 502;
      continue;
    }
    if (res.ok) return res.json();

    const text = await res.text().catch(() => "");
    lastError = new Error(`TypeSafe API ${res.status}: ${text.slice(0, 600) || res.statusText}`);
    lastError.status = res.status === 401 ? 401 : 502;
    if (!RETRYABLE.has(res.status)) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 8_000));
  }
  throw lastError;
}
