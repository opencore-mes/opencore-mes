// The AI design API (DESIGN.md §16): a REST service at /ai/v1/ through which Claude, or any other AI,
// works in the designer for one person. It reads the model catalog and the rules the designer
// follows, drafts change requests, and checks its own work (validation, script tests, the rule pipe,
// access simulation, the approval route) before a person submits it for review.
//
// What it never does: review, approve or execute. Those need a person (§5). Submitting is a scope of
// its own, off unless the token was given it. Every draft an AI makes is recorded on the change
// request (`ai_edits`) and in the audit trail, so its reviewers see what the AI wrote.
//
// Authentication is a bearer token (`Authorization: Bearer mes_…`), never a cookie, so no page on
// another site can call it on a signed-in browser's behalf. Only the token's hash is stored.
import { createHash, randomBytes } from "node:crypto";
import { readBody } from "../../../src/server/http.js";
import { designTools } from "./design-tools.js";
import { appendAudit } from "./audit.js";
import { apiContract } from "./api-contract.js";
import { operationOf } from "../../../docs/contracts/http-apis/surface.mjs";

export const SCOPES = ["design:read", "design:draft", "design:submit", "service:call"];
const DEFAULT_SCOPES = ["design:read", "design:draft"];
const PREFIX = "/ai/v1";
const MAX_BODY = 512 * 1024;
const MAX_MODEL_BODY = 16 * 1024 * 1024;
const RATE = { perMinute: 240 };

const hashOf = (token) => createHash("sha256").update(token).digest("hex");
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---- tokens ------------------------------------------------------------------------------------
// A token lasts `days` (TOKEN_DAYS by default, at most TOKEN_MAX_DAYS) and then answers nobody. Issuing
// and revoking one is in the audit trail ($auth), whoever does it (the designer's page, a command).
export const TOKEN_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;
export function createTokens(db) {
    const audited = (actor, action, after) => db.transaction((tx) => appendAudit(tx, { actor, object: "$auth", action, after }));
    return {
        async issue(userId, { name, agent = "", scopes = DEFAULT_SCOPES, days = TOKEN_DAYS, by = userId }) {
            if (typeof name !== "string" || !name.trim() || name.length > 80) throw Object.assign(new Error("Name the token (who or what will use it)."), { expose: true, status: 400 });
            const wanted = [...new Set(scopes)];
            if (!wanted.length || !wanted.every((s) => SCOPES.includes(s))) throw Object.assign(new Error(`Scopes are ${SCOPES.join(", ")}.`), { expose: true, status: 400 });
            if (!Number.isInteger(days) || days < 1 || days > TOKEN_MAX_DAYS) throw Object.assign(new Error(`A token lasts 1 to ${TOKEN_MAX_DAYS} days.`), { expose: true, status: 400 });
            const token = `mes_${randomBytes(24).toString("base64url")}`;
            const [row] = await db.query(
                "INSERT INTO mes.api_tokens (user_id, name, agent, scopes, hash, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id, name, agent, scopes, created_at, expires_at",
                [userId, name.trim(), String(agent).slice(0, 80), wanted, hashOf(token), days],
            );
            await audited(by, "token issued", { token: row.id, user: userId, name: row.name, agent: row.agent, scopes: wanted, expires: new Date(row.expires_at).toISOString() });
            return { ...row, token }; // the only time the token is seen
        },
        list: (userId) => db.query("SELECT id, name, agent, scopes, created_at, last_used, revoked_at, expires_at FROM mes.api_tokens WHERE user_id = $1 ORDER BY created_at DESC", [userId]),
        async revoke(userId, id, { by = userId } = {}) {
            const rows = await db.query("UPDATE mes.api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id, name", [id, userId]);
            if (rows.length) await audited(by, "token revoked", { token: id, user: userId, name: rows[0].name });
            return rows;
        },
        async resolve(token) {
            if (typeof token !== "string" || !token.startsWith("mes_") || token.length > 100) return null;
            const [row] = await db.query(
                `UPDATE mes.api_tokens t SET last_used = now() FROM mes.users u
                 WHERE t.hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.id = t.user_id AND u.active
                 RETURNING t.id, t.name, t.agent, t.scopes, u.id AS user_id, u.name AS user_name`,
                [hashOf(token)],
            );
            return row ?? null;
        },
    };
}

