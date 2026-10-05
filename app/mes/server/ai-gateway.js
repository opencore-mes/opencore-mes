// The AI gateway (DESIGN.md §16.6): one interface over the models the copilot may use, chosen by the
// environment, so the copilot is the same whichever AI answers.
//
//   provider.complete({ system, messages, tools }) → { content: [blocks], stop, note }
//
// Messages and blocks are in one shape whatever the provider (text, image and document (an attached
// picture or PDF, as Claude takes them, §34.10), tool_use { id, name, input },
// tool_result { tool_use_id, content, is_error }, and a provider's own blocks, such as Claude's
// thinking, kept as they came and handed back unchanged). `stop` is "end", "tools", "pause",
// "refusal" or "max_tokens".
//
//   AI_PROVIDER=anthropic   Claude, through the Anthropic SDK. Credentials as the SDK finds them
//                           (ANTHROPIC_API_KEY, …). AI_MODEL (claude-opus-5-5), AI_EFFORT (high).
//                           ANTHROPIC_WORKSPACE_ID: the workspace, for a key not scoped to one.
//   AI_PROVIDER=openai      any OpenAI-compatible chat API (another vendor, or an in-house server
//                           such as vLLM or Ollama): AI_BASE_URL, AI_API_KEY (optional), AI_MODEL.
//   unset                   no AI: the copilot says how to configure one; the plant runs without it.
//
// A request the provider refuses (a bad key, a missing setting, a limit) throws with `reason`: the
// provider's own words, which say what to fix, and which the copilot shows the person.

const MAX_TOKENS = 16000;

export async function createProvider(env = {}) {
    const kind = env.AI_PROVIDER ?? (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "anthropic" : "");
    if (kind === "anthropic") return anthropicProvider(env);
    if (kind === "openai") return openaiProvider(env);
    return {
        name: "none", model: null, available: false,
        hint: "No AI is configured. Set AI_PROVIDER=anthropic (with ANTHROPIC_API_KEY) for Claude, or AI_PROVIDER=openai with AI_BASE_URL and AI_MODEL for any OpenAI-compatible model, in .env (see .env.example) or the server's environment, and restart it (npm run dev restarts by itself).",
        complete: async () => { throw new Error("no AI provider is configured"); },
    };
}

// ---- Claude --------------------------------------------------------------------------------------
async function anthropicProvider(env) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic(env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } } : {});
    const model = env.AI_MODEL || "claude-opus-5-5";
    // Effort and the server-side fallback exist on the current large models; older ones refuse them.
    const current = /^claude-(opus-5|fable-5|sonnet-5)/.test(model);
    const effort = env.AI_EFFORT || "high";
    return {
        name: "anthropic", model, available: true,
        async complete({ system, messages, tools }) {
            const response = await client.beta.messages.create({
                model,
                max_tokens: MAX_TOKENS,
                // The system prompt and the tools do not change between turns: cached, they cost a
                // fraction on every turn after the first.
                system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
                tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
                messages,
                ...(current ? {
                    output_config: { effort },
                    // A request the model's safeguards decline is re-run on the model Anthropic
                    // recommends for that kind of decline, inside the same call.
                    betas: ["server-side-fallback-2026-07-01"],
                    fallbacks: "default",
                } : {}),
            }).catch((error) => {
                const words = error?.error?.error?.message;
                throw Object.assign(error, { reason: words ? `Claude answered ${error.status}: ${words}` : `Claude could not be reached (${error?.message ?? error}).` });
            });
            const stop = { end_turn: "end", tool_use: "tools", pause_turn: "pause", refusal: "refusal", max_tokens: "max_tokens" }[response.stop_reason] ?? "end";
            const note = stop === "refusal" ? `The model declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.` : null;
            return { content: response.content, stop, note, usage: response.usage };
        },
    };
}

// ---- any OpenAI-compatible chat API ----------------------------------------------------------------
function openaiProvider(env) {
    const base = (env.AI_BASE_URL || "").replace(/\/+$/, "");
    const model = env.AI_MODEL || "";
    if (!base || !model) {
        return { name: "openai", model: model || null, available: false, hint: "AI_PROVIDER=openai needs AI_BASE_URL (e.g. http://localhost:11434/v1) and AI_MODEL.", complete: async () => { throw new Error("not configured"); } };
    }
    // Our block-shaped messages, as that API's chat messages.
    const toChat = (system, messages) => {
        const out = [{ role: "system", content: system }];
        for (const m of messages) {
            const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
            if (m.role === "user") {
                // A picture attached (§34.10) as that API's image part; a PDF as words (no common way to send one).
                const said = blocks.map((b) => (b.type === "text" ? b.text : b.type === "document" ? `(A PDF, "${b.title ?? "document"}", was attached: this model cannot read it.)` : null)).filter(Boolean).join("\n");
                const images = blocks.filter((b) => b.type === "image" && b.source?.type === "base64").map((b) => ({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }));
                for (const b of blocks.filter((b) => b.type === "tool_result")) out.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
                if (images.length) out.push({ role: "user", content: [...(said ? [{ type: "text", text: said }] : []), ...images] });
                else if (said) out.push({ role: "user", content: said });
            } else {
                const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
                const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
                out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
            }
        }
        return out;
    };
    return {
        name: "openai", model, available: true,
        async complete({ system, messages, tools }) {
            const res = await fetch(`${base}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", ...(env.AI_API_KEY ? { authorization: `Bearer ${env.AI_API_KEY}` } : {}) },
                body: JSON.stringify({
                    model, max_tokens: MAX_TOKENS, messages: toChat(system, messages), tool_choice: "auto",
                    tools: tools.map(({ name, description, input_schema }) => ({ type: "function", function: { name, description, parameters: input_schema } })),
                }),
                signal: AbortSignal.timeout(300_000),
            }).catch((error) => { throw Object.assign(error, { reason: `${base} could not be reached (${error?.cause?.code ?? error?.message ?? error}).` }); });
            if (!res.ok) {
                const message = `${base} answered ${res.status}: ${(await res.text()).slice(0, 300)}`;
                throw Object.assign(new Error(message), { reason: message });
            }
            const choice = (await res.json()).choices?.[0];
            const message = choice?.message ?? {};
            const content = [];
            if (message.content) content.push({ type: "text", text: message.content });
            for (const call of message.tool_calls ?? []) {
                let input = {};
                try { input = JSON.parse(call.function?.arguments || "{}"); } catch { input = { $unparsed: call.function?.arguments }; }
                content.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
            }
            const stop = content.some((b) => b.type === "tool_use") ? "tools" : { length: "max_tokens", content_filter: "refusal" }[choice?.finish_reason] ?? "end";
            return { content, stop, note: stop === "refusal" ? "The model declined this request." : null };
        },
    };
}
