/**
 * Auto-playbook webhook — posts a notification to the Vercel app after
 * each new slot is captured. Skipped silently when env vars are unset.
 */

export interface WebhookConfig {
  baseUrl: string | null;
  secret: string | null;
}

interface WebhookPayload {
  tradingDate: string;
  capturedAt: string;
  slotKey: string;
}

interface WebhookResult {
  skipped: boolean;
  ok: boolean;
  error?: string;
  status?: number;
  attempts: number;
}

export function loadWebhookConfig(): WebhookConfig {
  return {
    baseUrl: (process.env.VERCEL_BASE_URL ?? '').trim() || null,
    secret: (process.env.PERISCOPE_WEBHOOK_SECRET ?? '').trim() || null,
  };
}

export async function postPlaybookWebhook(
  payload: WebhookPayload,
  config: WebhookConfig,
): Promise<WebhookResult> {
  if (config.baseUrl == null || config.secret == null) {
    return { skipped: true, ok: true, attempts: 0 };
  }

  const url = `${config.baseUrl}/api/periscope-webhook`;
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': config.secret,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        return { skipped: false, ok: true, status: res.status, attempts: attempt };
      }
      if (attempt === MAX_ATTEMPTS) {
        return {
          skipped: false,
          ok: false,
          status: res.status,
          attempts: attempt,
          error: `HTTP ${res.status}`,
        };
      }
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        return {
          skipped: false,
          ok: false,
          attempts: attempt,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return { skipped: false, ok: false, attempts: MAX_ATTEMPTS, error: 'max attempts' };
}