// ---- the OpenAPI description --------------------------------------------------------------------
export function openapi(origin) {
    const json = (schema = { type: "object" }) => ({ content: { "application/json": { schema } } });
    const ok = (description) => ({ 200: { description, ...json() }, 400: { description: "Refused, with words and fields" }, 401: { description: "No or bad token" }, 403: { description: "Missing scope or right" } });
    const op = (summary, scope, extra = {}) => ({ summary, description: `Scope: ${scope}.`, security: [{ bearer: [] }], responses: ok(summary), ...extra });
    const body = (props) => ({ requestBody: { required: true, ...json({ type: "object", properties: props }) } });
    const id = [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }];
    return {
        openapi: "3.1.0",
        info: { title: "OpenCore MES AI design API", version: "1.0.0", description: "Work in the OpenCore MES designer as a person, through a token: read the catalog and the contract, draft change requests, and check the draft. Review, approval and execution are never available here." },
        servers: [{ url: `${origin}${PREFIX}` }],
        components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A token issued in the designer (AI access)." } } },
        paths: {
            "/me": { get: op("Who the token acts for, and its scopes", "any") },
            "/contract": { get: op("The rules a design must follow: identifiers, field types, policies, expressions, rule scripts, lifecycle", "design:read") },
            "/contracts/{name}": { get: op("A published contract (docs/contracts): its specification, schema, changelog and conformance kit, e.g. equipment-adapter", "design:read", { parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }] }) },
            "/catalog": { get: op("Every published object's definition, the departments, and the published scripts", "design:read") },
            "/objects/{object}": { get: op("One published definition", "design:read", { parameters: [{ name: "object", in: "path", required: true, schema: { type: "string" } }] }) },
            "/scripts/{name}": { get: op("A published script's source", "design:read", { parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }] }) },
            "/changes": {
                get: op("Change requests, newest first", "design:read"),
                post: op("Start a change request for one object, service, connection, transaction, screen or flow: edit a live one (its body is the draft) or create one", "design:draft", body({ object: { type: "string" }, service: { type: "string" }, connection: { type: "string" }, flow: { type: "string" }, transaction: { type: "string" }, screen: { type: "string" }, organization: { type: "boolean" }, label: { type: "string" } })),
            },
            "/model": { get: op("Every published design as one model file, to carry to another installation: designs only (no records, secrets, people or history)", "design:read") },
            "/model/preview": { post: op("What a model file would change here, nothing written: each design new, changed or the same; roles; problems; what this installation lacks", "design:read", body({ file: { type: "object" } })) },
            "/model/changes": { post: op("Start one change request holding every design of a model file that is new or different here", "design:draft", body({ file: { type: "object" } })) },
            "/changes/{id}": {
                get: op("A change request: its draft, problems, footprint, approval route and AI edits", "design:read", { parameters: id }),
                put: op("Save the draft (design stage only): whole definitions, services, connections and transactions, and scripts; one set to null is dropped from the change", "design:draft", { parameters: id, ...body({ title: { type: "string" }, reason: { type: "string" }, definitions: { type: "object" }, scripts: { type: "object" }, services: { type: "object" }, connections: { type: "object" }, transactions: { type: "object" }, screens: { type: "object" }, flows: { type: "object" }, layouts: { type: "object" }, organization: { type: "object" } }) }),
            },
            "/changes/{id}/include": { post: op("Bring a live object, transaction, screen, flow, service or connection into the change, to change it with the rest: one review, one approval per department, executed all or nothing", "design:draft", { parameters: id, ...body({ kind: { type: "string", enum: ["object", "transaction", "screen", "flow", "layout", "service", "connection"] }, name: { type: "string" } }) }) },
            "/changes/{id}/fitness": { post: op("Run the fitness test on the draft (what submitting runs): failures, warnings, access changes", "design:read", { parameters: id }) },
            "/changes/{id}/submit": { post: op("Submit the change for review (a person usually does this)", "design:submit", { parameters: id }) },
            "/validate": { post: op("Validate a draft without saving it: problems, footprint and approval route", "design:read", body({ definitions: { type: "object" }, scripts: { type: "object" }, services: { type: "object" }, connections: { type: "object" }, transactions: { type: "object" }, screens: { type: "object" }, flows: { type: "object" }, layouts: { type: "object" } })) },
            "/flows/{name}": { get: op("One published flow (§32), and in plain words", "design:read", { parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }] }) },
            "/flows/check": { post: op("Check a flow: problems by node and edge, and what is missing to run it", "design:read", body({ id: { type: "string" }, name: { type: "string" }, flow: { type: "object" }, definitions: { type: "object" } })) },
            "/flows/layout": { post: op("Place a flow's nodes so it reads on the canvas", "design:read", body({ flow: { type: "object" } })) },
            "/flows/explain": { post: op("A flow in plain words", "design:read", body({ flow: { type: "object" }, id: { type: "string" }, name: { type: "string" } })) },
            "/flows/walk": { post: op("An input flow walked with sample values: what it asks, fills and runs, in order", "design:read", body({ flow: { type: "object" }, id: { type: "string" }, name: { type: "string" }, values: { type: "object" } })) },
            "/scenarios/try": { post: op("Try a scenario on a change's draft in a sandbox: each step's outcome and the nodes reached; nothing saved", "design:read", body({ id: { type: "string" }, transaction: { type: "string" }, flow: { type: "string" }, scenario: { type: "object" } })) },
            "/scripts/{name}/test": { post: op("Run a script's test cases in the sandbox (the given source, or the published one)", "design:read", { parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }], ...body({ source: { type: "string" }, tests: { type: "array" } }) }) },
            "/pipe/run": { post: op("Run an object's whole rule pipe on a context, with draft definition and scripts if given", "design:read", body({ object: { type: "string" }, definition: { type: "object" }, scripts: { type: "object" }, ctx: { type: "object" }, lookups: { type: "object" } })) },
            "/dry-run": { post: op("Execute a draft service or rule script, changing nothing: output, would-be writes and requests, reads, and any error with its line", "design:read", body({ kind: { type: "string", enum: ["service", "rule"] }, name: { type: "string" }, source: { type: "string" }, service: { type: "object" }, connections: { type: "object" }, run: { type: "object" } })) },
            "/access/simulate": { post: op("What a user with these roles may read, write and do on a record in a state; optionally why for one field or action", "design:read", body({ object: { type: "string" }, definition: { type: "object" }, roles: { type: "array" }, record: { type: "object" }, explain: { type: "object" } })) },
        },
    };
}

