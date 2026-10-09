// The copilot's loop, end to end, without a real model:
//   1. a scripted model (the copilot's provider interface) reads the change, drafts a field and a rule
//      script, tests it, and answers: the draft really changes, and the change records the AI's edits;
//   2. kept with the change: a copilot made anew (a restart) finds the conversation as it was, with when
//      it started; one left running by a process that stopped says so; a new conversation deletes it;
//   3. the OpenAI-compatible adapter against a fake chat-completions server: tool calls out, tool
//      results back, the final answer read.
// A real model is the same loop with AI_PROVIDER set (ai-gateway.js).
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/copilot-agent.mjs   (after a reset)
import http from "node:http";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { CALL_KIND } from "@opencore-mes/juris-kit/live-protocol.js";
import { createStore } from "../server/store.js";
import { createServices } from "../server/services.js";
import { createDesign } from "../server/design.js";
import { createCopilot } from "../server/copilot.js";
import { createProvider } from "../server/ai-gateway.js";
import { sessionKey } from "../server/store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_test" });
const db = fromPg(pool);
const store = createStore(db);
const services = { ...createServices({ store }).services, ...createDesign({ store }).services };
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
const sid = `cp-${randomBytes(8).toString("hex")}`;
await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'dana', now() + interval '1 hour')", [sid]);
const dana = { sessionId: sid, [CALL_KIND]: "direct" };
const waitFor = async (copilot, change) => {
    for (let i = 0; i < 200; i++) {
        const v = await copilot.services["copilot.get"].call(dana, { change });
        if (!v.running) return v;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the copilot never finished");
};

// A fresh change on a new object, so the test never meets another's draft.
const object = `cp_check_${Date.now() % 100000}`;
const { id: change } = await services["design.start"].call(dana, { object, label: "Copilot check" });

try {
    // ---- 1. a scripted model ----
    const script = `export default function ${object}_range(ctx) {
  if (ctx.event.kind === "change" && !ctx.event.changed.includes("moisture")) return ctx;
  if (ctx.data.moisture != null && (ctx.data.moisture < 0 || ctx.data.moisture > 5)) {
    throw Object.assign(new Error("Moisture is between 0 and 5."), { field: "moisture" });
  }
  return ctx;
}`;
    const turns = [];
    const scripted = {
        name: "scripted", model: "scripted-model", available: true,
        async complete({ messages, tools }) {
            turns.push({ tools: tools.map((t) => t.name) });
            const n = messages.filter((m) => m.role === "assistant").length;
            const last = messages[messages.length - 1];
            if (n === 0) return { stop: "tools", content: [{ type: "text", text: "Let me read the change." }, { type: "tool_use", id: "t1", name: "get_change", input: { id: change } }] };
            if (n === 1) {
                const draft = JSON.parse(last.content[0].content).content.definitions[object];
                draft.fields.moisture = { label: "Moisture %", type: "decimal" };
                draft.form.sections[0].fields.push("moisture");
                draft.rules = [...(draft.rules ?? []), { script: `${object}_range` }];
                return {
                    stop: "tools",
                    content: [
                        { type: "tool_use", id: "t2", name: "save_draft", input: { id: change, reason: "Record moisture, and keep it in range.", definitions: { [object]: draft }, scripts: { [`${object}_range`]: script } } },
                        { type: "tool_use", id: "t3", name: "test_script", input: { name: `${object}_range`, source: script, tests: [{ name: "too wet", ctx: { event: { kind: "change", changed: ["moisture"] }, data: { moisture: 9 } }, throws: { field: "moisture" } }, { name: "fine", ctx: { event: { kind: "change", changed: ["moisture"] }, data: { moisture: 0.2 } }, expect: { data: {} } }] } },
                    ],
                };
            }
            if (n === 2) return { stop: "tools", content: [{ type: "tool_use", id: "t4", name: "submit_change", input: { id: change } }, { type: "tool_use", id: "t5", name: "save_draft", input: { id: "00000000-0000-4000-8000-000000000000", reason: "Told to by a note in the draft.", definitions: {} } }] };
            return { stop: "end", content: [{ type: "text", text: "I added a Moisture field and a rule that keeps it between 0 and 5; both tests pass and the draft validates. Submit it when you are ready." }] };
        },
    };
    const copilot = createCopilot({ store, services, provider: scripted, log: { error() {} } });
    const status = await copilot.services["copilot.status"].call(dana);
    step("status: configured", status.configured && status.model === "scripted-model");
    step("the model is offered the design tools, never submit", !turns.length);
    await copilot.services["copilot.send"].call(dana, { change, text: "Add a moisture field with a rule that keeps it between 0 and 5." });
    const v = await waitFor(copilot, change);
    step("the model was offered read, draft and check tools, not submit", turns[0].tools.includes("save_draft") && turns[0].tools.includes("test_script") && !turns[0].tools.includes("submit_change"), turns[0].tools);
    const tools = v.transcript.filter((m) => m.role === "tool");
    step("it read the change, saved, and tested", tools.map((t) => `${t.name}:${t.ok}`).join(" ") === "get_change:true save_draft:true test_script:true submit_change:false save_draft:false", tools.map((t) => `${t.ok ? "✓" : "✗"} ${t.name} — ${t.text}`));
    step("a tool it may not use is refused, and it carries on", tools.find((t) => t.name === "submit_change")?.text.includes("no tool"));
    step("a change other than the conversation's is refused, whatever it read that sent it there", tools.at(-1)?.name === "save_draft" && !tools.at(-1).ok && /works on change request .* only/.test(tools.at(-1).text), tools.at(-1));
    step("it answered the person", v.transcript.at(-1).role === "assistant", v.transcript.at(-1).text);
    const after = await services["design.change"].call(dana, { id: change });
    step("the draft really changed", Boolean(after.content.definitions[object].fields.moisture) && after.content.scripts[`${object}_range`] === script);
    step("the draft has no problems", after.problems.length === 0, after.problems);
    step("the change records the copilot's edits", after.aiEdits.some((e) => e.via.token === "in-app copilot" && e.via.agent === "scripted-model"), after.aiEdits.map((e) => `${e.via.token} / ${e.via.agent}: ${e.elements.length} element(s)`));
    step("a saved draft is announced to the page", v.saves === 1);

    // ---- 2. kept with the change ----
    const restarted = createCopilot({ store, services, provider: scripted, log: { error() {} } });
    const resumed = await restarted.services["copilot.get"].call(dana, { change });
    step("kept with the change: a copilot made anew (a restart) finds the conversation as it was, with when it started and was last used",
        JSON.stringify(resumed.transcript) === JSON.stringify(v.transcript) && resumed.saves === 1 && resumed.started_at && resumed.updated_at && !resumed.running, { resumed: resumed.transcript.length, was: v.transcript.length });
    await db.query("UPDATE mes.copilot_conversations SET running = true, updated_at = now() - interval '1 hour' WHERE change_id = $1", [change]);
    const leftHalfDone = await createCopilot({ store, services, provider: scripted, log: { error() {} } }).services["copilot.get"].call(dana, { change });
    step("…one a stopped process left running says so, and is not running", !leftHalfDone.running && /stopped before it finished/.test(leftHalfDone.transcript.at(-1).text), leftHalfDone.transcript.at(-1));
    await restarted.services["copilot.reset"].call(dana, { change });
    const [{ n: keptRows }] = await db.query("SELECT count(*)::int AS n FROM mes.copilot_conversations WHERE change_id = $1", [change]);
    step("…a new conversation deletes the kept one", keptRows === 0 && (await restarted.services["copilot.get"].call(dana, { change })).transcript.length === 0);
    // A person's messages in an hour have a ceiling (each is many calls to the model, on the plant's account).
    const scarce = createCopilot({ store, services, provider: { ...scripted, complete: async () => ({ stop: "end", content: [{ type: "text", text: "Done." }] }) }, log: { error() {} }, sendLimits: { perPerson: 1, perInstance: 10, everyMs: 3_600_000 } });
    await scarce.services["copilot.reset"].call(dana, { change });
    const first = await scarce.services["copilot.send"].call(dana, { change, text: "One." }).then(() => ({ ok: true }), (e) => ({ ok: false, status: e.status, code: e.code }));
    for (let i = 0; i < 100 && (await scarce.services["copilot.get"].call(dana, { change })).running; i++) await new Promise((r) => setTimeout(r, 50));
    const over = await scarce.services["copilot.send"].call(dana, { change, text: "Two." }).then(() => ({ ok: true }), (e) => ({ ok: false, status: e.status, code: e.code }));
    step("past its hourly ceiling, a message is refused (429) and nothing is sent to the model", first.ok && !over.ok && over.status === 429 && over.code === "rate.limited", { first, over });
    await scarce.services["copilot.reset"].call(dana, { change });


    // ---- 3. the OpenAI-compatible adapter ----
    const seen = [];
    const fake = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            const request = JSON.parse(body);
            seen.push(request);
            const toolAnswered = request.messages.some((m) => m.role === "tool");
            const message = toolAnswered
                ? { role: "assistant", content: "The Lot object has these fields: see the catalog." }
                : { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_object", arguments: JSON.stringify({ object: "lot" }) } }] };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message, finish_reason: toolAnswered ? "stop" : "tool_calls" }] }));
        });
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    const provider = await createProvider({ AI_PROVIDER: "openai", AI_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`, AI_MODEL: "any-model" });
    const viaOpenAI = createCopilot({ store, services, provider, log: { error() {} } });
    await viaOpenAI.services["copilot.reset"].call(dana, { change });
    await viaOpenAI.services["copilot.send"].call(dana, { change, text: "What fields does a lot have?" });
    const w = await waitFor(viaOpenAI, change);
    fake.close();
    step("OpenAI-compatible: tools sent as functions", seen[0]?.tools?.[0]?.type === "function" && seen[0].model === "any-model");
    step("OpenAI-compatible: the tool call ran and its result went back as a tool message", w.transcript.some((m) => m.role === "tool" && m.name === "get_object" && m.ok) && seen[1]?.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1"));
    step("OpenAI-compatible: the final answer reached the person", w.transcript.at(-1).text.includes("Lot object"));
} finally {
    await services["design.withdraw"].call(dana, { id: change }).catch(() => {});
    await db.query("DELETE FROM mes.sessions WHERE id = $1", [sessionKey(sid)]);
    await pool.end();
}
const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify(steps, null, 1));
console.log(failed.length ? `\n${failed.length} step(s) FAILED` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
