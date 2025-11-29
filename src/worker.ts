/**
 * Single Worker handling all DaiChronicles cron jobs.
 * - Uses BASE_URL\WEB_URL (per env) + endpoint paths
 * - Uses INTERNAL_API_KEY header for auth
 * - Global feature flag ENABLED ("true"/"false")
 *
 * Cron → Jobs mapping (multiple jobs may share the same expression)
 */

type Platform = 'worker' | 'web';

type JobKey =
  | 'createDailyChronicles'
  | 'processIncompleteChronicles'
  | 'syncChroniclesUpdates'
  | 'syncUserStakes'
  | 'provideLiquidity'
  | 'shieldClean'
  | 'recordDacPerformance'
  | 'healthz';

export interface Env {
  BASE_URL: string; // set via wrangler.jsonc per env
  WEB_URL: string; // set via wrangler.jsonc per env
  INTERNAL_API_KEY: string; // secret: wrangler secret put INTERNAL_API_KEY --env <env>
  ENABLED: string; // set via wrangler.jsonc per env: "false" (default) or "true" to run all
  SLACK_WEBHOOK_URL?: string; // optional, for job failure alerts
}

// Endpoint paths (relative to BASE_URL and/or WEB_URL)
const JOB_ENDPOINT: Record<JobKey, { method: string; path: string }> = {
  createDailyChronicles: {
    method: 'POST',
    path: '/api/internal/create-daily-chronicles'
  },
  processIncompleteChronicles: {
    method: 'POST',
    path: '/api/internal/process-incomplete-chronicles'
  },
  syncChroniclesUpdates: {
    method: 'POST',
    path: '/api/internal/sync-chronicles-updates'
  },
  syncUserStakes: { method: 'POST', path: '/api/internal/sync-user-stakes' },
  provideLiquidity: { method: 'POST', path: '/api/internal/provide-liquidity' },
  shieldClean: { method: 'POST', path: '/api/internal/shield-clean' },
  recordDacPerformance: {
    method: 'POST',
    path: '/api/internal/record-dac-performance'
  },
  healthz: { method: 'GET', path: '/api/healthz' }
};

// Cron expressions → which jobs to run on that tick
// NOTE: if two jobs share a cron (e.g. */15), both run (in parallel)
const WORKER_CRON_TO_JOBS: Record<string, JobKey[]> = {
  '0,30 12-23 * * *': ['createDailyChronicles'],
  '15 13-15 * * *': ['processIncompleteChronicles'],
  '*/1 * * * *': ['syncChroniclesUpdates', 'syncUserStakes', 'healthz'],
  '0 * * * *': ['provideLiquidity'],
  '*/15 * * * *': ['shieldClean', 'recordDacPerformance']
};

const WEB_CRON_TO_JOBS: Record<string, JobKey[]> = {
  '0,30 12-23 * * *': [],
  '15 13-15 * * *': [],
  '*/1 * * * *': ['healthz'],
  '0 * * * *': [],
  '*/15 * * * *': []
};

function nowISO() {
  return new Date().toISOString();
}

function fullUrl(
  platform: Platform,
  env: Env,
  { method, path }: { method: string; path: string }
) {
  // Ensure no double slash
  const baseUrl = platform === 'worker' ? env.BASE_URL : env.WEB_URL;
  return {
    url: `${baseUrl.replace(/\/+$/, '')}${path}`,
    method: method,
    baseUrl
  };
}

/** --- Slack helpers --- */

function shouldAlert(jobResult?: JobResult) {
  if (!jobResult) return true; // No result → alert by default

  const { status, job } = jobResult;

  // Only suppress alerts for HTTP 503, 409; network errors (no status) should alert.
  if (status === 503 || status === 409) return false;
  if (status === 524 && job === 'provideLiquidity') return false;

  return true;
}

async function postSlack(webhook: string, payload: unknown): Promise<void> {
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error(`[${nowISO()}] Slack webhook failed status=${res.status}`);
    }
  } catch (e: any) {
    console.error(`[${nowISO()}] Slack webhook error: ${e?.message ?? e}`);
  }
}

