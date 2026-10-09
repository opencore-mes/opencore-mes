// The sandbox page (DESIGN.md §5.11): a change's draft tried on copies of real records, in a database
// of its own (server/sandbox.js). The designer says which records it starts with (picked from what is
// live, or given), opens it, runs steps one by one as whoever they choose, and saves the run as a
// scenario of one of the change's transactions or flow templates: kept with its versions, re-run by the
// fitness test. A plan the records are in is answered here as its person ("Answer a plan", §32.8), and
// each step shows where every record's runs are; a template's scenario expects the nodes they reached.
// /design/c/<change>/sandbox, ?tx=<transaction>&scenario=<name> (or ?flow=<template>&…) to start from a saved one.
// The records it starts with may be kept as a saved selection (the designer's own, on any change's
// sandbox): switched between, saved, saved as, renamed, deleted; a record is found by a search over
// every object, or picked by its object.
import { titleTab } from "./shell.js";
import { noDefault } from "./select.js";
import { icon } from "./icons.js";
import { confirmDialog, askDialog, confirmRemove } from "./dialog.js";
import { plant, noun as nounOf } from "./format.js";
import { uploadPicture, PICTURE_TYPES } from "./picture.js";
import { routeMaps } from "./flow-picture.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const KINDS = [["transaction", "Run a transaction"], ["action", "Take a record's action"], ["update", "Edit a record"], ["create", "Make a record"], ["service", "Call a service"], ["screen", "Open a screen"], ["act", "Answer a plan"]];
// How a plan is answered: an input screen's values, a manual decision's choice, a wait's buttons, or its time made to pass (here only).
const ACTS = [["fill", "fill its input screen in"], ["choose", "pick a manual decision's choice"], ["acknowledge", "acknowledge its wait"], ["retry", "retry, at its wait"], ["time_up", "let its wait's time pass"]];
const json = (v) => (v === undefined ? "" : JSON.stringify(v));
const parse = (text, fallback) => { try { return text.trim() ? JSON.parse(text) : fallback; } catch { return Symbol.for("bad"); } };
const BAD = Symbol.for("bad");
const words = (v) => String(v ?? "").replace(/_/g, " ");
// What a JSON field's text says beyond its syntax (the editor marks that): not the shape asked for, or
// a field its object does not have, placed on its line. A rows input is a list of such objects.
function jsonLint(text, { fields = null, extra = [], list = false } = {}) {
    let value;
    try { value = text.trim() ? JSON.parse(text) : undefined; } catch { return []; }
    if (value === undefined) return [];
    const at = (needle) => { const i = Math.max(0, text.indexOf(needle)); const before = text.slice(0, i); return { line: before.split("\n").length, col: i - before.lastIndexOf("\n") }; };
    if (list && !Array.isArray(value)) return [{ ...at(text.trim()[0]), message: 'A list of rows: [{"field": value}, …].' }];
    const items = list ? value : [value];
    const out = [];
    for (const item of items) {
        if (!isPlain(item)) { out.push({ ...at(JSON.stringify(item).slice(0, 1)), message: list ? 'Each row is {"field": value}.' : 'This is {"field": value}.' }); continue; }
        if (!fields) continue;
        for (const k of Object.keys(item)) if (!Object.hasOwn(fields, k) && !extra.includes(k)) out.push({ ...at(`"${k}"`), message: `No field "${k}" here: its fields are ${[...Object.keys(fields), ...extra].join(", ")}.` });
    }
    return out;
}
// The same records whatever order their keys come in (the database keeps its own).
const canon = (v) => JSON.stringify(v, (k, x) => (isPlain(x) ? Object.fromEntries(Object.keys(x).sort().map((n) => [n, x[n]])) : x));

