Here’s a ready-to-drop **`README.md`** for your `dc-cron` repo. It documents installation, project structure, usage (dev/test/deploy), and your new **feature flag toggle** approach for enabling/disabling prod workers.

---

```markdown
# DaiChronicles Cron Workers

This repo contains **Cloudflare Workers + Cron Triggers** that periodically call internal API endpoints of [DaiChronicles](https://daichronicles.io).  
Each job is deployed as its **own Worker**, with its own cron schedule, staging and production configs, and secrets.

---

## ⚡ Project Organization

```

dc-cron/
package.json
tsconfig.json
.gitignore
create-daily-chronicles/
wrangler.jsonc
src/worker.ts
process-incomplete-chronicles/
wrangler.jsonc
src/worker.ts
sync-chronicles-updates/
wrangler.jsonc
src/worker.ts
sync-user-stakes/
wrangler.jsonc
src/worker.ts
provide-liquidity/
wrangler.jsonc
src/worker.ts
shield-clean/
wrangler.jsonc
src/worker.ts
record-dac-performance/
wrangler.jsonc
src/worker.ts

````

- **One worker per job** → easier isolation and toggling.
- Each worker shares the same `src/worker.ts` template.
- Schedules are defined in each `wrangler.jsonc`.
- Environments:
  - **staging** → `https://staging-daichronicles.netlify.app`
  - **production** → `https://daichronicles.io`

---

## 🛠 Installation

1. Install Node 18+ and npm/pnpm.
2. Install Wrangler (global or via npx):
   ```bash
   npm i -g wrangler@latest
   wrangler login
````

3. Clone this repo:

   ```bash
   git clone https://github.com/<your-org>/dc-cron.git
   cd dc-cron
   npm install
   ```

---

## ▶️ Development & Local Testing

Each worker can be run locally and its cron simulated.

Example (sync-chronicles-updates):

```bash
npm run dev:sync-updates
```

Wrangler starts at `http://127.0.0.1:8787`. To simulate the cron:

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*/1%20*%20*%20*%20*"
```

---

## 🚀 Deployment

Deploy to **staging**:

```bash
npm run deploy:sync-updates:staging
```

Deploy to **production**:

```bash
npm run deploy:sync-updates:prod
```

Repeat for any other worker (`create-daily`, `provide-liquidity`, etc.).

---

## 🔑 Secrets

Each Worker requires:

* `INTERNAL_API_KEY` → the shared secret for the Netlify API routes
* `ENABLED` (optional) → feature flag toggle (`true`/`false`)

Set them with Wrangler:

```bash
# staging
wrangler secret put INTERNAL_API_KEY --env staging --config sync-chronicles-updates/wrangler.jsonc
wrangler secret put ENABLED --env staging --config sync-chronicles-updates/wrangler.jsonc

# production
wrangler secret put INTERNAL_API_KEY --env production --config sync-chronicles-updates/wrangler.jsonc
wrangler secret put ENABLED --env production --config sync-chronicles-updates/wrangler.jsonc
```

---

## ⏯ Enabling / Disabling Workers (Feature Flag)

Workers check the `ENABLED` secret at runtime:

```ts
if ((env.ENABLED ?? "true") !== "true") {
  console.log(`[disabled] skipping cron ${ev.cron}`)
  return
}
```

* **Disable a prod worker:**

  ```bash
  wrangler secret put ENABLED --env production --config sync-chronicles-updates/wrangler.jsonc
  # enter: false
  ```
* **Enable again:**

  ```bash
  wrangler secret put ENABLED --env production --config sync-chronicles-updates/wrangler.jsonc
  # enter: true
  ```

This does not require a redeploy. Secrets update immediately.

---

## 📜 Cron Jobs (UTC)

| Job                         | Schedule                | Endpoint                                      |
| --------------------------- | ----------------------- | --------------------------------------------- |
| createDailyChronicles       | `0,30 6-23 * * *`       | `/api/internal/create-daily-chronicles`       |
| processIncompleteChronicles | `15 7-9 * * *`          | `/api/internal/process-incomplete-chronicles` |
| syncChroniclesUpdates       | `*/1 * * * *` (1 min)   | `/api/internal/sync-chronicles-updates`       |
| syncUserStakes              | `*/2 * * * *` (2 min)   | `/api/internal/sync-user-stakes`              |
| provideLiquidity            | `0 * * * *` (hourly)    | `/api/internal/provide-liquidity`             |
| shieldClean                 | `*/15 * * * *` (15 min) | `/api/internal/shield-clean`                  |
| recordDacPerformance        | `*/15 * * * *` (15 min) | `/api/internal/record-dac-performance`        |

All schedules are in **UTC**. If you need Europe/Dublin times, adjust cron expressions accordingly.

---

## 📖 Monitoring & Logs

* **Local tailing:**

  ```bash
  wrangler tail --env staging --config sync-chronicles-updates/wrangler.jsonc
  ```
* **Dashboard:** Cloudflare → Workers → \[Worker] → **Logs**
* Optionally enable **Logpush** to ship logs to S3, BigQuery, etc.

---

## ✅ Best Practices

* Keep endpoints **idempotent** so reruns don’t cause duplication.
* Handle errors gracefully in your Netlify API handlers (Workers only fire the POST).
* For staging, use shorter cadences (1–2 min). For prod, align with your business schedule.
* Use `ENABLED=false` when you need to temporarily pause jobs without redeploying.