function slackTextForFailure(opts: {
  cron: string;
  job: JobKey;
  url: string;
  status?: number | undefined;
  ms: number;
  baseUrl: string;
  timestampISO: string;
  body?: string | undefined;
}) {
  const statusStr =
    opts.status !== undefined ? String(opts.status) : 'network error';
  const bodySnippet = opts.body
    ? `\n• *Body (trimmed)*:\n\`\`\`\n${opts.body}\n\`\`\``
    : '';
  return (
    `:rotating_light: *Cron job failed* (${opts.cron})\n` +
    `• *Job*: ${opts.job}\n` +
    `• *Status*: ${statusStr}\n` +
    `• *Duration*: ${opts.ms}ms\n` +
    `• *When*: ${opts.timestampISO}\n` +
    `• *URL*: ${opts.url}\n` +
    `• *BASE_URL*: ${opts.baseUrl}` +
    bodySnippet
  );
}

/** --- Job runner returns structured result (no throw) --- */

type JobResultOk = {
  job: JobKey;
  ok: true;
  status: number;
  ms: number;
  url: string;
  baseUrl: string;
};

type JobResultErr = {
  job: JobKey;
  ok: false;
  status?: number;
  ms: number;
  url: string;
  baseUrl: string;
  error: string;
  body?: string;
};

type JobResult = JobResultOk | JobResultErr;

async function runJob(
  platform: Platform,
  job: JobKey,
  env: Env
): Promise<JobResult> {
  const { url, method, baseUrl } = fullUrl(platform, env, JOB_ENDPOINT[job]);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: method,
      ...(JOB_ENDPOINT[job].path.startsWith('/api/internal/')
        ? { headers: { 'Internal-Authorization': env.INTERNAL_API_KEY } }
        : {})
    });
    const ms = Date.now() - started;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const trimmed = body.slice(0, 1500); // keep Slack friendly
      console.error(
        `[${nowISO()}] job=${job} status=${
          res.status
        } durMs=${ms} url=${url} body=${trimmed}`
      );
      return {
        job,
        ok: false,
        status: res.status,
        ms,
        url,
        baseUrl,
        error: `HTTP ${res.status}`,
        body: trimmed
      };
    }

    console.log(
      `[${nowISO()}] job=${job} OK status=${res.status} durMs=${ms} url=${url}`
    );
    return { job, ok: true, status: res.status, ms, url, baseUrl };
  } catch (e: any) {
    const ms = Date.now() - started;
    const message = e?.message ?? String(e);
    console.error(
      `[${nowISO()}] job=${job} fetch error durMs=${ms} url=${url} err=${message}`
    );
    return { job, ok: false, ms, url, error: message, baseUrl };
  }
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

    const workerJobs = WORKER_CRON_TO_JOBS[ev.cron];
    if (!workerJobs || workerJobs.length === 0) {
      // This can happen if local triggers differ from env or a new cron was added but not mapped yet
      console.error(`[${nowISO()}] no jobs mapped for cron="${ev.cron}"`);
      return;
    }

    const webJobs = WEB_CRON_TO_JOBS[ev.cron] || [];

    // Run all jobs for this tick.
    ctx.waitUntil(
      (async () => {
        const allJobs = [
          ...workerJobs.map(j => runJob('worker', j, env)),
          ...webJobs.map(j => runJob('web', j, env))
        ];
        const results = await Promise.all(allJobs);

        // Send Slack alerts for non-503 failures (if webhook configured).
        const webhook = env.SLACK_WEBHOOK_URL?.trim();
        if (webhook) {
          const alerts = results
            .filter((r): r is JobResultErr => !r.ok)
            .filter(r => shouldAlert(r))
            .map(r =>
              postSlack(webhook, {
                text: slackTextForFailure({
                  cron: ev.cron,
                  job: r.job,
                  url: r.url,
                  status: r.status,
                  ms: r.ms,
                  baseUrl: r.baseUrl,
                  timestampISO: nowISO(),
                  body: r.body
                })
              })
            );

          if (alerts.length > 0) {
            await Promise.allSettled(alerts);
          }
        }

        // Mark the cron as failed in logs/metrics if any job failed (including 503s).
        const anyFailed = results.some(r => !r.ok);
        if (anyFailed) {
          const unexpectedFailed = results
            .filter((r): r is JobResultErr => !r.ok)
            .filter(r => shouldAlert(r)).length;
          throw new Error(
            `Some jobs failed for cron=${ev.cron}: ${
              results.filter(r => !r.ok).length
            }/${results.length} (unexpected failures=${unexpectedFailed})`
          );
        }
      })()
    );
  }
};
