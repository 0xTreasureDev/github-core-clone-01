// Entry lifecycle for the forge, wired to the make.fun env contract:
// MAKEFUN_ENV_URL names the env origin. This process starts the app on an
// ephemeral port, reports that port to the env, then waits until the env
// declares the trial done before shutting down and exiting cleanly.

import { createApp } from "./app.ts";

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin === "") {
  console.error("[forge] MAKEFUN_ENV_URL is not set; nowhere to register");
  process.exit(1);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waits grow from 200 ms and double up to a 2 s ceiling.
const backoff = (attempt: number) => Math.min(2000, 200 * 2 ** Math.min(attempt, 10));

async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const res = await fetch(envOrigin + "/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30000),
      });
      status = res.status;
      if (status === 400 || status === 405) {
        throw new Error(`env refused the registration (HTTP ${status})`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("env refused")) throw err;
    }
    if (status === 200 || status === 409) return; // 409: an earlier register already won
    await pause(backoff(attempt));
  }
}

async function awaitTrialEnd(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(envOrigin + "/done", { signal: AbortSignal.timeout(30000) });
      if (res.ok && ((await res.json()) as { done?: unknown }).done === true) return;
    } catch {
      // env not reachable yet; keep waiting
    }
    await pause(backoff(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, () => resolve());
});

const bound = server.address();
if (bound === null || typeof bound === "string") {
  console.error("[forge] server did not bind a TCP port");
  process.exit(1);
}

console.log(`[forge] serving on port ${bound.port}`);
await announce(bound.port);
console.log("[forge] registered with the env; trial running");
await awaitTrialEnd();

server.close();
console.log("[forge] trial done; shutting down");
process.exit(0);
