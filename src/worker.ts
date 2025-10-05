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
  SLACK_WEBHOOK_URL?: string; // optional, for job failure alerts
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

/** --- Slack helpers --- */

function shouldAlert(status?: number) {
  // Only suppress alerts for HTTP 503; network errors (no status) should alert.
  return status !== 503;
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
};

type JobResultErr = {
  job: JobKey;
  ok: false;
  status?: number;
  ms: number;
  url: string;
  error: string;
  body?: string;
};

type JobResult = JobResultOk | JobResultErr;

async function runJob(job: JobKey, env: Env): Promise<JobResult> {
  const url = fullUrl(env, JOB_ENDPOINT[job]);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Internal-Authorization': env.INTERNAL_API_KEY }
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
        error: `HTTP ${res.status}`,
        body: trimmed
      };
    }

    console.log(
      `[${nowISO()}] job=${job} OK status=${res.status} durMs=${ms} url=${url}`
    );
    return { job, ok: true, status: res.status, ms, url };
  } catch (e: any) {
    const ms = Date.now() - started;
    const message = e?.message ?? String(e);
    console.error(
      `[${nowISO()}] job=${job} fetch error durMs=${ms} url=${url} err=${message}`
    );
    return { job, ok: false, ms, url, error: message };
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

    const jobs = CRON_TO_JOBS[ev.cron];
    if (!jobs || jobs.length === 0) {
      // This can happen if local triggers differ from env or a new cron was added but not mapped yet
      console.error(`[${nowISO()}] no jobs mapped for cron="${ev.cron}"`);
      return;
    }

    // Run all jobs for this tick.
    ctx.waitUntil(
      (async () => {
        const results = await Promise.all(jobs.map(j => runJob(j, env)));

        // Send Slack alerts for non-503 failures (if webhook configured).
        const webhook = env.SLACK_WEBHOOK_URL?.trim();
        if (webhook) {
          const alerts = results
            .filter((r): r is JobResultErr => !r.ok)
            .filter(r => shouldAlert(r.status))
            .map(r =>
              postSlack(webhook, {
                text: slackTextForFailure({
                  cron: ev.cron,
                  job: r.job,
                  url: r.url,
                  status: r.status,
                  ms: r.ms,
                  baseUrl: env.BASE_URL,
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
          const non503Failed = results
            .filter((r): r is JobResultErr => !r.ok)
            .map(r => r.status ?? 0)
            .filter(s => s !== 503).length;
          throw new Error(
            `Some jobs failed for cron=${ev.cron}: ${
              results.filter(r => !r.ok).length
            }/${results.length} (non-503 failures=${non503Failed})`
          );
        }
      })()
    );
  }
};
