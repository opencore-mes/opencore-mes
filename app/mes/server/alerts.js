// Alerts (COMPLIANCE.md G9): the event log's events that need someone, sent where someone looks. Each event at
// or above a severity (ALERT_MIN_SEVERITY, error by default) is written to the journal as one JSON line (for
// whatever ships logs off the machine) and posted to a webhook (ALERT_WEBHOOK_URL: a chat channel's incoming
// webhook takes `text`; anything else reads `event`). The same kind again within ten minutes is held back, and
// counted in the next one sent, so a storm sends one message, not hundreds. A webhook that fails is said in the
// journal, never retried into a loop, and never stops the instance.
//
//   const alerts = createAlerts({ url, minSeverity, instance })
//   createEventLog({ …, onEvent: alerts.onEvent })
import { SEVERITIES } from "./event-log.js";

export function createAlerts({ url = null, minSeverity = "error", instance = null, fetchFn = fetch, log = console, now = () => Date.now(), quietMs = 10 * 60_000 } = {}) {
    if (!SEVERITIES.includes(minSeverity)) throw new Error(`ALERT_MIN_SEVERITY is one of ${SEVERITIES.join(", ")}: not "${minSeverity}".`);
    if (url) { let u; try { u = new URL(url); } catch { u = null; } if (!u || !/^https?:$/.test(u.protocol)) throw new Error(`ALERT_WEBHOOK_URL is an http(s) address: not "${url}".`); }
    const floor = SEVERITIES.indexOf(minSeverity);
    const last = new Map(); // kind → { at, held }
    const sent = [];
    async function post(event, held) {
        const text = `[${event.severity.toUpperCase()}] ${instance ?? event.instance}: ${event.message}${held ? ` (and ${held} more like it in the last minutes)` : ""}`;
        try {
            const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, event }), signal: AbortSignal.timeout(5000) });
            if (!res.ok) log.error?.(`alerts: the webhook answered ${res.status} for ${event.kind}`);
            sent.push({ kind: event.kind, status: res.status });
        } catch (error) {
            log.error?.(`alerts: the webhook failed for ${event.kind}: ${error.message}`);
        }
    }
    return {
        sent,
        onEvent(event) {
            if (SEVERITIES.indexOf(event.severity) < floor) return;
            log.error?.(`alert ${JSON.stringify({ kind: event.kind, severity: event.severity, instance: event.instance, at: event.at, message: event.message, seq: event.seq })}`);
            if (!url) return;
            const t = now();
            const was = last.get(event.kind);
            if (was && t - was.at < quietMs) { was.held++; return; }
            last.set(event.kind, { at: t, held: 0 });
            post(event, was?.held ?? 0);
        },
    };
}
