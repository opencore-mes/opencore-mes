// A dropdown never shows a value nobody chose. A browser shows a select's first option when none is
// marked as chosen, which reads as a choice that was never made (a field type, a department, an
// object): `noDefault(options)` puts "choose…" first when no option is the chosen one, so an unset
// value looks unset. Left as it is: a select that already offers an empty option of its own (its
// own words for "none"), and one with something chosen.
const flat = (nodes) => nodes.flatMap((n) => (n?.optgroup ? flat(Array.isArray(n.optgroup.children) ? n.optgroup.children : []) : [n]));
const chosen = (o) => (typeof o?.option?.selected === "function" ? o.option.selected() : o?.option?.selected) === true;

export function noDefault(options, words = "choose…") {
    if (typeof options === "function") return () => noDefault(options(), words);
    if (!Array.isArray(options)) return options;
    const all = flat(options).filter((n) => n?.option);
    if (!all.length || all.some((o) => o.option.value === "" || o.option.value === undefined)) return options;
    // Options chosen by a function (they follow what is typed): the placeholder follows them too.
    if (all.some((o) => typeof o.option.selected === "function")) return [{ option: { key: "$unchosen", value: "", disabled: true, selected: () => !all.some(chosen), textContent: words } }, ...options];
    return all.some(chosen) ? options : [{ option: { key: "$unchosen", value: "", disabled: true, selected: true, textContent: words } }, ...options];
}
