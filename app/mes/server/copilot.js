// The designer's copilot (DESIGN.md §16.3): a conversation, inside one change request, with the AI the
// gateway provides (Claude, or any OpenAI-compatible model). The model works through the same design
// tools as the REST API (design-tools.js), as the person who asks, and drafts only: it saves the draft
// and checks its work, and a person submits, reviews and approves. What it drafts is recorded on the
// change ("Drafted with AI").
//
// The loop runs on the server. A turn can take a while (the model thinks, calls tools, reads their
// answers), so `copilot.send` starts it and answers at once; the page reads the transcript as it grows
// (`copilot.get`). A conversation is one per person and change request, kept with the change
// (mes.copilot_conversations): what the model was told and answered, and what the person reads, saved
// as it grows, so it resumes any time, after a reload, a later visit or a restart. A run that a stopped
// process left half done is said so, and the person asks it to go on.
import { fail } from "../../../src/errors.js";
import { designTools, contract } from "./design-tools.js";

const MAX_STEPS = 24;
// A conversation kept as running that nothing has saved for this long was left by a process that stopped.
const STALE_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 24000;
// What the copilot may use: everything but submitting (a person submits) and starting other changes.
const COPILOT_TOOLS = ["get_contract", "get_catalog", "get_object", "get_script", "get_change", "add_to_change", "save_draft", "validate", "test_script", "run_pipe", "simulate_access", "dry_run", "run_fitness", "get_flow", "check_flow", "layout_flow", "explain_flow", "walk_input_flow"];

// The tools that name a change request by its id.
const ON_ITS_CHANGE = ["get_change", "add_to_change", "save_draft", "run_fitness"];
// How many messages a person, and this instance in all, may send it: each one may be two dozen calls to
// the model on the plant's account, and on a public demo anyone may send them.
const SENDS = { perPerson: 30, perInstance: 300, everyMs: 60 * 60_000 };

const SYSTEM = `You are the design copilot of OpenCore MES, a low-code manufacturing execution system in which plant objects (their fields, states, roles, access policies, rule scripts, screens and stewards) are defined as data by the people who run the plant.

The person may attach files to a message: a picture (a paper form, a whiteboard, a drawing), a PDF (a work instruction, a spec, a procedure) or a spreadsheet (given to you as its rows). Read them for what to design (the fields a form has, the steps a procedure takes, the values a list holds) and say what you took from each; design only through your tools, as always. Never quote an attachment's id to the person.

You work for one person, inside one change request whose id each request gives you. With your tools you can read the published model and the design contract, change this change request's draft (save_draft; add_to_change first brings another live design into it, to change several together), and check your work (validate, test_script, run_pipe, simulate_access). You cannot submit, review or approve anything: people do, and the platform executes what they approve.

When you change the draft, follow the contract below, send each object's whole definition, write test cases for every rule script you write or change and run them, dry-run every service you write or change (dry_run: it executes the draft and changes nothing), give every script you write or change its test cases (content.tests; the contract's fitness section), save, and run the fitness test (run_fitness) before you finish: submitting is refused unless it passes. Keep the person's own edits unless they ask otherwise. Then say briefly what you changed, what you checked and how it came out, and anything the person should decide. Answer questions about the model from the catalog, not from memory.

The design contract:
${JSON.stringify(contract(), null, 1)}`;

