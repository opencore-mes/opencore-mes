#!/usr/bin/env node
// The embedding 1.0 kit (README.md beside this file): a running OpenCore MES checked against what it
// promises a site that frames it, changing nothing; and checkMessage(), for an embedding page's own
// tests of what it receives.
//
//   node docs/contracts/embedding/kit.mjs --url https://plant.example.com --origin https://trainings.example.com [--page /login] [--json]
//   import { runEmbedKit, checkMessage } from "…/kit.mjs"
//     await runEmbedKit({ url, origin, page? }) → { contract, ok, steps }
//
// It reads the headers of the sign-in page (--page, default /login), which anyone may open; on a public
// demo, opening it makes the visitor a guest, as it does for anyone who arrives.
//     checkMessage(message) → [] when it keeps the contract, else what is wrong, in words
//
// It imports nothing of the core.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const contract = () => JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"));

// A message from OpenCore MES (or to it) against the schema's own words: [] or what is wrong.
export function checkMessage(m) {
    const c = contract();
    const problems = [];
    if (!m || typeof m !== "object") return ["not an object"];
    if (m.protocol !== c["x-protocol"]) problems.push(`protocol is not ${c["x-protocol"]}`);
    if (typeof m.version !== "string" || !/^1\.\d+$/.test(m.version)) problems.push("version is not 1.x");
    const spec = c["x-messages"].out[m.type] ?? c["x-messages"].in[m.type];
    if (!spec) return [...problems, `no message is called ${JSON.stringify(m.type)}`];
    const { required = [], properties = {} } = spec.schema;
    for (const k of required) if (!(k in m)) problems.push(`${m.type} has no ${k}`);
    const isType = (v, t) => (t === "null" ? v === null : t === "integer" ? Number.isInteger(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : typeof v === t);
    for (const [k, p] of Object.entries(properties)) {
        if (!(k in m) || ["protocol", "version", "type"].includes(k)) continue;
        const v = m[k];
        const types = p.oneOf ? p.oneOf.map((o) => o.type) : p.$ref ? null : [p.type].flat();
        if (types && !types.some((t) => isType(v, t))) problems.push(`${m.type}.${k} is not ${types.join(" or ")}`);
        if (p.$ref && !c.$defs.kind.enum.includes(v)) problems.push(`${m.type}.${k} is not one of ${c.$defs.kind.enum.join(", ")}`);
        if (typeof v === "string" && p.maxLength && v.length > p.maxLength) problems.push(`${m.type}.${k} is longer than ${p.maxLength}`);
        if (typeof v === "string" && p.minLength && v.length < p.minLength) problems.push(`${m.type}.${k} is empty`);
        if (Number.isInteger(v) && p.minimum !== undefined && v < p.minimum) problems.push(`${m.type}.${k} is below ${p.minimum}`);
    }
    if (m.type === "ready" && m.viewer && (typeof m.viewer.id !== "string" || typeof m.viewer.name !== "string")) problems.push("ready.viewer has no id and name");
    return problems;
}

const ancestorsOf = (csp) => (/(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp ?? "")?.[1] ?? "").trim().split(/\s+/).filter(Boolean);

export async function runEmbedKit({ url, origin, page = "/login", fetchFn = fetch, onStep = () => {} } = {}) {
    const c = contract();
    const steps = [];
    const step = (name, ok, detail = "") => { const s = { name, ok: Boolean(ok), detail: String(detail) }; steps.push(s); try { onStep(s); } catch { /* the listener's */ } return Boolean(ok); };
    const base = String(url ?? "").replace(/\/$/, "");
    const finish = () => ({ contract: `${c["x-contract"].name}@${c["x-contract"].version}`, url: base, origin, ok: steps.every((s) => s.ok), steps });
    try {
        if (!step("an origin to check is given (--origin https://host)", typeof origin === "string" && new URL(origin).origin === origin, origin ?? "none")) return finish();
        const res = await fetchFn(`${base}${page}`, { redirect: "manual" });
        const csp = res.headers.get("content-security-policy");
        if (!step("a page answers with a Content-Security-Policy", csp, `${res.status}${csp ? "" : `, no policy (a redirect? --page names a page anyone may open)`}`)) return finish();
        const ancestors = ancestorsOf(csp);
        step("frame-ancestors names the origin", ancestors.includes(origin), ancestors.join(" ") || "none");
        step("frame-ancestors names nothing broader (no *, no scheme alone, no 'self' needed)", ancestors.every((a) => a !== "*" && !/^[a-z]+:$/i.test(a) && !a.includes("*")), ancestors.join(" "));
        step("X-Frame-Options is left out (it cannot name a site, and would refuse the frame)", !res.headers.get("x-frame-options"), res.headers.get("x-frame-options") ?? "absent");
        step("nothing else may frame it: every origin named is https (http on this machine only)", ancestors.every((a) => /^https:\/\//.test(a) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(a)), ancestors.join(" "));
    } catch (error) {
        step("the kit ran to the end", false, error?.stack ?? String(error));
    }
    return finish();
}

// (Real paths: an npm package's command is a link to this file.)
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
    const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
    const json = process.argv.includes("--json");
    const url = arg("url") ?? "http://127.0.0.1:9090";
    if (!json) console.log(`embedding@${contract()["x-contract"].version}: ${url}, framed by ${arg("origin") ?? "?"}`);
    const result = await runEmbedKit({ url, origin: arg("origin"), page: arg("page") ?? "/login", onStep: (s) => { if (!json) console.log(`  ${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? `: ${s.detail}` : ""}`); } });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.ok ? "keeps the contract" : `does not keep the contract: ${result.steps.filter((s) => !s.ok).length} step(s) failed`);
    process.exit(result.ok ? 0 : 1);
}