export function registerSandbox(juris, { args }) {
    juris.registerComponent("SandboxView", ({ id }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const C = `dc.${id}`;
        const S = `sbx.${id}`;
        api.live(C, "design.change", args.change(id, as));
        api.live("design.home", "design.home", args.design(as));
        const get = (k, d = null) => api.getState(`${S}.${k}`, d);
        const set = (k, v) => api.setValue(`${S}.${k}`, v);
        if (!api.peek(`${S}.spec`)) api.batch(() => { set("spec", {}); set("steps", []); set("planned", []); set("step", { kind: "transaction", as }); set("draft", { key: "", object: "", mode: "pick" }); });
        const box = () => get("box", { open: false });
        const busy = () => get("busy", false);
        const run = async (label, fn) => {
            api.batch(() => { set("busy", true); set("error", null); set("notice", null); });
            try { const r = await fn(); if (label) set("notice", typeof label === "function" ? label(r) : label); return r; } catch (e) { set("error", e.message); return null; } finally { set("busy", false); }
        };
        if (!api.isServer) {
            // Open already (the page reloaded, or came back to): the records it started with are its own again,
            // so a scenario saved from it names them.
            api.onMount(() => { api.call("sandbox.state", { id }).then((s) => { api.batch(() => { set("box", s); if (s.open && s.spec && !Object.keys(get("spec", {}) ?? {}).length) set("spec", s.spec); }); if (s.open) follow(); }, () => {}); });
            // A saved scenario to start from (?tx=…&scenario=…): its records, and its steps to run.
            const stop = api.bindState(() => api.getState(`${C}.draft_rev`), () => {
                const flowName = api.peek("$route.query.flow");
                const tx = flowName ? `flow:${flowName}` : api.peek("$route.query.tx");
                const name = api.peek("$route.query.scenario");
                const sc = (flowName ? api.peek(`${C}.content.flows.${flowName}.scenarios`) : api.peek(`${C}.content.transactions.${tx}.scenarios`) ?? []) ?? [];
                const found = sc.find?.((x) => x?.name === name);
                if (!found && !flowName) return;
                if (!found) { if (get("save", {}).tx !== tx) set("save", { tx, name: "" }); return; }
                if (get("loaded") === `${tx}:${name}`) return;
                const sc_ = found;
                api.batch(() => { set("spec", JSON.parse(JSON.stringify(sc_.records ?? {}))); set("planned", JSON.parse(JSON.stringify(sc_.steps ?? []))); set("save", { tx, name }); set("loaded", `${tx}:${name}`); });
            });
            api.onCleanup(stop);
        }
        // ---- what a route needs to be walked to its end, before it is opened (§5.11) ----
        let needsTimer = null;
        let needsTurn = 0;
        const loadNeeds = () => {
            if (api.isServer) return;
            clearTimeout(needsTimer);
            needsTimer = setTimeout(async () => {
                const turn = ++needsTurn;
                const r = await api.call("sandbox.needs", { id, flow: api.peek(`${S}.needsFlow`) || null, records: api.peek(`${S}.spec`) ?? {} }).catch((e) => ({ error: e.message }));
                if (turn === needsTurn) set("needs", r);
            }, 200);
        };
        // Read again as the records chosen change (bound once it is defined: a binding runs at once).
        if (!api.isServer) api.onCleanup(api.bindState(() => canon(api.getState(`${S}.spec`, {}) ?? {}), () => loadNeeds()));
        // A record that gives a need, added: keyed by its title (bg_01), kept findable by the need's own
        // settings should that one be gone or moved on when the sandbox opens.
        const keyFor = (title, object, spec) => {
            let key = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "r_$1") || object;
            if (!/^[a-z]/.test(key)) key = object;
            const base = key;
            for (let n = 2; spec[key]; n++) key = `${base}_${n}`;
            return key;
        };
        const addNeed = (need, c) => {
            const spec = { ...(get("spec", {}) ?? {}) };
            if (Object.values(spec).some((r) => r.id === c.id)) return;
            spec[keyFor(c.title, need.object, spec)] = { object: need.object, id: c.id, note: [c.title, ...(c.about ?? []).map(words)].join(" · "), ...(Object.keys(need.where ?? {}).length ? { where: need.where } : {}) };
            set("spec", spec);
        };
        const addAllRequired = () => {
            const spec = { ...(get("spec", {}) ?? {}) };
            let n = 0;
            for (const need of get("needs", {})?.needs ?? []) {
                if (need.have.length) continue;
                const c = need.candidates.find((x) => !Object.values(spec).some((r) => r.id === x.id));
                if (!c) continue;
                spec[keyFor(c.title, need.object, spec)] = { object: need.object, id: c.id, note: [c.title, ...(c.about ?? []).map(words)].join(" · "), ...(Object.keys(need.where ?? {}).length ? { where: need.where } : {}) };
                n++;
            }
            api.batch(() => { set("spec", spec); set("notice", `${n} required record(s) added.`); });
        };
        const whereWords = (object, where) => Object.entries(where ?? {}).map(([f, v]) => `${String(objects()[object]?.fields?.[f]?.label ?? f.replace(/_/g, " ")).toLowerCase()} ${[].concat(v).join(" or ")}`).join(", ");
        // ---- saved selections: the records it starts with, kept by name ----
        api.live(`${S}.sels`, "sandbox.selections", args.design(as));
        const sels = () => api.getState(`${S}.sels`, []) ?? [];
        const current = () => sels().find((x) => x.id === get("sel")) ?? null;
        const clone = (v) => JSON.parse(JSON.stringify(v ?? {}));
        // Not as saved: changed since it was loaded or saved, or records not saved at all.
        const edited = () => { const c = current(); const spec = get("spec", {}); return c ? canon(c.records) !== canon(spec) : Object.keys(spec).length > 0; };
        const when = (iso) => (iso ? plant().dateTime(iso) : "");
        const switchTo = async (sid) => {
            if ((sid || null) === (get("sel") ?? null)) return;
            if (edited() && !(await confirmDialog(api, { title: "Leave these records?", message: "The records here are not saved: the selection you pick replaces them.", confirm: "Switch" }))) { set("selRev", (get("selRev", 0) ?? 0) + 1); return; }
            const next = sels().find((x) => x.id === sid) ?? null;
            api.batch(() => { set("sel", next?.id ?? null); set("spec", next ? clone(next.records) : {}); set("error", null); set("notice", next ? `"${next.name}": ${next.count} record(s) to start from.` : "A new selection: add its records."); });
        };
        const saveAs = () => run(null, async () => {
            const c = current();
            const name = await askDialog(api, { title: "Save the selection as", message: "Your own, on any change's sandbox. A date in the name tells them apart.", label: "Name", required: true, value: c ? `${c.name} (copy)` : `Selection ${when(new Date().toISOString())}`, confirm: "Save" });
            if (!name) return null;
            const r = await api.call("sandbox.selection.save", { name, records: get("spec", {}) });
            api.batch(() => { set("sel", r.id); set("notice", `Saved as "${r.name}".`); });
            return r;
        });
        const save = () => (current() ? run((r) => `Saved "${r.name}".`, () => api.call("sandbox.selection.save", { id: current().id, records: get("spec", {}) })) : saveAs());
        const rename = () => run(null, async () => {
            const c = current();
            if (!c) return null;
            const name = await askDialog(api, { title: "Rename the selection", message: `Saved ${when(c.updated_at)}, made ${when(c.created_at)}.`, label: "Name", required: true, value: c.name, confirm: "Rename" });
            if (!name || name.trim() === c.name) return null;
            const r = await api.call("sandbox.selection.rename", { id: c.id, name });
            set("notice", `Renamed "${r.name}".`);
            return r;
        });
        const remove = () => run(null, async () => {
            const c = current();
            if (!c || !(await confirmDialog(api, { title: `Delete "${c.name}"?`, message: "The saved selection is gone for good; the records here stay on this page, not saved.", confirm: "Delete", danger: true }))) return null;
            await api.call("sandbox.selection.delete", { id: c.id });
            api.batch(() => { set("sel", null); set("notice", `"${c.name}" deleted.`); });
            return c;
        });

        // ---- a record found by searching every object ----
        const search = async (text) => {
            const q = String(text ?? "").trim();
            set("findText", q);
            if (q.length < 2) return set("found", []);
            const hits = await api.call("records.search", { q }).catch(() => []);
            if (api.peek(`${S}.findText`) === q) set("found", hits.slice(0, 25));
        };
        // Its key: its object's name, numbered after the first; the record picked by its id.
        const addFound = (hit) => {
            const spec = get("spec", {});
            const taken = Object.values(spec).find((r) => r.id === hit.id && r.object === hit.object);
            if (taken) return set("error", `${hit.title} is among the records already.`);
            let key = hit.object;
            for (let n = 2; spec[key]; n++) key = `${hit.object}${n}`;
            // Added: the search is cleared (what it found is in the list above now), ready for the next one.
            api.batch(() => { set(`spec.${key}`, { object: hit.object, id: hit.id, note: [hit.title, ...(hit.details ?? []).filter((d) => d.type !== "ref" && d.type !== "date").slice(0, 2).map((d) => words(d.value))].join(" · ") }); set("findText", ""); set("found", []); set("error", null); set("notice", `@${key}: ${hit.title} (${hit.label}) added.`); });
            if (!api.isServer) requestAnimationFrame(() => document.querySelector(".sandbox .sbx-find input[type=search]")?.focus());
        };

        const home = () => api.getState("design.home", {}) ?? {};
        const draftTx = () => api.getState(`${C}.content.transactions`, {}) ?? {};
        const draftFlows = () => api.getState(`${C}.content.flows`, {}) ?? {};
        // The plans a step may answer: the live ones and this change's.
        const plans = () => {
            const out = Object.fromEntries((home().flows ?? []).filter((f) => f.kind === "plan").map((f) => [f.name, f.label]));
            for (const [n, b] of Object.entries(draftFlows())) if (b?.kind === "plan") out[n] = b.label ?? n;
            return out;
        };
        const flowLabel = (n) => draftFlows()[n]?.label ?? (home().flows ?? []).find((f) => f.name === n)?.label ?? n;
        const objects = () => {
            const live = Object.fromEntries((home().objects ?? []).map((o) => [o.object, { label: o.label, fields: o.fields, transitions: o.transitions, states: o.states }]));
            for (const [o, d] of Object.entries(api.getState(`${C}.content.definitions`, {}) ?? {})) live[o] = { label: d.label, fields: d.fields, transitions: d.states?.transitions ?? [], states: d.states?.list ?? [] };
            return live;
        };
        const txs = () => {
            const out = Object.fromEntries((home().transactions ?? []).map((t) => [t.name, { label: t.label, inputs: t.inputs }]));
            for (const [n, b] of Object.entries(draftTx())) out[n] = { label: b.label, inputs: b.inputs, signature: b.signature, draft: true };
            return out;
        };
        const labelsOf = () => Object.fromEntries(Object.entries(txs()).map(([n, t]) => [n, t.label ?? n]));
        const keyOf = (rid) => Object.entries(box().records ?? {}).find(([, r]) => r.id === rid)?.[0] ?? null;
        // A step's values with every record of the sandbox named by its key ("@lot"), as a scenario keeps them.
        const named = (v) => (typeof v === "string" && keyOf(v) ? `@${keyOf(v)}` : Array.isArray(v) ? v.map(named) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, named(x)])) : v);
        // Records a reference may name in the sandbox, per object, fetched when asked for.
        const recs = (object) => {
            const have = api.getState(`${S}.recs.${object}`, null);
            if (have === null && box().open && !api.isServer && object) { api.setValue(`${S}.recs.${object}`, []); api.call("sandbox.records", { id, object }).then((l) => api.setValue(`${S}.recs.${object}`, l), () => {}); }
            return have ?? [];
        };
        const refresh = () => api.setValue(`${S}.recs`, {});

        // ---- the records it starts with ----
        const addRecord = () => {
            const typed = api.peek(`${S}.draft`) ?? {};
            // A key is a name for the steps to use (@key): what was typed is made one (EQPWBD-07 → eqpwbd_07)
            // rather than refused.
            const key = String(typed.key ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "r_$1");
            const d = { ...typed, key };
            if (!key || !d.object) return set("error", "To add a record here, give it a key (a short name the steps use, like wirebonder) and pick its object. A record clicked in the list above is added already: nothing more is needed for it.");
            set("error", null);
            if (get("spec", {})[d.key]) return set("error", `"${d.key}" is a key already.`);
            let rec;
            if (d.mode === "give") {
                const data = parse(d.data ?? "", {});
                if (data === BAD || !isPlain(data)) return set("error", 'Its data is JSON: {"field": value}, "@key" naming another record.');
                rec = { object: d.object, data, ...(d.state ? { state: d.state } : {}) };
            } else {
                const where = parse(d.where ?? "", undefined);
                if (where === BAD) return set("error", 'Where is JSON: {"state": ["waiting"]}.');
                if (!d.id && !where) return set("error", "Scan or type the record to pick, or say where to find one.");
                rec = { object: d.object, ...(d.id ? { id: d.id } : {}), ...(where ? { where } : d.state ? { where: { state: [d.state] } } : {}), ...(d.title ? { note: d.title } : {}) };
            }
            api.batch(() => { set(`spec.${d.key}`, rec); set("draft", { key: "", object: d.object, mode: d.mode }); set("error", null); });
        };
        const lookup = async () => {
            const d = api.peek(`${S}.draft`) ?? {};
            if (!d.object || !d.text) return;
            const hit = await api.call("records.lookup", { object: d.object, key: d.text.trim() }).catch(() => null);
            if (!hit) return set("error", `No ${words(d.object)} "${d.text}" that you can see.`);
            const rec = await api.call("records.get", { object: d.object, id: hit.id, as }).catch(() => null);
            api.batch(() => { set("draft.id", hit.id); set("draft.title", hit.title); set("draft.state", rec?.state ?? null); set("error", null); });
        };
        const openBox = () => run((r) => `Open: ${Object.keys(r.records ?? {}).length} record(s) to start from, ${r.copied} copied from live${r.notes?.length ? `. ${r.notes.join(" ")}` : ""}.`, async () => {
            const r = await api.call("sandbox.open", { id, records: get("spec", {}) });
            api.batch(() => { set("box", r); set("steps", []); refresh(); });
            follow();
            return r;
        });
        const resetBox = () => run("Started again: fresh copies of the live records, the given ones made anew.", async () => { const r = await api.call("sandbox.reset", { id }); api.batch(() => { set("box", r); set("steps", []); set("follow", {}); refresh(); }); follow(); return r; });
        const closeBox = () => run("Closed: its database is gone.", async () => { await api.call("sandbox.close", { id }); api.batch(() => { set("box", { open: false }); set("steps", []); set("follow", {}); refresh(); }); });

        // ---- a step ----
        const stepNow = () => {
            const st = get("step", {});
            const d = {};
            if (st.kind === "transaction") {
                const t = txs()[st.name];
                if (!t) throw new Error("Pick a transaction.");
                const input = {};
                for (const [k, spec] of Object.entries(t.inputs ?? {})) {
                    if (spec.from) continue;
                    const raw = st.input?.[k];
                    if (raw === undefined || raw === "" || raw === null) continue;
                    if (spec.type === "rows") { const v = parse(String(raw), []); if (v === BAD) throw new Error(`${spec.label ?? k}: rows are JSON, [{"value": 1.2}, …].`); input[k] = v; }
                    else input[k] = ["integer", "decimal"].includes(spec.type) ? Number(raw) : raw;
                }
                Object.assign(d, { transaction: st.name, input }, t.signature && st.sign ? { sign: { meaning: t.signature.meaning, agree: true, ...(t.signature.verifier && st.verifier ? { verifier: st.verifier } : {}) } } : {});
            } else if (st.kind === "action") Object.assign(d, { action: st.name, record: st.record });
            else if (st.kind === "update") { const data = parse(st.data ?? "", {}); if (data === BAD) throw new Error('The edit is JSON: {"field": value}.'); Object.assign(d, { update: st.record, data }); }
            else if (st.kind === "create") { const data = parse(st.data ?? "", {}); if (data === BAD) throw new Error('The record is JSON: {"field": value}.'); Object.assign(d, { create: st.name, data, ...(st.key ? { key: st.key } : {}) }); }
            else if (st.kind === "service") { const input = parse(st.data ?? "", {}); if (input === BAD) throw new Error("The input is JSON."); Object.assign(d, { service: st.name, input }); }
            else if (st.kind === "act") {
                if (!st.record) throw new Error("Pick the record whose plan to answer.");
                const how = st.how ?? "fill";
                const act = { record: st.record, ...(st.name ? { plan: st.name } : {}) };
                if (how === "fill") { const values = parse(st.data ?? "", {}); if (values === BAD || !isPlain(values)) throw new Error('Its values are JSON: {"field": value}.'); act.values = values; }
                else if (how === "choose") { if (!String(st.choice ?? "").trim()) throw new Error("Which choice?"); act.choice = st.choice.trim(); }
                else act.action = how;
                d.act = act;
            }
            else Object.assign(d, { screen: st.name, ...(st.record ? { arg: st.record } : {}) });
            return { as: st.as || as, do: d };
        };
        // What a step did, as what a scenario expects of it: run or refused, the states that moved, and
        // (kept for a template's scenario) the nodes its records' runs reached.
        const expectOf = (out, before) => ({
            ...(out.nodes && Object.keys(out.nodes).length ? { $nodes: out.nodes } : {}),
            ok: out.ok,
            ...(out.ok ? {} : { error: String(out.error ?? "").split(/[.:]/)[0].slice(0, 80) }),
            ...(Object.keys(out.states ?? {}).some((k) => out.states[k] !== before[k]) ? { states: Object.fromEntries(Object.entries(out.states).filter(([k, v]) => v !== before[k])) } : {}),
            ...(Object.keys(out.created ?? {}).length ? { created: out.created } : {}),
        });
        const runStep = (given) => run(null, async () => {
            const s = given ?? stepNow();
            const steps = get("steps", []);
            const before = steps.length ? steps.at(-1).out.states : Object.fromEntries(Object.entries(box().records ?? {}).map(([k, r]) => [k, r.state]));
            const out = await api.call("sandbox.run", { id, step: s });
            // A record a step named ("Name it, for later steps") is one of the sandbox's from now on: read
            // them again, so the steps after offer it by its key and a scenario keeps it as "@key".
            const fresh = await api.call("sandbox.state", { id }).catch(() => null);
            if (fresh?.open) set("box", fresh);
            const expected = given?.expect;
            const verdictLines = expected ? checkAgainst(expected, out) : [];
            api.batch(() => { set("steps", [...steps, { st: { as: s.as, do: named(s.do) }, out, expect: expectOf(out, before), verdict: expected ? verdictLines : null }]); refresh(); });
            follow();
            return out;
        });
        const runPlanned = () => run(null, async () => { for (const p of get("planned", [])) { const out = await runStep(p); if (!out) break; } });
        const removeStep = (i) => set("steps", get("steps", []).filter((_, k) => k !== i));

        // ---- following a route by hand (§32.8) ----
        // The records on a route here (those a step made too), the one followed, where it is and the plans
        // waiting on it, read anew after every step. Its step's offers and its plans' questions fill the
        // step in; a reference input is offered what the step allows, each tried (sandbox.suggest).
        const followed = () => get("follow.id", null);
        const loadWhere = () => {
            const rid = api.peek(`${S}.follow.id`);
            if (!rid || !box().open) return;
            api.call("sandbox.where", { id, record: rid, as: api.peek(`${S}.step.as`) || as }).then((w) => set("follow.where", w), (e) => set("follow.where", { error: e.message }));
        };
        const follow = () => {
            if (api.isServer) return;
            api.call("sandbox.travelers", { id }).then((list) => {
                set("follow.list", list);
                const rid = api.peek(`${S}.follow.id`);
                if (!rid || !list.some((x) => x.id === rid)) { set("follow.id", list[0]?.id ?? null); set("follow.where", null); }
                loadWhere();
            }, () => set("follow.list", []));
            suggestAll();
        };
        const pickTraveler = (rid) => { api.batch(() => { set("follow.id", rid || null); set("follow.where", null); }); loadWhere(); };
        // A transaction's input of the followed traveler's object, filled with it (picked from its offers or
        // under Which alike).
        const travelerInputOf = (name) => {
            const w = get("follow.where");
            const k = followed() && w?.record ? Object.entries(txs()[name]?.inputs ?? {}).find(([, x]) => x.type === "ref" && x.to === w.record.object && !x.from)?.[0] : null;
            return k ? { [k]: followed() } : {};
        };
        // The step it offers, filled in: the transaction, the traveler as its input of that object.
        const offer = (name) => {
            api.batch(() => { set("step", { kind: "transaction", as: get("step", {}).as ?? as, name, input: travelerInputOf(name) }); set("sugg", {}); });
            suggestAll();
            toStep();
        };
        // A plan's question, filled in as an answer: a decision's choice, or its screen's fields to fill.
        const answer = (task, choice = null) => {
            const blank = (f) => (f.type === "boolean" ? false : ["integer", "decimal"].includes(f.type) ? null : "");
            const how = task.kind === "manual_decision" ? "choose" : task.kind === "input_screen" ? "fill" : "acknowledge";
            set("step", { kind: "act", as: task.for?.users?.[0] ?? get("step", {}).as ?? as, record: followed(), name: task.flow, how, ...(choice ? { choice } : {}),
                ...(how === "fill" ? { data: JSON.stringify(Object.fromEntries((task.fields ?? []).map((f) => [f.name, blank(f)])), null, 2) } : {}) });
            toStep();
        };
        const toStep = () => { if (!api.isServer) requestAnimationFrame(() => document.querySelector(".sandbox .sbx-run")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
        // Suggestions for the step's reference inputs, once its inputs settle; the last asked wins.
        let suggestTimer = null;
        let suggestTurn = 0;
        const suggestAll = () => {
            if (api.isServer) return;
            clearTimeout(suggestTimer);
            suggestTimer = setTimeout(async () => {
                const st = api.peek(`${S}.step`) ?? {};
                const t = txs()[st.name];
                if (st.kind !== "transaction" || !t || !box().open) return set("sugg", {});
                let input = {};
                try { input = stepNow().do.input ?? {}; } catch { input = {}; }
                const turn = ++suggestTurn;
                for (const [k, x] of Object.entries(t.inputs ?? {})) {
                    if (x.type !== "ref" || x.from || (input[k] && input[k] === followed())) continue;
                    const { [k]: _mine, ...others } = input;
                    const r = await api.call("sandbox.suggest", { id, as: st.as || as, transaction: st.name, input: others, field: k }).catch(() => null);
                    if (turn !== suggestTurn) return;
                    set(`sugg.${k}`, r);
                }
            }, 250);
        };

        // ---- saving the run as a scenario ----
        const saveScenario = () => run((r) => { const t = get("save", {}).tx ?? ""; return `Saved: "${r}" is a scenario of ${t.startsWith("flow:") ? flowLabel(t.slice(5)) : draftTx()[t]?.label ?? t}, run by the fitness test.`; }, async () => {
            const { tx, name } = get("save", {});
            const body = draftTx()[tx];
            const flowBody = String(tx ?? "").startsWith("flow:") ? draftFlows()[tx.slice(5)] : null;
            if (!body && !flowBody) throw new Error("A scenario is kept by a transaction or a flow template of this change: add it to the change (Change it, on its page) first.");
            if (!String(name ?? "").trim()) throw new Error("Name the scenario: what it shows.");
            // Refused here, in words, rather than saved with a problem the notice would cover.
            if (name.trim().length > 120) throw new Error(`Shorten the scenario's name to 120 characters at most (it has ${name.trim().length}): say what it shows, briefly.`);
            const steps = get("steps", []);
            if (!steps.length) throw new Error("Run its steps first: what they did is what it expects.");
            // A template's scenario expects the nodes its records reached in it; a transaction's, none.
            const flowName = String(tx).startsWith("flow:") ? tx.slice(5) : null;
            const expectFor = (e) => {
                const { $nodes, ...rest } = e ?? {};
                const node = flowName ? Object.fromEntries(Object.entries($nodes ?? {}).filter(([, runs]) => runs?.[flowName]).map(([k, runs]) => [k, runs[flowName].node])) : {};
                return { ...rest, ...(Object.keys(node).length ? { node } : {}) };
            };
            // The records it started with, as the open sandbox has them (not what the list may hold since).
            const scenario = { name: name.trim(), records: box()?.open && box().spec ? box().spec : get("spec", {}), steps: steps.map((s) => ({ ...(s.st.as ? { as: s.st.as } : {}), do: s.st.do, expect: expectFor(s.expect) })) };
            if (flowName && !scenario.steps.some((x) => x.expect.node)) throw new Error(`None of its steps reached ${flowLabel(flowName)}: walk a record into it first.`);
            const result = flowName
                ? await api.call("design.save", { id, seen: api.peek(`${C}.draft_rev`), flows: { [flowName]: { ...flowBody, scenarios: [...(flowBody.scenarios ?? []).filter((x) => x?.name !== scenario.name), scenario] } } })
                : await api.call("design.save", { id, seen: api.peek(`${C}.draft_rev`), transactions: { [tx]: { ...body, scenarios: [...(body.scenarios ?? []).filter((x) => x?.name !== scenario.name), scenario] } } });
            if (result.problems?.length) set("error", `Saved, with problems to fix: ${result.problems.slice(0, 3).map((p) => p.message).join(" ")}`);
            return scenario.name;
        });

        // ---- drawing ----
        const select = (value, options, onchange, extra = {}) => ({ select: { ...extra, onchange: (e) => onchange(e.target.value), children: noDefault(options.map(([v, l]) => ({ option: { value: v, selected: v === value, textContent: l } }))) } });
        const recordOptions = (object) => [["", "—"], ...recs(object).map((r) => [r.id, `${r.key ? `@${r.key} · ` : ""}${r.title} (${words(r.state)})`])];
        const allRecordOptions = () => {
            const keyed = Object.entries(box().records ?? {}).map(([k, r]) => [r.id, `@${k} · ${r.title ?? ""} (${words(r.state)})`]);
            // The traveler followed, made by a step (no key): named by its title.
            const f = (get("follow.list", []) ?? []).find((x) => x.id === followed());
            return [["", "—"], ...keyed, ...(f && !keyed.some(([rid]) => rid === f.id) ? [[f.id, `${f.title} (${words(f.state)})`]] : [])];
        };
        // What the step allows a reference input to name, best first: taken, not yet known, refused (and why).
        const suggestionsOf = (k, spec) => () => {
            const r = get(`sugg.${k}`, null);
            if (!r) return { span: {} };
            const noun = nounOf(words(objects()[spec.to]?.label ?? spec.to));
            // Its traveler not given yet: what to give first, not every record to guess among.
            if (r.waitFor) return { p: { className: "muted small sbx-suggest", textContent: `Pick the ${String(r.waitFor.label).toLowerCase()} first: the ${noun} records its step allows are suggested then.` } };
            const at = r.step ? `At ${r.step.label}` : "Here";
            // None could be tried, for one reason: that reason, and the records unmarked.
            if (r.untried) return { div: { className: "sbx-suggest small", children: [{ div: { className: "error", textContent: `Not tried as ${(people().find(([u]) => u === (api.peek(`${S}.step.as`) || as)) ?? [null, "them"])[1]}: ${r.untried}` } }, { span: { className: "muted", textContent: `${at}: ${r.candidates.length} ${noun} record(s) it allows${r.step?.allows ? ` (${Object.entries(r.step.allows).map(([f, v]) => `${words(f)} ${[].concat(v).join(" or ")}`).join(", ")})` : ""}.` } }] } };
            if (!r.candidates?.length) return { p: { className: "muted small sbx-suggest", textContent: r.step?.allows ? `${at}: no ${noun} in this sandbox is one it allows (${Object.entries(r.step.allows).map(([f, v]) => `${words(f)} ${[].concat(v).join(" or ")}`).join(", ")}).` : "" } };
            return { div: { className: "sbx-suggest small", children: [
                { span: { className: "muted", textContent: `${at}, suggested: ` } },
                ...r.candidates.slice(0, 10).map((c) => ({ button: {
                    key: c.id, type: "button", className: `sbx-sugg ${c.ok === true ? "ok" : c.ok === false ? "no" : "maybe"}`,
                    title: c.ok === true ? "It takes this one." : c.why ?? "", "aria-pressed": () => String(api.getState(`${S}.step.input.${k}`, "") === c.id),
                    onclick: () => { set(`step.input.${k}`, c.id); suggestAll(); },
                    children: [icon(c.ok === true ? "check" : c.ok === false ? "x" : "dot"), { strong: { textContent: ` ${c.title}` } }, ...(c.about?.length ? [{ span: { textContent: ` · ${c.about.map(words).join(" · ")}` } }] : []), { span: { className: "muted sbx-sugg-state", textContent: ` ${words(c.state)}` } }],
                } })),
                r.candidates.some((c) => c.ok === false) ? { div: { className: "muted", textContent: r.candidates.filter((c) => c.ok === false).slice(0, 3).map((c) => `${c.title}: ${c.why}`).join(" · ") } } : { span: {} },
                r.others || r.more ? { div: { className: "muted", textContent: [r.others ? `${r.others} other ${noun}(s) are not where ${r.step?.label ?? "it"} is done` : "", r.more ? `${r.more} more not tried` : ""].filter(Boolean).join("; ") } } : { span: {} },
            ] } };
        };
        const people = () => (home().users ?? []).map((u) => [u.id, u.name]);
        const inputControl = (k, spec) => {
            // Read where it is drawn (not by the form around it), so typing never redraws the form.
            const value = () => api.getState(`${S}.step.input.${k}`, "") ?? "";
            const put = (v) => { set(`step.input.${k}`, v); suggestAll(); };
            if (spec.type === "ref") return () => select(api.getState(`${S}.step.input.${k}`, "") ?? "", recordOptions(spec.to), put);
            if (spec.type === "enum") return select(api.peek(`${S}.step.input.${k}`) ?? "", [["", "—"], ...(spec.values ?? []).map((v) => [v, v])], put);
            if (spec.type === "boolean") return { input: { type: "checkbox", checked: () => value() === true, onchange: (e) => put(e.target.checked) } };
            if (spec.type === "rows") return jsonEditor(`step.input.${k}`, { label: spec.label ?? k, rows: 5, fields: spec.fields ?? {}, list: true });
            return { input: { type: ["integer", "decimal"].includes(spec.type) ? "number" : spec.type === "date" ? "date" : "text", step: spec.type === "decimal" ? "any" : undefined, value, oninput: (e) => put(e.target.value) } };
        };
        // Each named for the page's guide (§33): sbx:<its label>.
        // A JSON value: the code editor (coloured, a syntax error marked on its line), checked as it is
        // typed against what it is for: an object's fields (`fields`), or a table's rows (`rows`).
        const jsonEditor = (path, { label, rows = 5, fields = null, extra = [], list = false } = {}) => ({ CodeEditor: { key: `sbx-json-${path}`, mode: "json", rows, label, value: () => api.getState(`${S}.${path}`, "") ?? "", onInput: (t) => set(path, t), lint: (t) => jsonLint(t, { fields: typeof fields === "function" ? fields() : fields, extra, list }) } });
        const labelled = (label, control, hint, { wide = false } = {}) => ({ label: { className: `sbx-field${wide ? " wide" : ""}`, "data-guide": `sbx:${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, children: [{ span: { className: "muted small", textContent: label } }, control, hint ? { span: { className: "muted small", textContent: hint } } : { span: {} }] } });
        // An input or field by its label, for a refusal: the transaction's input, else the field's name.
        const fieldLabel = (d, f) => (f === "_signature" ? "Signature" : txs()[d?.transaction]?.inputs?.[f]?.label ?? words(f));
        // Where the records walking a flow are after a step: each traveler or subject once, at the innermost
        // run of its own (a route waiting at its sub flow is the way there, shown as the chain), never a
        // record that only takes part in another's run (a lot's device on the lot's route).
        const whereNow = (nodes) => Object.entries(nodes ?? {}).flatMap(([k, runs]) => {
            const own = Object.entries(runs).filter(([, r]) => !r.takesPart);
            const under = own.filter(([, r]) => r.state !== "ended");
            // Under way: the innermost (the one no other under way runs inside); all ended: the one at the top.
            const shown = under.length ? under.filter(([fl]) => !under.some(([, r]) => r.inside === fl)) : own.filter(([, r]) => !r.inside);
            return shown.map(([fl, r]) => {
                const chain = [];
                for (let at = r.inside; at && chain.length < 6; at = runs[at]?.inside) chain.unshift(flowLabel(at));
                const at = r.label ?? words(r.node);
                const said = r.state === "ended" ? `ended at ${at}` : r.state === "stopped" ? `stopped at ${at}: ${r.reason ?? ""}` : `at ${at}`;
                return `@${k} ${said} (${[...chain, flowLabel(fl)].join(" › ")})`;
            });
        }).join(" · ");
        const outcome = (s, i) => ({
            li: {
                key: `s${i}`, className: `sbx-step ${s.out.ok ? "ran" : "refused"}`,
                children: [
                    { div: { className: "sbx-step-head", children: [
                        { strong: `${i + 1}. ${describe(s.st, labelsOf())}` },
                        { span: { className: "muted small", textContent: ` as ${s.st.as}` } },
                        { span: { className: "spacer" } },
                        { button: { type: "button", className: "linkish small", textContent: "remove", onclick: confirmRemove(api, "this step", () => removeStep(i) )} },
                    ] } },
                    { div: { className: s.out.ok ? "ok-text small icon-text" : "error small icon-text", children: [icon(s.out.ok ? "check" : "warning"), { span: s.out.ok ? "Ran." : `Refused: ${s.out.error}` }] } },
                    s.expect.states ? { div: { className: "small", textContent: Object.entries(s.expect.states).map(([k, v]) => `@${k} → ${words(v)}`).join(" · ") } } : { span: {} },
                    s.expect.created ? { div: { className: "small muted", textContent: `Made: ${Object.entries(s.expect.created).map(([o, n]) => `${n} ${words(o)}`).join(", ")}` } } : { span: {} },
                    // A refusal's inputs, each with what is wrong with it (Good units: Required.).
                    !s.out.ok && s.out.fields && Object.keys(s.out.fields).length ? { ul: { className: "error small sbx-fields", children: Object.entries(s.out.fields).map(([f, msg]) => ({ li: { key: f, textContent: String(msg).startsWith(fieldLabel(s.st.do, f)) ? msg : `${fieldLabel(s.st.do, f)}: ${msg}` } })) } } : { span: {} },
                    whereNow(s.out.nodes) ? { div: { className: "small sbx-nodes icon-text", children: [icon("branch"), { span: whereNow(s.out.nodes) }] } } : { span: {} },
                    s.verdict ? { div: { className: s.verdict.length ? "error small" : "ok-text small", textContent: s.verdict.length ? `Not as the scenario expects: ${s.verdict.join("; ")}` : "As the scenario expects." } } : { span: {} },
                ],
            },
        });
        return {
            div: {
                className: "view sandbox",
                children: [
                    () => {
                        const change = api.getState(C);
                        if (change === null) return { h1: "Not found" };
                        if (!change) return { p: { className: "muted", textContent: "Loading…" } };
                        if (!api.isServer) titleTab(api, `/design/c/${id}/sandbox`, `Sandbox: ${change.title}`);
                        return { div: { className: "change-head", children: [
                            { div: { className: "title", children: [{ GuideToggle: { key: "guide-sandbox", guide: "sandbox" } }, { span: { className: "kind", textContent: "Sandbox" } }, { h1: change.title }, { Link: { to: `/design/c/${id}`, className: "btn ghost", textContent: "Back to the change" } }] } },
                            { p: { className: "muted small", textContent: "This change's draft, on copies of real records in a database of its own: nothing in the live database is written. Records you may not see are not copied. It closes after a quarter of an hour unused." } },
                        ] } };
                    },
                    // The records it starts with.
                    {
                        section: { className: "panel sbx-records", children: [
                            { h3: "Records it starts with" },
                            // Grouped: where they come from (a saved selection), adding to them, then what is chosen.
                            { div: { className: "sbx-group", children: [
                                { h4: "Start from a saved selection" },
                                // Saved selections: one stable select (its options live), and what to do with it.
                                () => {
                                    get("selRev", 0);
                                    const c = current();
                                    const dirty = edited();
                                    return { div: { className: "sbx-selection", children: [
                                        labelled("Saved selection", select(c?.id ?? "", [["", c || !Object.keys(get("spec", {})).length ? "New selection" : "Not saved"], ...sels().map((x) => [x.id, `${x.name} · ${x.count} record(s) · saved ${when(x.updated_at)}`])], (v) => switchTo(v), { "aria-label": "Saved selection" })),
                                        { div: { className: "sbx-selection-actions", children: [
                                            { button: { type: "button", className: "btn", disabled: () => busy() || (Boolean(current()) && !edited()) || !Object.keys(get("spec", {})).length, textContent: "Save", title: "Save these records over the selection (or as a new one)", onclick: save } },
                                            { button: { type: "button", className: "btn", disabled: () => busy() || !Object.keys(get("spec", {})).length, textContent: "Save as…", onclick: saveAs } },
                                            { button: { type: "button", className: "btn ghost", disabled: () => busy() || !current(), textContent: "Rename…", onclick: rename } },
                                            { button: { type: "button", className: "btn ghost", disabled: () => busy() || !current(), textContent: "Delete", onclick: remove } },
                                        ] } },
                                        { span: { className: `small ${dirty ? "tab-open" : "muted"}`, textContent: c ? (dirty ? `Edited since saved ${when(c.updated_at)}` : `Saved ${when(c.updated_at)}`) : Object.keys(get("spec", {})).length ? "Not saved: Save as… keeps them" : "" } },
                                    ] } };
                                },
                            ] } },
                            { div: { className: "sbx-group sbx-needs-group", children: [
                                { h4: "What a route needs" },
                                () => {
                                    const n = get("needs", null);
                                    if (!n) return { p: { className: "muted small", textContent: "Reading what the routes need…" } };
                                    if (n.error) return { p: { className: "error small", textContent: n.error } };
                                    if (!n.routes?.length) return { p: { className: "muted small", textContent: "No route, live or in this change: nothing to walk." } };
                                    const toChoose = n.needs.filter((x) => !x.have.length);
                                    const addable = toChoose.filter((x) => x.candidates.length).length;
                                    return { div: { children: [
                                        { div: { className: "sbx-add", children: [
                                            labelled("Route", select(n.flow ?? "", n.routes.map((r) => [r.name, `${r.label}${r.draft ? " (in this change)" : ""}`]), (v) => { set("needsFlow", v); loadNeeds(); }), "It, and the routes it runs: what each step needs."),
                                        ] } },
                                        { ul: { className: "sbx-needs", children: n.needs.map((x, i) => ({ li: { key: `${x.object}-${i}`, className: x.have.length ? "have" : "to-choose", children: [
                                            icon(x.have.length ? "check" : "dot"),
                                            { div: { children: [
                                                { strong: `${x.label}${Object.keys(x.where ?? {}).length ? `: ${whereWords(x.object, x.where)}` : ""}` },
                                                { span: { className: "muted small", textContent: ` · for ${x.why.slice(0, 3).join("; ")}${x.why.length > 3 ? ` and ${x.why.length - 3} more` : ""}` } },
                                                { div: { className: "small sbx-need-pick", children: x.have.length
                                                    ? [{ span: { className: "ok-text", textContent: `Chosen: ${x.have.map((k) => `@${k}`).join(", ")}` } }]
                                                    : x.candidates.length
                                                        ? [{ span: { className: "muted", textContent: "Add: " } }, ...x.candidates.map((c) => ({ button: { key: c.id, type: "button", className: "sbx-sugg", onclick: () => addNeed(x, c), children: [icon("plus"), { strong: ` ${c.title}` }, ...(c.about?.length ? [{ span: ` · ${c.about.map(words).join(" · ")}` }] : []), { span: { className: "muted sbx-sugg-state", textContent: ` ${words(c.state)}` } }] } }))]
                                                        : [{ span: { className: "error", textContent: x.traveler?.makers?.length ? "None on its way you may see:" : `None you may see: give one by hand.` } }] } },
                                                // The traveler may be made instead, by a step, once the sandbox is open (a receiving transaction).
                                                !x.have.length && x.traveler?.makers?.length ? { div: { className: "small muted", textContent: `Or make one: run ${x.traveler.makers.map((m) => m.label).join(" or ")} as a step, once the sandbox is open.` } } : { span: {} },
                                            ] } },
                                        ] } })) } },
                                        { div: { className: "sbx-needs-foot small", children: [
                                            { span: { className: toChoose.length ? "muted" : "ok-text", textContent: toChoose.length ? `${n.needs.length - toChoose.length} of ${n.needs.length} required records chosen.` : `All ${n.needs.length} required records chosen: the route can be walked to its end.` } },
                                            addable ? { button: { type: "button", className: "btn", disabled: busy, textContent: `Add all required records (${addable})`, onclick: addAllRequired } } : { span: {} },
                                        ] } },
                                    ] } };
                                },
                            ] } },
                            { div: { className: "sbx-group", children: [
                                { h4: "Add records" },
                                // Any record, found by its number, label or a value, whatever its object.
                                { div: { className: "sbx-find", children: [
                                    labelled("Find a record", { input: { type: "search", placeholder: "Search any object: a lot number, a tool, a name…", value: () => api.getState(`${S}.findText`, "") ?? "", oninput: (e) => search(e.target.value) } }, "Records you may see, from every object; click one to add it."),
                                    () => {
                                        const found = get("found", []) ?? [];
                                        const q = get("findText", "") ?? "";
                                        if (q.length < 2) return { span: {} };
                                        if (!found.length) return { p: { className: "muted small", textContent: `Nothing found for "${q}".` } };
                                        return { ul: { className: "sbx-found", children: found.map((h) => ({ li: { key: `${h.object}-${h.id}`, children: [{ button: { type: "button", className: "sbx-found-item", onclick: () => addFound(h), children: [icon("plus"), { strong: h.title }, { span: { className: "muted small", textContent: ` ${h.label}` } }, { span: { className: "badge", textContent: words(h.state) } }, { span: { className: "muted small", textContent: (h.details ?? []).map((d) => `${d.label}: ${d.value}`).join(" · ") } }] } }] } })) } };
                                    },
                                ] } },
                                { details: { className: "sbx-by-hand", children: [
                                    { summary: { className: "small", textContent: "Or add one by hand: give its data, or say where to find one" } },
                                    () => {
                                        const d = get("draft", {});
                                        const obj = objects()[d.object];
                                        return { div: { className: "sbx-add", children: [
                                            labelled("Key", { input: { value: () => api.getState(`${S}.draft.key`, "") ?? "", placeholder: "lot", oninput: (e) => set("draft.key", e.target.value.trim()) } }),
                                            labelled("Object", select(d.object ?? "", [["", "—"], ...Object.entries(objects()).map(([o, x]) => [o, x.label ?? o])], (v) => set("draft", { ...(api.peek(`${S}.draft`) ?? {}), object: v, id: null, title: null, state: null }))),
                                            labelled("How", select(d.mode ?? "pick", [["pick", "picked from live"], ["give", "given here"]], (v) => set("draft.mode", v))),
                                            d.mode === "give"
                                                ? labelled("Its data", jsonEditor("draft.data", { label: "Its data", rows: 6, fields: obj?.fields ?? null }), 'JSON, {"lot_no": "LOT9001AA-A", "product": "@product"}: "@key" names another record.', { wide: true })
                                                : labelled("Record", { input: { value: () => api.getState(`${S}.draft.text`, "") ?? "", placeholder: "Scan or type its label, then Enter", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); lookup(); } }, oninput: (e) => set("draft.text", e.target.value) } }, d.title ? `${d.title} · ${words(d.state)}` : "Or leave it, and say where to find one:"),
                                            d.mode === "give"
                                                ? labelled("State", select(d.state ?? "", [["", "its first"], ...(obj?.states ?? []).map((s) => [s, words(s)])], (v) => set("draft.state", v)))
                                                : labelled("Where", jsonEditor("draft.where", { label: "Where", rows: 3, fields: obj?.fields ?? null, extra: ["state"] }), `If that one is gone or moved on, the newest that matches is used: ${d.state ? `{"state": ["${d.state}"]}` : '{"state": ["waiting"]}'}.`, { wide: true }),
                                            { div: { className: "sbx-field sbx-button", children: [{ span: { className: "muted small", textContent: "\u00a0" } }, { button: { type: "button", className: "btn", textContent: "Add", onclick: addRecord } }] } },
                                        ] } };
                                    },
                                ] } },
                            ] } },
                            { div: { className: "sbx-group", children: [
                                () => { const n = Object.keys(get("spec", {}) ?? {}).length; return { h4: `Records chosen${n ? ` (${n})` : ""}` }; },
                                () => {
                                    const spec = get("spec", {});
                                    const live = box().records ?? {};
                                    const rows = Object.entries(spec);
                                    if (!rows.length) return { p: { className: "muted small", textContent: "None yet: find one above, or add one by hand. Records they refer to come with them." } };
                                    return { table: { className: "grid", children: [{ tbody: { children: rows.map(([k, r]) => ({ tr: { key: k, children: [
                                        { td: { children: [{ code: `@${k}` }] } },
                                        { td: words(objects()[r.object]?.label ?? r.object) },
                                        { td: { className: "small", textContent: r.data !== undefined ? `given: ${json(r.data)}${r.state ? `, ${r.state}` : ""}` : `picked: ${r.note ?? r.id?.slice(0, 8) ?? ""}${r.where ? ` (or one where ${json(r.where)})` : ""}` } },
                                        // A picked one may start in a state of its own here (a tool down live, idle in the sandbox).
                                        { td: { className: "small sbx-starts", children: r.data !== undefined ? [] : [select(r.state ?? "", [["", "starts as it is live"], ...(objects()[r.object]?.states ?? []).map((st) => [st, `starts ${words(st)}`])], (v) => { const next = { ...(get("spec", {}) ?? {}) }; const { state: _was, ...rest } = next[k] ?? {}; next[k] = v ? { ...rest, state: v } : rest; set("spec", next); }, { "aria-label": `@${k} starts as`, className: r.state ? "chosen" : "" })] } },
                                        { td: { className: "small", textContent: live[k] ? `${live[k].title} · ${words(live[k].state)}` : "" } },
                                        { td: { children: [{ button: { type: "button", className: "linkish small", textContent: "remove", onclick: confirmRemove(api, `${k}`, () => { const next = { ...get("spec", {}) }; delete next[k]; set("spec", next); } )} }] } },
                                    ] } })) } }] } };
                                },
                            ] } },
                            { div: { className: "view-actions", children: [
                                { button: { type: "button", className: "btn primary", disabled: busy, textContent: () => (box().open ? "Open it again with these records" : "Open the sandbox"), onclick: openBox } },
                                { button: { type: "button", className: "btn", hidden: () => !box().open, disabled: busy, textContent: "Start again", title: "Fresh copies of the live records; the given ones made anew", onclick: resetBox } },
                                { button: { type: "button", className: "btn ghost", hidden: () => !box().open, disabled: busy, textContent: "Close", onclick: closeBox } },
                            ] } },
                        ] },
                    },
                    // Following a route by hand: a traveler, its map, what its step offers, what its plans ask.
                    {
                        section: { className: "panel sbx-follow", hidden: () => !box().open, children: [
                            { h3: "Follow a route" },
                            () => {
                                const list = get("follow.list", []) ?? [];
                                if (!list.length) return { p: { className: "muted small", textContent: "Nothing here is on a route yet: run the transaction that makes a traveler, or start with a record already on its way." } };
                                return { div: { className: "sbx-add", children: [
                                    labelled("Traveler", select(followed() ?? "", list.map((x) => [x.id, `${x.key ? `@${x.key} · ` : ""}${x.title} · ${x.label} · ${x.route}${x.runState === "ended" ? ` (ended: ${words(x.outcome)})` : x.runState === "stopped" ? " (stopped)" : ""}`]), pickTraveler), "The records on a route here, those its steps made too."),
                                ] } };
                            },
                            () => {
                                const w = get("follow.where", null);
                                if (!followed()) return { span: {} };
                                if (!w) return { p: { className: "muted small", textContent: "Reading where it is…" } };
                                if (w.error) return { p: { className: "error small", textContent: w.error } };
                                const r = w.route;
                                if (!r) return { p: { className: "muted small", textContent: "It is on no route that this person can see." } };
                                const offers = r.state === "running" ? r.offers ?? [] : [];
                                return { div: { className: "sbx-where", children: [
                                    { p: { className: "small", children: [
                                        { span: { className: "muted", textContent: `${[...(r.inside ?? [])].reverse().map((x) => `${x.label} › `).join("")}${r.label} · ` } },
                                        { strong: r.state === "ended" ? `ended: ${words(r.outcome)}` : r.state === "stopped" ? `stopped at ${r.nodeLabel}` : `at ${r.nodeLabel}` },
                                        r.state === "stopped" ? { span: { className: "error", textContent: ` · ${r.reason ?? ""}` } } : { span: {} },
                                    ] } },
                                    r.map ? routeMaps(api, r, { view: `${S}.follow.view.${followed()}`, key: `sbx-${followed()}` }) : { span: {} },
                                    offers.length ? { div: { className: "sbx-offers", children: [
                                        { span: { className: "muted small", textContent: `${r.nodeLabel} offers: ` } },
                                        ...offers.map((n) => (txs()[n]
                                            ? { button: { key: n, type: "button", className: "btn", disabled: busy, textContent: txs()[n].label ?? n, onclick: () => offer(n) } }
                                            : { span: { key: n, className: "muted small", textContent: ` ${words(n)} (not one you may see)` } })),
                                    ] } } : r.state === "running" ? { p: { className: "muted small", textContent: `${r.nodeLabel} offers nothing to run: it waits for a plan, or for its step to be set.` } } : { span: {} },
                                    ...(w.tasks ?? []).map((task) => ({ div: { key: task.run, className: "sbx-task", children: [
                                        { span: { className: "small", children: [icon("personChoice"), { strong: ` ${task.label}: ${task.nodeLabel}` }, { span: { className: "muted", textContent: `${task.subject ? ` · ${task.subject.title}` : ""}${task.for ? ` · for ${[...(task.for.groups ?? []), ...(task.for.users ?? [])].join(", ") || "nobody"}` : ""}` } }] } },
                                        task.message ? { div: { className: "muted small", textContent: task.message } } : { span: {} },
                                        { div: { className: "sbx-offers", children: task.kind === "manual_decision"
                                            ? (task.choices ?? []).map((c) => ({ button: { key: c, type: "button", className: "btn", disabled: busy, textContent: c, onclick: () => answer(task, c) } }))
                                            : [{ button: { type: "button", className: "btn", disabled: busy, textContent: task.kind === "input_screen" ? "Fill it in…" : "Answer…", onclick: () => answer(task) } }] } },
                                    ] } })),
                                ] } };
                            },
                        ] },
                    },
                    // A step, run in it.
                    {
                        section: { className: "panel sbx-run", hidden: () => !box().open, children: [
                            { h3: "Run a step" },
                            () => {
                                const st = get("step", {});
                                const t = txs()[st.name];
                                const kindNames = st.kind === "transaction" ? Object.entries(txs()).map(([n, x]) => [n, `${x.label ?? n}${x.draft ? " (in this change)" : ""}`])
                                    : st.kind === "create" ? Object.entries(objects()).map(([o, x]) => [o, x.label ?? o])
                                    : st.kind === "service" ? (home().services ?? []).map((s) => [s.name, s.label ?? s.name])
                                    : st.kind === "screen" ? (home().screens ?? []).map((s) => [s.name, s.label ?? s.name]) : [];
                                const recObject = Object.values(box().records ?? {}).find((r) => r.id === st.record)?.object;
                                return { div: { className: "sbx-step-form", children: [
                                    { div: { className: "sbx-add", children: [
                                        labelled("What", select(st.kind ?? "transaction", KINDS, (v) => set("step", { kind: v, as: st.as }))),
                                        kindNames.length ? labelled(st.kind === "create" ? "Object" : "Which", select(st.name ?? "", [["", "—"], ...kindNames], (v) => { set("step", { kind: st.kind, as: st.as, name: v, ...(st.kind === "transaction" ? { input: travelerInputOf(v) } : {}) }); set("sugg", {}); suggestAll(); })) : { span: {} },
                                        ["action", "update", "screen", "act"].includes(st.kind) ? labelled("Record", select(st.record ?? "", allRecordOptions(), (v) => set("step.record", v))) : { span: {} },
                                        st.kind === "act" ? labelled("Plan", select(st.name ?? "", [["", "the one waiting on it"], ...Object.entries(plans())], (v) => set("step.name", v))) : { span: {} },
                                        st.kind === "act" ? labelled("How", select(st.how ?? "fill", ACTS, (v) => set("step.how", v))) : { span: {} },
                                        st.kind === "act" && st.how === "choose" ? labelled("Choice", { input: { value: () => api.getState(`${S}.step.choice`, "") ?? "", placeholder: "Material", oninput: (e) => set("step.choice", e.target.value) } }, "As the wire is labelled.") : { span: {} },
                                        st.kind === "action" && recObject ? labelled("Action", select(st.name ?? "", [["", "—"], ...(objects()[recObject]?.transitions ?? []).map((x) => [x.action, x.label ?? x.action])], (v) => set("step.name", v))) : { span: {} },
                                        labelled("As", select(st.as ?? as, people(), (v) => { set("step.as", v); suggestAll(); }), "Their roles decide, as they will live."),
                                    ] } },
                                    st.kind === "transaction" && t ? { div: { className: "sbx-inputs", children: Object.entries(t.inputs ?? {}).filter(([, s]) => !s.from).map(([k, s]) => ({ div: { key: k, children: [labelled(`${s.label ?? k}${s.required ? " *" : ""}`, inputControl(k, s)), s.type === "ref" ? suggestionsOf(k, s) : { span: {} }] } })) } } : { span: {} },
                                    st.kind === "transaction" && t?.signature ? { label: { className: "small", children: [{ input: { type: "checkbox", checked: Boolean(st.sign), onchange: (e) => set("step.sign", e.target.checked) } }, { span: ` Signed: “${t.signature.meaning}”` }] } } : { span: {} },
                                    // A second person verifies it (§7.4): in a sandbox, the one named here, with no password.
                                    st.kind === "transaction" && t?.signature?.verifier && st.sign ? labelled("Verified by", select(st.verifier ?? "", [["", "—"], ...people()], (v) => set("step.verifier", v)), `“${t.signature.verifier.meaning}”: someone who may verify it; no password in a sandbox.`) : { span: {} },
                                    st.kind === "act" && (st.how ?? "fill") === "fill" ? labelled("Values", jsonEditor("step.data", { label: "Values", rows: 5 }), 'Its fields by name, as JSON, {"value": 32, "note": "Fixture reseated"}; a file as {"name", "type", "data": base64}.', { wide: true }) : { span: {} },
                                    ["update", "create", "service"].includes(st.kind) ? labelled(st.kind === "service" ? "Input" : "Data", jsonEditor("step.data", { label: st.kind === "service" ? "Input" : "Data", rows: 6, fields: st.kind === "service" ? null : objects()[st.kind === "create" ? st.name : recObject]?.fields ?? null }), 'JSON, {"qty": 900}: "@key" names a record of the sandbox.', { wide: true }) : { span: {} },
                                    // A picture for an image field (§35): uploaded here, its name put into the data.
                                    ...(["update", "create"].includes(st.kind) ? Object.entries(objects()[st.kind === "create" ? st.name : recObject]?.fields ?? {}).filter(([, f]) => f?.type === "image").map(([k, f]) => ({ label: { key: `pic-${k}`, className: "btn", title: `Uploads a picture and sets "${k}" to it in the data above`, children: [
                                        { span: `Upload a picture for ${f.label ?? k}…` },
                                        { input: { type: "file", accept: PICTURE_TYPES.join(","), className: "visually-hidden", onchange: async (e) => {
                                            const file = e.target.files?.[0];
                                            e.target.value = "";
                                            if (!file) return;
                                            try {
                                                const pic = await uploadPicture(file);
                                                let data = {};
                                                try { data = JSON.parse(api.peek(`${S}.step.data`) || "{}"); } catch { data = {}; }
                                                set("step.data", JSON.stringify({ ...(data && typeof data === "object" && !Array.isArray(data) ? data : {}), [k]: pic.blob }, null, 2));
                                            } catch (err) { set("error", err.message); }
                                        } } },
                                    ] } })) : []),
                                    st.kind === "create" ? labelled("Name it, for later steps", { input: { value: () => api.getState(`${S}.step.key`, "") ?? "", placeholder: "dev", oninput: (e) => set("step.key", e.target.value.trim()) } }) : { span: {} },
                                    { div: { className: "view-actions", children: [{ button: { type: "button", className: "btn primary", disabled: busy, textContent: "Run", onclick: () => { try { runStep(); } catch (e) { set("error", e.message); } } } }] } },
                                ] } };
                            },
                            () => {
                                const planned = get("planned", []);
                                if (!planned.length) return { span: {} };
                                return { div: { className: "sbx-planned", children: [
                                    { p: { className: "small", textContent: `The scenario "${get("save", {}).name}": ${planned.length} step(s): ${planned.map((p) => describe(p, labelsOf())).join("; ")}.` } },
                                    { button: { type: "button", className: "btn", disabled: busy, textContent: "Run its steps", onclick: runPlanned } },
                                ] } };
                            },
                        ] },
                    },
                    // What ran, and saving it.
                    {
                        section: { className: "panel sbx-steps", hidden: () => !box().open, children: [
                            { h3: "What ran" },
                            () => {
                                const steps = get("steps", []);
                                return steps.length ? { ol: { className: "sbx-steps-list", children: steps.map(outcome) } } : { p: { className: "muted small", textContent: "Nothing yet." } };
                            },
                            () => {
                                const tx = [...Object.keys(draftTx()), ...Object.keys(draftFlows()).map((n) => `flow:${n}`)];
                                if (!api.getState(`${C}.can.edit`, false)) return { p: { className: "muted small", textContent: "Only the change's author and co-designers save scenarios to it." } };
                                if (!tx.length) return { p: { className: "muted small", textContent: "A scenario is kept by a transaction or a flow template of this change; this change has none." } };
                                const sv = get("save", {});
                                return { div: { className: "sbx-add", children: [
                                    labelled("Keep it as a scenario of", select(sv.tx ?? "", [["", "—"], ...tx.map((n) => [n, n.startsWith("flow:") ? `${flowLabel(n.slice(5))} (flow template)` : draftTx()[n]?.label ?? n])], (v) => set("save.tx", v))),
                                    labelled("Named", { input: { value: () => api.getState(`${S}.save.name`, "") ?? "", placeholder: "what it shows", maxLength: 120, oninput: (e) => set("save.name", e.target.value) } }),
                                    { button: { type: "button", className: "btn primary", disabled: busy, textContent: "Save the scenario", onclick: saveScenario } },
                                ] } };
                            },
                        ] },
                    },
                    { p: { className: "error", textContent: () => get("error", "") ?? "" } },
                    { p: { className: "notice", textContent: () => get("notice", "") ?? "" } },
                ],
            },
        };
    });
}

// A step in words: "Move in" (its label), "hold @lot", "edit @lot".
function describe(st, labels = {}) {
    const d = st?.do ?? {};
    if (d.transaction) return labels[d.transaction] ?? words(d.transaction);
    if (d.action) return `${words(d.action)} ${d.record ?? ""}`;
    if (d.update !== undefined) return `edit ${d.update}`;
    if (d.create) return `make a ${words(d.create)}${d.key ? ` (@${d.key})` : ""}`;
    if (d.service) return `call ${words(d.service)}`;
    if (d.screen) return `open ${words(d.screen)}`;
    if (d.act) return `answer ${d.act.plan ? words(d.act.plan) : "the plan"} on ${d.act.record ?? ""}: ${d.act.values ? "fill in" : d.act.choice ? `“${d.act.choice}”` : words(d.act.action ?? "")}`;
    return "a step";
}

// The browser's own reading of a step against what a scenario expects (the server's is sandbox.js
// verdict, which the fitness test uses): run or refused, the words, the states.
function checkAgainst(expect, out) {
    const problems = [];
    if ((expect.ok ?? true) !== out.ok) problems.push(out.ok ? "it ran, but was expected to be refused" : `it was refused: ${out.error}`);
    if (expect.error && !String(out.error ?? "").includes(expect.error)) problems.push(`expected the words "${expect.error}"`);
    for (const [k, v] of Object.entries(expect.states ?? {})) if (out.states?.[k] !== v) problems.push(`@${k} is ${out.states?.[k] ?? "missing"}, expected ${v}`);
    for (const [k, v] of Object.entries(expect.node ?? {})) if (!Object.values(out.nodes?.[k] ?? {}).some((r) => r.node === v)) problems.push(`@${k} is not at ${v}`);
    return problems;
}
