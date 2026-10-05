// The hello suite's browser module: its navigator entry, its page and its component, built only from
// what the platform hands it (`kit`).
import { validate } from "./design.js";

export const suite = "hello";
// Its part of an object's design: checked in the designer, edited on its own tab.
export const designs = { object: { label: "Hello", validate, component: "HelloDesignTab" } };
// Its screen block kind (§30.11): drawn by its own component, given the block and its data.
export const blocks = { "hello.notes": { component: "HelloNotesBlock" } };
// Its kind of design element (§30.11): edited by its own component, beside the platform's tabs.
export const elements = { "hello.card": { label: "Greeting card", component: "HelloCardEditor" } };
export const nav = [{ group: "Data", label: "Hello notes", to: "/hello", words: "hello notes greeting" }];
export const styles = ["hello.css"];

export function routes(kit) {
    return [{ path: "/hello", name: "hello", component: "HelloPage", preload: ({ viewer }) => (viewer ? [["hello.notes", { as: viewer }], ...kit.shell(viewer)] : []), head: { title: "Hello" } }];
}

export function register(juris, kit) {
    juris.registerComponent("HelloCardEditor", ({ body, ops, ro }) => ({
        div: {
            className: "hello-card-editor",
            children: [
                { label: { children: [{ span: "To" }, { input: { className: "hello-card-to", disabled: ro, value: body.to ?? "", onchange: (e) => ops.edit((b) => { b.to = e.target.value; }) } }] } },
                { label: { children: [{ span: "Message" }, { input: { className: "hello-card-message", disabled: ro, value: body.message ?? "", onchange: (e) => ops.edit((b) => { b.message = e.target.value; }) } }] } },
            ],
        },
    }));
    juris.registerComponent("HelloNotesBlock", ({ data }) => ({
        div: {
            className: "hello-block",
            children: [{ p: { className: "hello-block-greeting", textContent: data.greeting ?? "" } }, { ul: { children: (data.notes ?? []).map((n) => ({ li: { key: n.id, textContent: n.text } })) } }],
        },
    }));
    // The object editor's Hello tab: the greeting, and the script that shapes it (the platform's
    // ScriptPanel: source, dry run, test cases).
    juris.registerComponent("HelloDesignTab", ({ id, ops, ro, body }) => {
        const part = body.suites?.hello ?? {};
        const set = (fn) => ops.edit((b) => { b.suites ??= {}; b.suites.hello = { ...(b.suites.hello ?? {}) }; fn(b.suites.hello); });
        return {
            div: {
                className: "hello-design",
                children: [
                    { input: { className: "hello-greeting", disabled: ro, value: part.greeting ?? "", onchange: (e) => set((p) => { p.greeting = e.target.value; }) } },
                    part.script ? { ScriptPanel: { key: part.script, id, name: part.script, readOnly: ro, example: { text: part.greeting ?? "" } } } : { span: {} },
                ],
            },
        };
    });

    juris.registerComponent("HelloPage", (props, api) => {
        const as = api.getState("me.id", null, { track: false });
        api.live("hello.list", "hello.notes", { as });
        if (!api.isServer) kit.titleTab(api, "/hello", "Hello");
        const [text, setText] = api.useState("text", "");
        return {
            div: {
                className: "view hello",
                children: [
                    { h1: "Hello notes" },
                    { ul: { className: "hello-notes", children: () => (api.getState("hello.list", []) ?? []).map((n) => ({ li: { key: n.id, textContent: `${n.text} (${n.by_user})` } })) } },
                    { input: { className: "hello-text", value: () => text(), oninput: (e) => setText(e.target.value) } },
                    { button: { type: "button", className: "btn hello-add", textContent: "Add", onclick: () => api.call("hello.add", { text: text() }).then(() => setText("")) } },
                ],
            },
        };
    });
}
