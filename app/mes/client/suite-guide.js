// An installed suite's set-up guide (DESIGN.md §29.8): how a plant takes the suite into its own setup, step by
// step and by who, from the suite's integration.json. Plain text throughout: a guide is never drawn as markup.
import { icon, withIcon } from "./icons.js";
import { titleTab } from "./shell.js";

// A step that installs the suite (its commands sign in to the suites store or install it): done already here, since
// a guide is shown only for a suite installed here. Its commands stay, greyed, for another installation.
const INSTALLS = /^opencore-mes suite (login|install)\b/;
const installs = (st) => (st.commands ?? []).some((c) => INSTALLS.test(String(c).trim()));

export function registerSuiteGuide(juris, { args }) {
    juris.registerComponent("SuiteGuidePage", ({ suite }, api) => {
        const as = api.getState("me.id", null, { track: false });
        const G = `suiteGuide.${suite}`;
        api.live(G, "design.suiteGuide", args.suiteGuide(suite, as));
        // Its tab is named after the guide once it is here.
        if (!api.isServer) api.onCleanup(api.bindState(() => api.getState(`${G}.title`), () => titleTab(api, `/design/suites/${suite}/guide`, api.peek(`${G}.title`) ?? "Set-up guide")));
        const [copied, setCopied] = api.useState("copied", null);
        const copy = (key, text) => navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 1500); }, () => {});
        return {
            div: {
                className: "view suite-guide",
                children: () => {
                    const g = api.getState(G, undefined);
                    if (g === undefined) return [{ p: { className: "muted", textContent: "Loading…" } }];
                    if (!g) return [{ p: { textContent: `No suite named "${suite}" with a set-up guide is installed here.` } }, { Link: { to: "/design/suites", textContent: "Back to the suites" } }];
                    return [
                        { div: { className: "suite-guide-top", children: [{ Link: { to: "/design/suites", className: "small", textContent: "Suites" } }, { span: { className: "muted small", textContent: ` › ${g.suite}` } }, { span: { className: "badge", textContent: g.version } }] } },
                        { h2: g.title },
                        g.intro ? { p: { className: "suite-guide-intro", textContent: g.intro } } : { span: {} },
                        // It is installed here already: say so before anyone runs its install again.
                        { p: { className: "suite-guide-installed", role: "note", children: [icon("check"), { span: `${g.suite} ${g.version} is installed here already. Its install steps are marked done: their commands are for another installation (test, training, production). What is left is what your plant does with it.` }] } },
                        {
                            ol: {
                                className: "suite-guide-steps",
                                children: g.steps.map((st, i) => ({
                                    li: {
                                        key: `s${i}`, className: installs(st) ? "suite-guide-done" : undefined,
                                        children: [
                                            installs(st) ? { p: { className: "suite-guide-done-note small", children: [icon("check"), { span: `Done here: ${g.suite} ${g.version} is installed.` }] } } : { span: {} },
                                            { div: { className: "suite-guide-head", children: [{ span: { className: "suite-guide-n", textContent: String(i + 1) } }, { strong: st.title }, st.who ? { span: { className: "badge", textContent: st.who } } : { span: {} }] } },
                                            { p: { textContent: st.text } },
                                            st.items?.length ? { ul: { children: st.items.map((t, k) => ({ li: { key: `i${k}`, textContent: t } })) } } : { span: {} },
                                            ...(st.commands ?? []).map((c, k) => ({
                                                div: {
                                                    key: `c${k}`, className: "suite-guide-command",
                                                    children: [
                                                        { pre: { textContent: c } },
                                                        { button: { type: "button", className: "btn ghost small", title: "Copy", "aria-label": "Copy", children: () => [icon(copied() === `${i}.${k}` ? "check" : "copy")], onclick: () => copy(`${i}.${k}`, c) } },
                                                    ],
                                                },
                                            })),
                                        ],
                                    },
                                })),
                            },
                        },
                        { p: { className: "muted small", children: [{ span: { textContent: "Nothing in this guide changes the plant by itself: the suite's designs reach it only through a change request, reviewed and approved. " } }, { Link: { to: "/design/suites", children: [withIcon("steps", "Back to the suites")] } }] } },
                    ];
                },
            },
        };
    });
}