const clip = (value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (cut: ${text.length} characters)` : text;
};

// One line a person reads for each tool call.
function summarize(name, ok, result) {
    if (!ok) return result?.message ?? "failed";
    switch (name) {
        case "add_to_change": return result?.already ? "already in this change" : `brought in at v${result?.version}`;
        case "save_draft": return result?.problems?.length ? `saved; ${result.problems.length} problem(s) left` : "saved; no problems";
        case "validate": return result?.problems?.length ? `${result.problems.length} problem(s)` : `no problems; approvers: ${(result?.route ?? []).map((r) => r.department).join(", ") || "none"}`;
        case "test_script": return `${result?.script}: ${result?.passed} passed, ${result?.failed} failed`;
        case "run_pipe": return result?.ok ? "the pipe passed" : `the pipe stopped: ${result?.error?.message}`;
        case "simulate_access": return `roles ${result?.roles?.join(", ") || "none"}: ${result?.actions?.length ?? 0} action(s), writes ${Object.entries(result?.fields ?? {}).filter(([, l]) => l === "w").map(([f]) => f).join(", ") || "nothing"}`;
        case "get_change": return `change "${result?.title}" (${result?.state})`;
        case "get_catalog": return `${result?.objects?.length ?? 0} object(s)`;
        case "run_fitness": return result?.passed ? `passed${result.counts?.warn ? `, ${result.counts.warn} warning(s)` : ""}` : `failed: ${(result?.checks ?? []).filter((c) => c.status === "fail").map((c) => c.title).join(", ")}`;
        case "dry_run": return result?.ok ? `ran; would write ${result.writes?.length ?? 0}, send ${result.requests?.length ?? 0}` : `${result?.error?.line ? `line ${result.error.line}: ` : ""}${result?.error?.message ?? "failed"}`;
        default: return "done";
    }
}

export function createCopilot({ store, services, provider, attachments = null, log = console, sendLimits = SENDS }) {
    const tools = designTools({ store, services });
    const toolDefs = COPILOT_TOOLS.map((name) => ({ name, description: tools[name].description, input_schema: tools[name].input_schema }));
    const sessions = new Map(); // `${user}:${change}` -> session, while this process runs it
    const { db } = store;

    // Sends in the past hour, by person and in all (this process's count: an instance's own ceiling).
    const sent = [];
    const withinSends = (userId, limits = sendLimits) => {
        const since = Date.now() - limits.everyMs;
        while (sent.length && sent[0].at < since) sent.shift();
        if (sent.length >= limits.perInstance || sent.filter((x) => x.user === userId).length >= limits.perPerson) return false;
        sent.push({ user: userId, at: Date.now() });
        return true;
    };
    async function personOf(self) {
        const user = await store.userForSession(self?.sessionId);
        if (!user) fail("Sign in first.", { status: 401 });
        if (!(await store.rolesFor(user.id, "design")).length) fail("The designer is not shared with you.", { status: 403 });
        return user;
    }
    // The conversation: this process's, while it runs one; otherwise as kept with the change.
    const sessionOf = async (user, change) => {
        if (typeof change !== "string" || !/^[0-9a-f-]{36}$/.test(change)) fail("A bad change request id.");
        const key = `${user.id}:${change}`;
        if (sessions.get(key)?.running) return sessions.get(key);
        const [row] = await db.query("SELECT messages, transcript, saves, running, started_at, updated_at FROM mes.copilot_conversations WHERE owner = $1 AND change_id = $2", [user.id, change]);
        const s = { key, user: user.id, change, messages: row?.messages ?? [], transcript: row?.transcript ?? [], running: false, step: 0, saves: row?.saves ?? 0, error: null, started_at: row?.started_at ?? null, updated_at: row?.updated_at ?? null };
        if (row?.running) {
            // Another instance runs it (it saves after every step): shown as running, left to it.
            if (Date.now() - new Date(row.updated_at).getTime() < STALE_MS) return { ...s, running: true, elsewhere: true };
            // Kept as running, but nothing has moved it for long: the process that ran it stopped.
            s.transcript.push({ role: "note", text: "The copilot was stopped before it finished (the server restarted): ask it to continue.", at: new Date().toISOString() });
            await keep(s);
        }
        sessions.set(key, s);
        return s;
    };
    // Saved as it grows: a reload, another window or a restart finds it as it is.
    async function keep(s) {
        const [row] = await db.query(
            `INSERT INTO mes.copilot_conversations (owner, change_id, messages, transcript, saves, running) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (owner, change_id) DO UPDATE SET messages = $3, transcript = $4, saves = $5, running = $6, updated_at = now()
             RETURNING started_at, updated_at`,
            [s.user, s.change, JSON.stringify(s.messages), JSON.stringify(s.transcript), s.saves, s.running]);
        s.started_at = row.started_at;
        s.updated_at = row.updated_at;
    }
    const keepQuietly = (s) => keep(s).catch((error) => log.error?.("copilot: keeping the conversation", error));
    const iso = (t) => (t instanceof Date ? t.toISOString() : t ?? null);
    const view = (s) => ({ transcript: s.transcript, running: s.running, step: s.step, saves: s.saves, error: s.error, started_at: iso(s.started_at), updated_at: iso(s.updated_at) });

    async function run(session, user, change) {
        const who = { user_id: user.id, user_name: user.name, scopes: ["design:read", "design:draft"], name: "in-app copilot", agent: provider.model ?? provider.name };
        try {
            for (session.step = 1; session.step <= MAX_STEPS; session.step++) {
                // What the person attached (§34.10), given as the model reads it: kept in the conversation by name only.
                const answer = await provider.complete({ system: SYSTEM, messages: attachments ? await attachments.expand(session.messages) : session.messages, tools: toolDefs });
                session.messages.push({ role: "assistant", content: answer.content });
                for (const block of answer.content) if (block.type === "text" && block.text.trim()) session.transcript.push({ role: "assistant", text: block.text });
                if (answer.stop === "pause") continue;
                if (answer.stop !== "tools") {
                    if (answer.note) session.transcript.push({ role: "note", text: answer.note });
                    if (answer.stop === "max_tokens") session.transcript.push({ role: "note", text: "The answer was cut short; ask to continue." });
                    return;
                }
                const results = [];
                for (const call of answer.content.filter((b) => b.type === "tool_use")) {
                    let ok = true;
                    let result;
                    try {
                        if (!COPILOT_TOOLS.includes(call.name)) throw Object.assign(new Error(`There is no tool ${call.name}.`), { expose: true });
                        // Held to the change it was opened on: what it reads (a draft, a catalog entry,
                        // someone else's words) cannot send it to work on another of the person's changes.
                        if (ON_ITS_CHANGE.includes(call.name) && call.input?.id !== undefined && call.input.id !== change) throw Object.assign(new Error(`This conversation works on change request ${change} only.`), { expose: true });
                        // Its saves build on the draft as it last read it: one a co-designer saved since is
                        // not undone (§5.3); it is told, reads again, and makes its edits on theirs.
                        const input = call.name === "save_draft" && call.input?.seen === undefined && session.rev !== undefined ? { ...call.input, seen: session.rev } : call.input ?? {};
                        result = await tools[call.name].run(who, input, who.agent);
                        if (result?.draft_rev !== undefined && result?.draft_rev !== null) session.rev = Number(result.draft_rev);
                        if (call.name === "save_draft") session.saves += 1;
                    } catch (error) {
                        ok = false;
                        // Only words written for the reader reach the model; anything else is logged.
                        if (error?.expose !== true) log.error?.("copilot tool", call.name, error);
                        result = { message: error?.expose === true ? error.message : "The tool failed.", ...(error?.fields ? { fields: error.fields } : {}) };
                    }
                    session.transcript.push({ role: "tool", name: call.name, ok, text: summarize(call.name, ok, result) });
                    results.push({ type: "tool_result", tool_use_id: call.id, content: clip(result), ...(ok ? {} : { is_error: true }) });
                }
                session.messages.push({ role: "user", content: results });
                await keepQuietly(session);
            }
            session.transcript.push({ role: "note", text: `Stopped after ${MAX_STEPS} steps; ask to continue.` });
        } catch (error) {
            log.error?.("copilot", error);
            // The provider's own words (a bad key, a missing setting, a limit) say what to fix.
            session.error = error?.reason ? `The AI failed: ${error.reason}` : "The AI could not be reached or failed; try again.";
            session.transcript.push({ role: "note", text: session.error });
        } finally {
            session.running = false;
            await keepQuietly(session);
        }
    }

    const services_ = {
        async "copilot.status"() {
            await personOf(this);
            return { configured: provider.available, provider: provider.name, model: provider.model, hint: provider.hint ?? null };
        },
        async "copilot.get"({ change } = {}) {
            const user = await personOf(this);
            return view(await sessionOf(user, change));
        },
        async "copilot.send"({ change, text, attachments: attached } = {}) {
            const user = await personOf(this);
            if (!provider.available) fail(provider.hint ?? "No AI is configured.", { status: 503, code: "ai.unconfigured" });
            if (typeof text !== "string" || !text.trim() || text.length > 8000) fail("Say what you want, in at most 8000 characters.", { fields: { text: "Required." } });
            if (!withinSends(user.id)) fail("The copilot has been asked a great deal in the past hour: try again later.", { status: 429, code: "rate.limited" });
            const session = await sessionOf(user, change);
            if (session.running) fail("The copilot is still working on your last message.", { status: 409 });
            await services["design.change"].call({ ...this }, { id: change }); // the change exists and is shared
            // Files the person attached (§34.10): a drawing, a form, a spec, a spreadsheet of values.
            const files = attachments && attached?.length ? await attachments.checked(attached) : { list: [] };
            if (files.problem) fail(files.problem, { fields: { attachments: files.problem } });
            const opening = session.messages.length === 0;
            const prompt = `${opening ? `This conversation is about change request ${change}. Read it with get_change before you change anything.\n\n` : ""}${text.trim()}`;
            session.messages.push({ role: "user", content: [{ type: "text", text: prompt }, ...(attachments?.blocks(files.list) ?? [])] });
            session.transcript.push({ role: "user", text: text.trim(), at: new Date().toISOString(), ...(files.list.length ? { files: files.list.map(({ blob, name, type }) => ({ blob, name, type })) } : {}) });
            session.running = true;
            session.error = null;
            session.step = 0;
            await keep(session);
            run(session, user, change); // not awaited: the page reads the transcript as it grows
            return view(session);
        },
        async "copilot.reset"({ change } = {}) {
            const user = await personOf(this);
            const session = await sessionOf(user, change);
            if (session.running) fail("Wait until the copilot has answered.", { status: 409 });
            sessions.delete(`${user.id}:${change}`);
            await db.query("DELETE FROM mes.copilot_conversations WHERE owner = $1 AND change_id = $2", [user.id, change]);
            return { ok: true };
        },
        // After the copilot saved the draft, the page asks the change's live views to re-run (the
        // copilot's saves do not pass through the dispatcher, so they announce nothing themselves).
        async "copilot.refresh"({ change } = {}) {
            await personOf(this);
            return { ok: true, change };
        },
    };
    const touches = {
        "copilot.status": [], "copilot.get": [], "copilot.send": [], "copilot.reset": [],
        "copilot.refresh": ({ change } = {}) => [{ name: "design.change", where: { id: change } }, { name: "design.home" }],
    };
    return { services: services_, touches };
}
