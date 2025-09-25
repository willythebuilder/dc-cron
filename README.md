
# DaiChronicles Cron Worker

This repo contains a **single Cloudflare Worker + Cron Triggers** that periodically call internal API endpoints of [DaiChronicles](https://daichronicles.io).  
All jobs are managed in one Worker, with a global feature flag and separate staging/production environments.

---

## ⚡ Project Organization

```

dc-cron/
    package.json
    tsconfig.json
    .gitignore
    wrangler.jsonc
    src/
        worker.ts

````

- **One Worker handles all jobs** → simpler to manage, fewer moving parts.
- Schedules are defined in `wrangler.jsonc`.
- Environments:
  - **staging** → `https://staging-daichronicles.netlify.app`
  - **production** → `https://daichronicles.io`

---

## 🛠 Installation

1. Install Node.js 18+ and npm or pnpm.
2. Install Wrangler (globally or via `npx`):
   ```bash
   npm i -g wrangler@latest
   wrangler login
    ```

3. Clone this repo:

   ```bash
   git clone https://github.com/<your-org>/dc-cron.git
   cd dc-cron
   npm install
   ```

---

## ▶️ Development & Local Testing

Run the Worker locally with cron simulation:

```bash
npm run dev
```

Wrangler starts your Worker at http://127.0.0.1:8787, but **cron jobs don’t fire automatically** in dev mode.
You need to **manually simulate a tick** by calling the special __scheduled endpoint.

Examples (open in browser or curl):

```bash
# every minute
curl "http://127.0.0.1:8787/__scheduled?cron=*/1%20*%20*%20*%20*"

# 0 and 30 past each hour from 06–23
curl "http://127.0.0.1:8787/__scheduled?cron=0,30%206-23%20*%20*%20*"

# 15 past hours 7–9
curl "http://127.0.0.1:8787/__scheduled?cron=15%207-9%20*%20*%20*"

# hourly at :00
curl "http://127.0.0.1:8787/__scheduled?cron=0%20*%20*%20*%20*"

# every 15 minutes
curl "http://127.0.0.1:8787/__scheduled?cron=*/15%20*%20*%20*%20*"

```
> ⚠️ The cron string in the URL must exactly match one of the schedules in your CRON_TO_JOBS mapping. Otherwise, no jobs will run.

---

## 🚀 Deployment

Deploy to **staging**:

```bash
npm run deploy:staging
```

Deploy to **production**:

```bash
npm run deploy:prod
```

---

## 🔑 Secrets

The Worker requires:

* `INTERNAL_API_KEY` → shared secret for Netlify internal API routes

Set them with Wrangler:

```bash
# staging
wrangler secret put INTERNAL_API_KEY --env staging

# production
wrangler secret put INTERNAL_API_KEY --env production
```

---

## ⏯ Enabling / Disabling Jobs (Feature Flag)

The Worker checks the `ENABLED` secret at runtime:

```ts
if ((env.ENABLED ?? "false") !== "true") {
  console.log(`[disabled] skipping cron ${ev.cron}`)
  return
}
```

* **Disable all jobs in production (preferably via UI) or:**

  ```bash
  wrangler secret put ENABLED --env production
  # enter: false
  ```
* **Enable again (preferably via UI) or:**

  ```bash
  wrangler secret put ENABLED --env production
  # enter: true
  ```

No redeploy required. Secrets update immediately.

---

## 📜 Cron Jobs (UTC)

| Job                         | Schedule                | Endpoint                                      |
| --------------------------- | ----------------------- | --------------------------------------------- |
| createDailyChronicles       | `0,30 6-23 * * *`       | `/api/internal/create-daily-chronicles`       |
| processIncompleteChronicles | `15 7-9 * * *`          | `/api/internal/process-incomplete-chronicles` |
| syncChroniclesUpdates       | `*/1 * * * *` (1 min)   | `/api/internal/sync-chronicles-updates`       |
| syncUserStakes              | `*/1 * * * *` (1 min)   | `/api/internal/sync-user-stakes`              |
| provideLiquidity            | `0 * * * *` (hourly)    | `/api/internal/provide-liquidity`             |
| shieldClean                 | `*/15 * * * *` (15 min) | `/api/internal/shield-clean`                  |
| recordDacPerformance        | `*/15 * * * *` (15 min) | `/api/internal/record-dac-performance`        |

All schedules are in **UTC**.
(Cloudflare’s free plan allows up to **5 distinct cron expressions**; `syncUserStakes` was consolidated into `*/1 * * * *`.)

---

## 📖 Monitoring & Logs

* **Local tailing (staging):**

  ```bash
  npm run logs:staging
  ```
* **Local tailing (production):**

  ```bash
  npm run logs:prod
  ```
* **Cloudflare Dashboard:** Workers → dc-cron → **Logs**
* Optionally enable **Logpush** to ship logs to S3, BigQuery, etc.

---

## ✅ Best Practices

* Keep internal endpoints **idempotent** so reruns don’t cause duplication.
* Handle errors gracefully in Netlify API handlers (the Worker only fires the POST).
* Use staging for rapid iterations (short cadences).
* Use `ENABLED=false` to temporarily pause jobs without redeploying.

---