// ---- the handler -------------------------------------------------------------------------------
// `invalidate(targets)` is the server's own (Juris): what an AI drafts reaches every open page, as a
// person's save does through the page's own call.
// `contract` (api-contract.js): the version every answer says, and the deprecated operations' notice.
export function aiApi({ store, services, tokens, log = console, origin = "", invalidate = async () => {}, contract = apiContract() }) {
    const buckets = new Map();
    const withinRate = (key) => {
        const now = Date.now();
        const b = buckets.get(key) ?? { tokens: RATE.perMinute, at: now };
        b.tokens = Math.min(RATE.perMinute, b.tokens + ((now - b.at) / 60000) * RATE.perMinute);
        b.at = now;
        buckets.set(key, b);
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        return true;
    };
    // Every answer says which version of the contract it keeps (API-Version), and one to a deprecated
    // operation also when it was deprecated, its sunset and its successor (docs/contracts/http-apis).
    let described = null;
    const operation = (req, path) => operationOf(req.method, path, (described ??= openapi("")));
    const send = (res, status, body, headers = contract.headers(PREFIX, null)) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
        res.end(JSON.stringify(body));
        return true;
    };
    const refuse = (res, error) => {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        if (status >= 500 || error?.expose !== true) {
            log.error?.("ai api:", error);
            return send(res, status >= 500 ? status : 400, { error: status >= 500 ? "The request failed." : "The request was refused." });
        }
        return send(res, status, { error: error.message, ...(error.fields ? { fields: error.fields } : {}), ...(error.code ? { code: error.code } : {}) });
    };
    // Every route is one design tool (design-tools.js), the same the in-app copilot uses.
    const tools = designTools({ store, services });
    // A tool that changes a change request re-runs that change's live views and the designer's home.
    const CHANGES = new Set(["start_change", "add_to_change", "save_draft", "submit_change", "start_change_from_model_file"]);
    const use = (name, input) => async (who, _params, _body, agent) => {
        const args = input(_params, _body ?? {});
        const result = await tools[name].run(who, args, agent);
        if (CHANGES.has(name)) {
            const id = args.id ?? result?.id;
            await invalidate([{ name: "design.home" }, ...(id ? [{ name: "design.change", where: { id } }] : [])]).catch((e) => log.error?.("ai api: invalidate", e));
        }
        return result;
    };
    const routes = [
        ["GET", /^\/me$/, async (who) => ({ user: { id: who.user_id, name: who.user_name }, token: who.name, agent: who.agent, scopes: who.scopes })],
        ["GET", /^\/contract$/, use("get_contract", () => ({}))],
        // A published contract by name (docs/contracts, §31): its specification and schema.
        ["GET", /^\/contracts\/([a-z][a-z0-9-]{0,47})$/, use("get_contract", ([name]) => ({ name }))],
        ["GET", /^\/catalog$/, use("get_catalog", () => ({}))],
        ["GET", /^\/objects\/([a-z][a-z0-9_]{0,47})$/, use("get_object", ([object]) => ({ object }))],
        ["GET", /^\/scripts\/([a-z][a-z0-9_]{0,47})$/, use("get_script", ([name]) => ({ name }))],
        ["GET", /^\/changes$/, use("list_changes", () => ({}))],
        // A model file (§24.1): every design as one file; what one would change here; a change from one.
        ["GET", /^\/model$/, use("export_model", () => ({}))],
        ["POST", /^\/model\/preview$/, use("preview_model_file", (_, body) => ({ file: body.file }))],
        ["POST", /^\/model\/changes$/, use("start_change_from_model_file", (_, body) => ({ file: body.file }))],
        ["POST", /^\/changes$/, use("start_change", (_, body) => ({ object: body.object, service: body.service, connection: body.connection, transaction: body.transaction, screen: body.screen, flow: body.flow, layout: body.layout, element: body.element, kind: body.kind, organization: body.organization, label: body.label, from: body.from }))],
        // Flows (§32): read, check, lay out, explain; an input flow walked (§32.13).
        ["GET", /^\/flows\/([a-z][a-z0-9_]{0,47})$/, use("get_flow", ([name]) => ({ name }))],
        ["POST", /^\/flows\/check$/, use("check_flow", (_, body) => body)],
        ["POST", /^\/flows\/layout$/, use("layout_flow", (_, body) => body)],
        ["POST", /^\/flows\/explain$/, use("explain_flow", (_, body) => body)],
        ["POST", /^\/flows\/walk$/, use("walk_input_flow", (_, body) => body)],
        ["POST", /^\/scenarios\/try$/, use("try_scenario", (_, body) => body)],
        ["GET", /^\/changes\/([0-9a-f-]{36})$/, use("get_change", ([id]) => ({ id }))],
        ["PUT", /^\/changes\/([0-9a-f-]{36})$/, use("save_draft", ([id], body) => ({ ...body, id }))],
        ["POST", /^\/changes\/([0-9a-f-]{36})\/include$/, use("add_to_change", ([id], body) => ({ id, kind: body.kind, name: body.name }))],
        ["POST", /^\/changes\/([0-9a-f-]{36})\/submit$/, use("submit_change", ([id]) => ({ id }))],
        ["POST", /^\/validate$/, use("validate", (_, body) => body)],
        ["POST", /^\/scripts\/([a-z][a-z0-9_]{0,47})\/test$/, use("test_script", ([name], body) => ({ ...body, name }))],
        ["POST", /^\/pipe\/run$/, use("run_pipe", (_, body) => body)],
        ["POST", /^\/access\/simulate$/, use("simulate_access", (_, body) => body)],
        ["POST", /^\/dry-run$/, use("dry_run", (_, body) => body)],
        ["POST", /^\/changes\/([0-9a-f-]{36})\/fitness$/, use("run_fitness", ([id]) => ({ id }))],
    ];

    return async (req, res, url) => {
        if (!url.pathname.startsWith(`${PREFIX}/`) && url.pathname !== PREFIX) return false;
        const path = url.pathname.slice(PREFIX.length) || "/";
        try {
            if (req.method === "GET" && path === "/openapi.json") return send(res, 200, openapi(origin || `http://${req.headers.host}`));
            const auth = req.headers.authorization ?? "";
            const who = auth.startsWith("Bearer ") ? await tokens.resolve(auth.slice(7).trim()) : null;
            if (!who) return send(res, 401, { error: "A bearer token is required: issue one in the designer (AI access).", code: "token.missing" });
            if (!withinRate(who.id)) return send(res, 429, { error: "Too many requests; slow down.", code: "rate.limited" });
            // The token acts as its person, never as more: once the designer is no longer shared with
            // them, it reads no design and runs no script, as they would not.
            if (!(await store.rolesFor(who.user_id, "design")).length) return send(res, 403, { error: "The designer is no longer shared with this token's person.", code: "design.unshared" });
            const route = routes.find(([method, pattern]) => method === req.method && pattern.test(path));
            if (!route) return send(res, 404, { error: `No ${req.method} ${PREFIX}${path}. See ${PREFIX}/openapi.json.` });
            let body = null;
            if (req.method === "POST" || req.method === "PUT") {
                if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "Send JSON (application/json)." });
                // (A model file holds a whole model's designs: more than a draft does.)
                const raw = await readBody(req, { limit: path.startsWith("/model/") ? MAX_MODEL_BODY : MAX_BODY });
                if (raw === null) return send(res, 413, { error: "The body is too large." });
                try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { return send(res, 400, { error: "The body is not JSON." }); }
            }
            const op = operation(req, path);
            if (contract.notice(PREFIX, op)) contract.used(PREFIX, op, `${who.user_id} (token ${who.name})`);
            const answer = await route[2](who, path.match(route[1]).slice(1), body, req.headers["x-ai-agent"]);
            return send(res, 200, answer ?? { ok: true }, contract.headers(PREFIX, op));
        } catch (error) {
            return refuse(res, error);
        }
    };
}
