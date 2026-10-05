#!/usr/bin/env node
// The http-apis 1.0 kit (README.md beside this file): a running OpenCore MES checked against what /ai/v1
// and /svc/v1 promise, call by call, changing nothing.
//
//   node docs/contracts/http-apis/kit.mjs --url http://127.0.0.1:9090 --token <token> [--service <name> --input '<json>'] [--json]
//   import { runApiKit } from "…/kit.mjs"; await runApiKit({ url, token, service?, input? }) → { contract, ok, steps }
//
// The token needs design:read for /ai/v1 and service:call for /svc/v1; a scope it lacks is checked as a
// refusal instead. It imports nothing of the core.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { surfaceOf, compareSurface } from "./surface.mjs";

export const contract = () => JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"));

export async function runApiKit({ url, token, service = null, input = {}, fetchFn = fetch, onStep = () => {} } = {}) {
    const c = contract();
    const version = c["x-contract"].version;
    const steps = [];
    const step = (name, ok, detail = "", extra = {}) => { const s = { name, ok: Boolean(ok), ...extra, detail: String(detail) }; steps.push(s); try { onStep(s); } catch { /* the listener's */ } return Boolean(ok); };
    const skip = (name, detail) => { const s = { name, ok: true, skipped: true, detail }; steps.push(s); try { onStep(s); } catch { /* idem */ } };
    const base = String(url ?? "").replace(/\/$/, "");
    const ask = async (method, p, { auth = true, body, type = "application/json", headers = {} } = {}) => {
        const res = await fetchFn(`${base}${p}`, { method, headers: { ...(auth && token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": type } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON: said by the step */ }
        return { status: res.status, json, headers: res.headers };
    };
    const versioned = (r) => r.headers.get("api-version") === version;
    const errorShape = (r) => r.json && typeof r.json.error === "string" && r.json.error.trim().length > 0 && (r.json.code === undefined || typeof r.json.code === "string");
    const finish = () => ({ contract: `${c["x-contract"].name}@${version}`, url: base, ok: steps.every((s) => s.ok), steps });
    try {
        // ---- /ai/v1 ----
        const doc = await ask("GET", "/ai/v1/openapi.json", { auth: false });
        if (!step("/ai/v1 describes itself (openapi.json), saying the contract's version", doc.status === 200 && doc.json?.openapi && versioned(doc), `${doc.status}, API-Version ${doc.headers.get("api-version")}`)) return finish();
        const { breaking, unpromised } = compareSurface(c["x-apis"]["/ai/v1"].surface, surfaceOf(doc.json));
        step("/ai/v1 keeps every promised operation: its scope, its path parameters, every field it reads", !breaking.length, breaking.join("; ") || `${Object.keys(c["x-apis"]["/ai/v1"].surface).length} operations`);
        step("/ai/v1 offers nothing the contract does not list (a minor version writes it down first)", !unpromised.length, unpromised.join("; ") || "nothing");
        const anon = await ask("GET", "/ai/v1/me", { auth: false });
        step("no token: 401, the error envelope with its code, versioned", anon.status === 401 && errorShape(anon) && anon.json.code === "token.missing" && versioned(anon), `${anon.status} ${JSON.stringify(anon.json)}`);
        const me = await ask("GET", "/ai/v1/me");
        // A token whose person has no designer (an integration user): /ai/v1 refuses it, in words.
        const unshared = me.status === 403 && me.json?.code === "design.unshared";
        const scopes = Array.isArray(me.json?.scopes) ? me.json.scopes : unshared ? ["service:call"] : [];
        if (unshared) step("a token whose person has no designer: /ai/v1 refuses it (403), in the error envelope", errorShape(me) && versioned(me), me.json.error);
        else if (!step("the token: who it acts for, and its scopes", me.status === 200 && versioned(me) && me.json?.user?.id, `${me.status} ${me.json?.user?.id ?? ""} ${scopes.join(", ")}`)) return finish();
        if (unshared) { /* nothing more of /ai/v1 to ask as it */ } else if (scopes.includes("design:read")) {
            for (const p of ["/contract", "/catalog", "/changes", "/model"]) {
                const r = await ask("GET", `/ai/v1${p}`);
                step(`GET /ai/v1${p} answers JSON, versioned`, r.status === 200 && r.json !== null && versioned(r), `${r.status}`);
            }
        } else {
            const r = await ask("GET", "/ai/v1/catalog");
            step("without design:read, a read is refused (403), in the error envelope", r.status === 403 && errorShape(r) && versioned(r), `${r.status} ${JSON.stringify(r.json)}`);
        }
        if (!unshared) {
            const nope = await ask("GET", "/ai/v1/no-such-operation");
            step("an operation /ai/v1 does not have: 404, the error envelope", nope.status === 404 && errorShape(nope) && versioned(nope), `${nope.status}`);
            const plain = await ask("POST", "/ai/v1/validate", { body: "x", type: "text/plain" });
            step("a body that is not JSON: 415, the error envelope", plain.status === 415 && errorShape(plain) && versioned(plain), `${plain.status}`);
        }
        const deprecated = Object.entries(c["x-deprecated"]?.["/ai/v1"] ?? {});
        const reachable = deprecated.filter(([op]) => op.startsWith("GET ") && !op.includes("{"));
        if (!deprecated.length) skip("a deprecated operation answers with Deprecation, Sunset and Link", "nothing is deprecated in this version");
        for (const [op, notice] of reachable) {
            const r = await ask("GET", `/ai/v1${op.slice(4)}`);
            step(`${op}, deprecated: Deprecation and Sunset on its answer`, r.headers.get("deprecation") && r.headers.get("sunset"), `${r.headers.get("deprecation")} · ${r.headers.get("sunset")} (since ${notice.since})`);
        }

        // ---- /svc/v1 ----
        const svcAnon = await ask("GET", "/svc/v1/openapi.json", { auth: false });
        step("/svc/v1 with no token: 401, the error envelope with its code, versioned", svcAnon.status === 401 && errorShape(svcAnon) && svcAnon.json.code === "token.missing" && versioned(svcAnon), `${svcAnon.status}`);
        if (!scopes.includes("service:call")) {
            const r = await ask("GET", "/svc/v1/openapi.json");
            step("without service:call: 403, code scope.missing", r.status === 403 && r.json?.code === "scope.missing" && versioned(r), `${r.status} ${JSON.stringify(r.json)}`);
            return finish();
        }
        const svcDoc = await ask("GET", "/svc/v1/openapi.json");
        step("/svc/v1 describes the web services this token's person may call, versioned", svcDoc.status === 200 && svcDoc.json?.openapi && typeof svcDoc.json.paths === "object" && versioned(svcDoc), `${svcDoc.status}: ${Object.keys(svcDoc.json?.paths ?? {}).length} service(s)`);
        const missing = await ask("POST", `/svc/v1/kit_no_such_service_${randomBytes(3).toString("hex")}`, { body: {} });
        step("a web service there is not: 404, the error envelope", missing.status === 404 && errorShape(missing) && versioned(missing), `${missing.status}`);
        const first = Object.keys(svcDoc.json?.paths ?? {})[0];
        if (first) {
            const r = await ask("POST", `/svc/v1${first}`, { body: "x", type: "text/plain" });
            step(`a body that is not JSON (POST /svc/v1${first}): 415, nothing run`, r.status === 415 && errorShape(r) && versioned(r), `${r.status}`);
            for (const [p, item] of Object.entries(svcDoc.json.paths)) if (item.post?.deprecated) step(`/svc/v1${p} is deprecated and says until when`, /Deprecated since \d{4}-\d{2}-\d{2}; it may change or go after \d{4}-\d{2}-\d{2}/.test(item.post.description ?? ""), item.post.description ?? "");
        } else skip("a body that is not JSON is refused", "this token's person may call no web service");
        if (service) {
            const key = `kit-${randomBytes(8).toString("hex")}`;
            const a = await ask("POST", `/svc/v1/${service}`, { body: input, headers: { "idempotency-key": key } });
            step(`POST /svc/v1/${service}: answered, versioned`, a.status < 500 && a.json !== null && versioned(a) && (a.status === 200 || errorShape(a)), `${a.status} ${JSON.stringify(a.json).slice(0, 200)}`);
            const b = await ask("POST", `/svc/v1/${service}`, { body: input, headers: { "idempotency-key": key } });
            step("the same Idempotency-Key: the first answer, again", b.status === a.status && JSON.stringify(b.json) === JSON.stringify(a.json), `${b.status}`);
            const notice = svcDoc.json?.paths?.[`/${service}`]?.post?.deprecated;
            if (notice) step(`${service} is deprecated: Deprecation and Sunset on its answer`, a.headers.get("deprecation") && a.headers.get("sunset"), `${a.headers.get("deprecation")} · ${a.headers.get("sunset")} · ${a.headers.get("link") ?? ""}`);
        } else skip("a call and its retry (Idempotency-Key)", "no --service given");
    } catch (error) {
        step("the kit ran to the end", false, error?.stack ?? String(error));
    }
    return finish();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
    const json = process.argv.includes("--json");
    const url = arg("url") ?? "http://127.0.0.1:9090";
    if (!json) console.log(`http-apis@${contract()["x-contract"].version}: ${url}`);
    const result = await runApiKit({ url, token: arg("token") ?? process.env.MES_TOKEN, service: arg("service") ?? null, input: arg("input") ? JSON.parse(arg("input")) : {}, onStep: (s) => { if (!json) console.log(`  ${s.skipped ? "-" : s.ok ? "✓" : "✗"} ${s.name}${s.detail ? `: ${s.detail}` : ""}`); } });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.ok ? "keeps the contract" : `does not keep the contract: ${result.steps.filter((s) => !s.ok).length} step(s) failed`);
    process.exit(result.ok ? 0 : 1);
}
