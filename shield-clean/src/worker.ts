export interface Env {
  TARGET_URL: string;
  INTERNAL_API_KEY: string;
}

export default {
  async fetch(): Promise<Response> {
    // health endpoint: GET returns ok (useful for manual tests)
    return new Response('ok', { status: 200 });
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(
      fetch(env.TARGET_URL, {
        method: 'POST',
        headers: { 'Internal-Authorization': env.INTERNAL_API_KEY }
      }).then(async res => {
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`POST ${env.TARGET_URL} -> ${res.status} ${body}`);
        }
      })
    );
  }
};
