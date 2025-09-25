/**
 * Single Worker handling all DaiChronicles cron jobs.
 * - Uses BASE_URL (per env) + endpoint paths
 * - Uses INTERNAL_API_KEY header for auth
 * - Global feature flag ENABLED ("true"/"false")
 *
 * Cron → Jobs mapping (multiple jobs may share the same expression)
 */

type JobKey =
  | 'createDailyChronicles'
  | 'processIncompleteChronicles'
  | 'syncChroniclesUpdates'
  | 'syncUserStakes'
  | 'provideLiquidity'
  | 'shieldClean'
  | 'recordDacPerformance';

export interface Env {
  BASE_URL: string; // set via wrangler.jsonc per env
  INTERNAL_API_KEY: string; // secret: wrangler secret put INTERNAL_API_KEY --env <env>
  ENABLED: string; // set via wrangler.jsonc per env: "false" (default) or "true" to run all
}

// Endpoint paths (relative to BASE_URL)
const JOB_ENDPOINT: Record<JobKey, string> = {
  createDailyChronicles: '/api/internal/create-daily-chronicles',
  processIncompleteChronicles: '/api/internal/process-incomplete-chronicles',
  syncChroniclesUpdates: '/api/internal/sync-chronicles-updates',
  syncUserStakes: '/api/internal/sync-user-stakes',
  provideLiquidity: '/api/internal/provide-liquidity',
  shieldClean: '/api/internal/shield-clean',
  recordDacPerformance: '/api/internal/record-dac-performance'
};

// Cron expressions → which jobs to run on that tick
// NOTE: if two jobs share a cron (e.g. */15), both run (in parallel)
const CRON_TO_JOBS: Record<string, JobKey[]> = {
  '0,30 6-23 * * *': ['createDailyChronicles'],
  '15 7-9 * * *': ['processIncompleteChronicles'],
  '*/1 * * * *': ['syncChroniclesUpdates', 'syncUserStakes'],
  '0 * * * *': ['provideLiquidity'],
  '*/15 * * * *': ['shieldClean', 'recordDacPerformance']
};

function nowISO() {
  return new Date().toISOString();
}

function fullUrl(env: Env, path: string) {
  // Ensure no double slash
  return `${env.BASE_URL.replace(/\/+$/, '')}${path}`;
}

async function runJob(job: JobKey, env: Env): Promise<void> {
  const url = fullUrl(env, JOB_ENDPOINT[job]);
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Internal-Authorization': env.INTERNAL_API_KEY }
  });
  const ms = Date.now() - started;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // No retry by design; just log
    console.error(
      `[${nowISO()}] job=${job} status=${
        res.status
      } durMs=${ms} url=${url} body=${body.slice(0, 500)}`
    );
    throw new Error(`Job ${job} failed with HTTP ${res.status}`);
  }

  console.log(
    `[${nowISO()}] job=${job} OK status=${res.status} durMs=${ms} url=${url}`
  );
}

export default {
  /**
   * Health endpoint (GET /) returns 200.
   * Optional manual invocation: /run?job=<key>&key=<manualKey>
   * - If you want manual triggering, set MANUAL_KEY as a secret and uncomment the code below.
   */
  async fetch(req: Request /*, env: Env*/): Promise<Response> {
    const url = new URL(req.url);

    // // Manual trigger (optional):
    // if (url.pathname === "/run" && req.method === "POST") {
    //   const job = url.searchParams.get("job") as JobKey | null
    //   const key = url.searchParams.get("key") || ""
    //   if (!job || !(job in JOB_ENDPOINT)) return new Response("bad job", { status: 400 })
    //   if (key !== (env.MANUAL_KEY ?? "")) return new Response("forbidden", { status: 403 })
    //   await runJob(job, env)
    //   return new Response("ok", { status: 200 })
    // }

    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('ok', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },

  /**
   * Cron entrypoint
   */
  async scheduled(ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Global feature flag (default "false")
    if ((env.ENABLED ?? 'false') !== 'true') {
      console.log(`[${nowISO()}] [disabled] skipping cron=${ev.cron}`);
      return;
    }

    const jobs = CRON_TO_JOBS[ev.cron];
    if (!jobs || jobs.length === 0) {
      // This can happen if local triggers differ from env or a new cron was added but not mapped yet
      console.error(`[${nowISO()}] no jobs mapped for cron="${ev.cron}"`);
      return;
    }

    // Run all jobs for this tick. If one fails, we still attempt the others.
    ctx.waitUntil(
      (async () => {
        const results = await Promise.allSettled(jobs.map(j => runJob(j, env)));
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
          // Throwing here marks the cron run as failed in logs/metrics (useful for alerting)
          throw new Error(
            `Some jobs failed for cron=${ev.cron}: ${failed.length}/${jobs.length}`
          );
        }
      })()
    );
  }
};
