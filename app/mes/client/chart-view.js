// A chart drawn (DESIGN.md §34.9): a chart's spec and its query's rows ({ columns, rows }), turned into the
// drawing library's option by charts.js and drawn by Apache ECharts (vendored with the app, served at
// /vendor/echarts.js, loaded the first time a chart is shown). In SVG, sized by its box, in the theme's
// colours (the series tokens, the tones), redrawn when the box or the theme changes. On the server, and
// until the library is in, its box holds its place and says what it is.
import { chartOption } from "./charts.js";
import { plant } from "./format.js";

let library = null;
const load = () => (library ??= import("/vendor/echarts.js"));

// The theme as the page draws it now: its tokens, read where the chart is.
function themeOf(el) {
    const css = getComputedStyle(el);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
        palette: Array.from({ length: 8 }, (_, i) => v(`--series-${i}`, "#2f5fd0")),
        ink: v("--ink", "#1d2230"), muted: v("--muted", "#667085"), line: v("--line", "#e3e6ec"), panel: v("--panel", "#ffffff"),
        font: css.fontFamily || "system-ui, sans-serif",
        tones: { neutral: v("--muted", "#667085"), info: v("--series-0", "#2f5fd0"), ok: v("--ok", "#067647"), warn: v("--warn", "#b54708"), danger: v("--danger", "#b42318") },
        number: (n) => plant().number(n),
    };
}

export function registerChartView(juris) {
    // props: spec (charts.js), data ({ columns, rows }), title, height (px), more (rows were left out).
    juris.registerComponent("ChartView", ({ spec, data, title = "", height = 300, more = false }, api) => {
        const id = `ch-${Math.random().toString(36).slice(2, 10)}`;
        const [problem, setProblem] = api.useState("problem", null);
        if (!api.isServer) {
            api.onMount(() => {
                const el = document.getElementById(id);
                if (!el) return undefined;
                let chart = null, gone = false;
                const draw = (lib) => {
                    if (gone) return;
                    const made = chartOption(spec, data, themeOf(el));
                    if (made.problem) { setProblem(made.problem); return; }
                    chart ??= lib.init(el, null, { renderer: "svg" });
                    chart.setOption(made.option, true);
                };
                load().then(draw, () => setProblem("The chart could not be drawn: reload the page."));
                // The box resized (a window, a pane, a maximized screen), or the theme turned light or dark.
                const sized = typeof ResizeObserver === "function" ? new ResizeObserver(() => chart?.resize()) : null;
                sized?.observe(el);
                const themed = new MutationObserver(() => library?.then(draw));
                themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
                const scheme = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
                const onScheme = () => library?.then(draw);
                scheme?.addEventListener?.("change", onScheme);
                return () => { gone = true; sized?.disconnect(); themed.disconnect(); scheme?.removeEventListener?.("change", onScheme); chart?.dispose(); };
            });
        }
        return {
            div: {
                className: "chart-view",
                children: [
                    () => (problem() ? { p: { className: "muted small rep-problem", textContent: problem() } } : { span: {} }),
                    { div: { id, className: "chart-box", role: "img", "aria-label": `${title || "A chart"}: ${spec?.chart ?? ""}`, style: `height:${height}px` } },
                    more ? { p: { className: "muted small", textContent: "Drawn from the first rows its query answered: narrow it, or sum in the query." } } : { span: {} },
                ],
            },
        };
    });
}
