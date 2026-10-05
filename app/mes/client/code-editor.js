// The designer's code editor, with no library: syntax highlighting, line numbers, auto-indentation
// and syntax errors marked on their line, for rule scripts, service scripts and JSON.
//
//   { CodeEditor: { value: () => text, onInput: (text) => …, readOnly: () => bool, mode: "js" | "json" | "sql", rows, label,
//                   onSubmit: () => …   Ctrl/⌘ + Enter (the query console runs its query)
//                   lint: (text) => [{ line, col, message }]   warnings (what the script will not be able to call)
//                   runError: () => { line, column, message, source } | null }   a dry run's error, shown while the text is `source` }
//
// How it is drawn: a transparent <textarea> (the caret, the selection, the keyboard, undo, IME and
// the screen reader stay the browser's own) over a <pre> that holds the same text, coloured, with a
// gutter of line numbers beside them. Both grow to the text, so they never scroll apart; the frame
// around them scrolls.
//
// Errors are found without running anything: a script is only ever parsed (a function built from it
// is never called), since a reviewer's page parses a script someone else wrote. The tokenizer below
// places the errors it can see itself (a string, comment or template never closed, a bracket that
// closes the wrong thing or nothing); for the rest, the parser's own words, placed by parsing ever
// shorter beginnings of the script until one parses: the error is on the line after it.

const KEYWORDS = new Set("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch throw try typeof var void while with yield async await".split(" "));
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity", "this"]);
// After these, a / starts a regular expression, not a division.
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const OPERATOR = /^(?:===|!==|\*\*=|\.\.\.|\?\?=|&&=|\|\|=|>>>=|>>>|<<=|>>=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\*\*|<<|>>|[-+*/%=<>!&|^~?:;,.@#])/;
const CLOSER = { "(": ")", "[": "]", "{": "}" };
const OPENER = { ")": "(", "]": "[", "}": "{" };
const INDENT = "  ";

export function lineCol(text, at) {
    let line = 1;
    let start = 0;
    for (let i = 0; i < at && i < text.length; i++) if (text[i] === "\n") { line++; start = i + 1; }
    return { line, col: at - start + 1 };
}

// tokenize(src, mode) → { tokens: [{ type, text, start }], problems: [{ at, message }], open: [{ ch, at }] }
// Types: space, comment, string, key, number, keyword, literal, regex, bracket, punct, ident, func, prop, plain.
export function tokenize(src, mode = "js") {
    if (mode === "sql") return tokenizeSql(src);
    const js = mode === "js";
    const tokens = [];
    const problems = [];
    const stack = [];
    const pairs = []; // { open, close }: where each bracket pair opened and closed
    let prev = null; // the last token that is not space or a comment
    let i = 0;
    const push = (type, start) => {
        const token = { type, text: src.slice(start, i), start };
        tokens.push(token);
        if (type !== "space" && type !== "comment") prev = token;
        return token;
    };
    const nextChar = () => /^\s*(.)?/.exec(src.slice(i, i + 200))?.[1];
    while (i < src.length) {
        const c = src[i];
        const start = i;
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
            while (i < src.length && " \t\n\r".includes(src[i])) i++;
            push("space", start);
        } else if (js && c === "/" && src[i + 1] === "/") {
            const nl = src.indexOf("\n", i);
            i = nl < 0 ? src.length : nl;
            push("comment", start);
        } else if (js && c === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2);
            if (end < 0) { problems.push({ at: start, message: "This comment is never closed (*/)." }); i = src.length; } else i = end + 2;
            push("comment", start);
        } else if (c === '"' || (js && c === "'")) {
            const after = prev;
            i++;
            while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
            if (src[i] === c) i++; else problems.push({ at: start, message: `This string is never closed (${c}).` });
            const token = push("string", start);
            // A key: in JSON, any string before a colon; in JavaScript, one that opens an entry.
            if (nextChar() === ":" && (!js || (after && (after.text === "{" || after.text === ",")))) token.type = "key";
        } else if (js && c === "`") {
            i++;
            let depth = 0; // inside ${ … }, counting braces
            while (i < src.length) {
                const d = src[i];
                if (d === "\\") { i += 2; continue; }
                if (depth === 0 && d === "`") break;
                if (d === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
                if (depth > 0 && d === "{") depth++;
                if (depth > 0 && d === "}") depth--;
                i++;
            }
            if (src[i] === "`") i++; else problems.push({ at: start, message: "This template string is never closed (`)." });
            push("string", start);
        } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
            const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/.exec(src.slice(i, i + 100));
            i += m ? m[0].length : 1;
            push("number", start);
        } else if (/[A-Za-z_$À-￿]/.test(c)) {
            while (i < src.length && /[\w$À-￿]/.test(src[i])) i++;
            const word = src.slice(start, i);
            let type = "ident";
            if (!js) type = LITERALS.has(word) ? "literal" : "plain";
            else if (prev && (prev.text === "." || prev.text === "?.")) type = "prop";
            else if (KEYWORDS.has(word)) type = "keyword";
            else if (LITERALS.has(word)) type = "literal";
            else if (nextChar() === "(") type = "func";
            else if (nextChar() === ":" && prev && (prev.text === "{" || prev.text === ",")) type = "prop";
            push(type, start);
        } else if (js && c === "/" && (!prev || prev.type === "punct" || (prev.type === "bracket" && "([{".includes(prev.text)) || (prev.type === "keyword" && BEFORE_REGEX.has(prev.text)))) {
            i++;
            let inClass = false;
            while (i < src.length && src[i] !== "\n") {
                const d = src[i];
                if (d === "\\") { i += 2; continue; }
                if (d === "[") inClass = true;
                else if (d === "]") inClass = false;
                else if (d === "/" && !inClass) break;
                i++;
            }
            if (src[i] === "/") { i++; while (/[a-z]/.test(src[i] ?? "")) i++; } else problems.push({ at: start, message: "This regular expression is never closed (/)." });
            push("regex", start);
        } else if (c in CLOSER) {
            stack.push({ ch: c, at: i });
            i++;
            push("bracket", start);
        } else if (c in OPENER) {
            const open = stack.at(-1);
            if (!open) problems.push({ at: i, message: `This ${c} closes nothing.`, sure: true });
            else if (open.ch !== OPENER[c]) {
                problems.push({ at: i, message: `This ${c} does not match the ${open.ch} on line ${lineCol(src, open.at).line}, which needs a ${CLOSER[open.ch]} first.`, sure: true });
                // The one left open is the likelier mistake: close it, and this one with what it matches.
                stack.pop();
                if (stack.at(-1)?.ch === OPENER[c]) stack.pop();
            } else pairs.push({ open: stack.pop().at, close: i });
            i++;
            push("bracket", start);
        } else {
            const m = OPERATOR.exec(src.slice(i, i + 4));
            i += m ? m[0].length : 1;
            push(m ? "punct" : "plain", start);
        }
    }
    // Innermost first: the last one opened is the likeliest to be missing its closer.
    for (const open of [...stack].reverse()) problems.push({ at: open.at, message: `This ${open.ch} is never closed: a ${CLOSER[open.ch]} is missing.` });
    // Something never closed: the indentation says where it was dropped. A closer that begins its
    // line but lines up with another line than its opener's most likely closed the wrong one.
    if (stack.length) {
        const indentAt = (at) => /^[ \t]*/.exec(src.slice(src.lastIndexOf("\n", at - 1) + 1))[0].length;
        const firstOnLine = (at) => /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", at - 1) + 1, at));
        const astray = pairs.filter((p) => firstOnLine(p.close) && indentAt(p.close) < indentAt(p.open)).sort((a, b) => a.open - b.open).at(-1);
        if (astray) {
            const ch = src[astray.open];
            problems.push({ at: astray.open, sure: true, message: `This ${ch} seems never closed: the ${CLOSER[ch]} on line ${lineCol(src, astray.close).line} lines up with an outer line, so a ${CLOSER[ch]} is likely missing before it.` });
        }
    }
    return { tokens, problems, open: stack };
}

// ---- SQL (the query console) ----
// Keywords, functions, strings ('…' with '' inside, $$…$$), "quoted" names, numbers, $1 parameters,
// ::type casts, -- and /* */ comments. Problems: a string, a quoted name or a comment never closed, a
// bracket that closes nothing or the wrong thing. The rest is the database's to say.
const SQL_KEYWORDS = new Set(`select from where and or not in is null as on join left right full inner outer cross lateral using group by order having limit offset
    distinct all any some exists between like ilike similar case when then else end with recursive union intersect except asc desc nulls first last
    true false interval filter over partition window rows range preceding following unbounded current row cast collate at time zone values
    insert update delete into set returning create drop alter table view index`.split(/\s+/));
const SQL_LITERALS = new Set(["null", "true", "false"]);
function tokenizeSql(src) {
    const tokens = [];
    const problems = [];
    const stack = [];
    let i = 0;
    const push = (type, start) => { tokens.push({ type, text: src.slice(start, i), start }); };
    while (i < src.length) {
        const c = src[i];
        const start = i;
        if (/\s/.test(c)) { while (i < src.length && /\s/.test(src[i])) i++; push("space", start); continue; }
        if (c === "-" && src[i + 1] === "-") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; push("comment", start); continue; }
        if (c === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2);
            if (end < 0) { problems.push({ at: start, message: "This comment is never closed (*/)." }); i = src.length; } else i = end + 2;
            push("comment", start);
            continue;
        }
        if (c === "'") {
            i++;
            while (i < src.length) { if (src[i] === "'" && src[i + 1] === "'") { i += 2; continue; } if (src[i] === "'") break; i++; }
            if (src[i] === "'") i++; else problems.push({ at: start, message: "This string is never closed (')." });
            push("string", start);
            continue;
        }
        if (c === "$" && /^\$(\w*)\$/.test(src.slice(i, i + 40))) {
            const tag = /^\$(\w*)\$/.exec(src.slice(i, i + 40))[0];
            const end = src.indexOf(tag, i + tag.length);
            if (end < 0) { problems.push({ at: start, message: `This ${tag} string is never closed.` }); i = src.length; } else i = end + tag.length;
            push("string", start);
            continue;
        }
        if (c === "$" && /[0-9]/.test(src[i + 1] ?? "")) { i++; while (/[0-9]/.test(src[i] ?? "")) i++; push("literal", start); continue; }
        if (c === '"') {
            i++;
            while (i < src.length) { if (src[i] === '"' && src[i + 1] === '"') { i += 2; continue; } if (src[i] === '"') break; i++; }
            if (src[i] === '"') i++; else problems.push({ at: start, message: 'This quoted name is never closed (").' });
            push("prop", start);
            continue;
        }
        if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
            const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 60));
            i += m ? m[0].length : 1;
            push("number", start);
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            while (i < src.length && /[\w$]/.test(src[i])) i++;
            const word = src.slice(start, i).toLowerCase();
            const before = tokens.filter((t) => t.type !== "space").at(-1);
            const after = /^\s*(.)?/.exec(src.slice(i, i + 80))?.[1];
            let type = "plain";
            if (before?.text === "::") type = "func";                         // a cast's type
            else if (SQL_LITERALS.has(word)) type = "literal";
            else if (after === "(" && !SQL_KEYWORDS.has(word)) type = "func";
            else if (SQL_KEYWORDS.has(word)) type = "keyword";
            push(type, start);
            continue;
        }
        if (c === "(" || c === "[") { stack.push({ ch: c, at: i }); i++; push("bracket", start); continue; }
        if (c === ")" || c === "]") {
            const open = stack.at(-1);
            const want = c === ")" ? "(" : "[";
            if (!open) problems.push({ at: i, message: `This ${c} closes nothing.`, sure: true });
            else if (open.ch !== want) { problems.push({ at: i, message: `This ${c} does not match the ${open.ch} on line ${lineCol(src, open.at).line}.`, sure: true }); stack.pop(); }
            else stack.pop();
            i++;
            push("bracket", start);
            continue;
        }
        const m = /^(?:::|<>|!=|<=|>=|\|\||->>|->|#>>|#>|@>|<@|\?\||\?&|[-+*/%=<>!~^&|?,;.:@#])/.exec(src.slice(i, i + 4));
        i += m ? m[0].length : 1;
        push(m ? "punct" : "plain", start);
    }
    for (const open of [...stack].reverse()) problems.push({ at: open.at, message: `This ${open.ch} is never closed: a ${open.ch === "(" ? ")" : "]"} is missing.` });
    return { tokens, problems, open: stack };
}

// A JSON check that says where: { at, message } or null.
function jsonProblem(text) {
    let i = 0;
    const fail = (message, at = i) => { throw Object.assign(new Error(message), { at }); };
    const space = () => { while (" \t\n\r".includes(text[i]) && i < text.length) i++; };
    const value = () => {
        space();
        const c = text[i];
        if (c === "{") {
            i++; space();
            if (text[i] === "}") { i++; return; }
            for (;;) {
                space();
                if (text[i] !== '"') fail(text[i] === "}" ? "A comma before } is not allowed in JSON." : "Expected a key in double quotes.");
                string(); space();
                if (text[i] !== ":") fail("Expected : after the key.");
                i++; value(); space();
                if (text[i] === ",") { i++; continue; }
                if (text[i] === "}") { i++; return; }
                fail("Expected , or } after the value.");
            }
        }
        if (c === "[") {
            i++; space();
            if (text[i] === "]") { i++; return; }
            for (;;) {
                space();
                if (text[i] === "]") fail("A comma before ] is not allowed in JSON.");
                value(); space();
                if (text[i] === ",") { i++; continue; }
                if (text[i] === "]") { i++; return; }
                fail("Expected , or ] after the value.");
            }
        }
        if (c === '"') return string();
        const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
        if (!m) fail(c === undefined ? "The JSON ends too early." : c === "'" ? "Strings use double quotes in JSON." : `Unexpected ${JSON.stringify(c)}.`);
        i += m[0].length;
    };
    const string = () => {
        const start = i;
        i++;
        while (i < text.length && text[i] !== '"') {
            if (text[i] === "\n") fail("This string is never closed (\").", start);
            i += text[i] === "\\" ? 2 : 1;
        }
        if (text[i] !== '"') fail("This string is never closed (\").", start);
        i++;
    };
    try {
        value(); space();
        if (i < text.length) fail("Something follows the JSON value.");
        return null;
    } catch (error) {
        return { at: error.at ?? i, message: error.message };
    }
}

// findSyntaxError(source, mode) → null, or { line, col (or null), message }.
export function findSyntaxError(source, mode = "js") {
    if (mode === "sql") {
        const { problems } = tokenizeSql(source);
        const first = [...problems].sort((a, b) => Number(Boolean(b.sure)) - Number(Boolean(a.sure)) || a.at - b.at)[0];
        return first ? { ...lineCol(source, first.at), message: first.message } : null;
    }
    if (mode === "json") {
        if (!source.trim()) return null;
        const problem = jsonProblem(source);
        return problem && { ...lineCol(source, problem.at), message: problem.message };
    }
    // `export default` is the file's shape, not JavaScript a function body may hold: blanked, keeping
    // every line and column where it was.
    const prepared = source.replace(/\bexport\s+default\b/, (m) => m.replace(/[^\n]/g, " "));
    const { problems } = tokenize(prepared);
    if (problems.length) {
        // A bracket that closes the wrong thing, or a string never closed, says where; "never closed"
        // is only where it began, so it comes last.
        const sure = problems.filter((p) => p.sure || !/never closed: a/.test(p.message)).sort((a, b) => a.at - b.at);
        const first = sure[0] ?? problems[0];
        return { ...lineCol(prepared, first.at), message: first.message };
    }
    const parse = (text) => {
        try {
            // Parsed only: the function is built and never called.
            new Function(`"use strict";${text}`);
            return null;
        } catch (error) {
            // Not this page's to build (its policy): nothing to say here, the server says at save.
            return error?.name === "EvalError" ? null : error;
        }
    };
    const whole = parse(prepared);
    if (!whole) return null;
    const lines = prepared.split("\n");
    for (let k = lines.length - 1; k >= 1; k--) {
        const prefix = lines.slice(0, k).join("\n");
        const closers = tokenize(prefix).open.map((o) => CLOSER[o.ch]).reverse().join("\n");
        // An unfinished line (`if (a)`, `const x =`, `foo(a,`) is finished with a placeholder, so only
        // a line that can never be finished keeps its beginning from parsing.
        if (["\n$__;\n", "\n$__\n", "\n"].some((end) => !parse(prefix + end + closers))) return { line: k + 1, col: null, message: whole.message };
    }
    return { line: 1, col: null, message: whole.message };
}

// ---- what a script may call ----
// The sandbox a script runs in has JavaScript's own built-ins and nothing else (no fetch, require,
// console, timers or Math.random), and its context has what the contract gives it. A call to
// anything else fails when that line runs, which a dry run only sees if it runs that line; this
// sees every line, run or not.
const SANDBOX = new Set(("Object Array String Number Boolean Math JSON Date Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError " +
    "RegExp Map Set WeakMap WeakSet Promise Symbol BigInt Intl Reflect Proxy ArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array " +
    "Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent " +
    "encodeURI decodeURI globalThis").split(" "));
const CONTEXT = {
    service: { members: ["service", "input", "event", "now", "user", "output", "records", "http", "transactions"], calls: ["http"], records: ["get", "list", "create", "update", "action", "archive", "restore"], transactions: ["run"] },
    rule: { members: null, calls: ["lookup"], records: null }, // a rule's ctx carries what earlier scripts added
};

// callableProblems(source, kind, { suites }) → [{ line, col, message }]: calls to what the script will
// not have. `suites`: what the service's design lets it ask of the suites (its uses.suites, §30.11:
// { suite: [names] }), reached as ctx.<suite>.<name>().
export function callableProblems(source, kind = "service", { suites = null } = {}) {
    const given = Object.fromEntries(Object.entries(suites && typeof suites === "object" ? suites : {}).map(([suite, names]) => [suite.replace(/-/g, "_"), Array.isArray(names) ? names : []]));
    const { tokens } = tokenize(source);
    const code = tokens.filter((t) => t.type !== "space" && t.type !== "comment");
    const problems = [];
    const add = (token, message) => problems.push({ ...lineCol(source, token.start), message });
    // Names the script declares: anything it uses other than as a call (a const, a parameter), and
    // any function it declares.
    const declared = new Set();
    code.forEach((t, i) => {
        if (t.type === "ident") declared.add(t.text);
        if (t.type === "func" && code[i - 1]?.text === "function") declared.add(t.text);
    });
    // The context's name: the main function's first parameter (ctx, by the contract).
    const main = code.findIndex((t, i) => t.text === "function" && code[i + 1]?.type === "func");
    const ctxName = main >= 0 && code[main + 2]?.text === "(" && code[main + 3]?.type === "ident" ? code[main + 3].text : "ctx";
    const spec = CONTEXT[kind] ?? CONTEXT.service;
    const assigned = new Set();
    code.forEach((t, i) => { if (t.text === ctxName && code[i + 1]?.text === "." && code[i + 3]?.text === "=" ) assigned.add(code[i + 2]?.text); });
    code.forEach((t, i) => {
        if (t.type === "func" && code[i - 1]?.text !== "." && code[i - 1]?.text !== "?." && code[i - 1]?.text !== "function" && !declared.has(t.text) && !SANDBOX.has(t.text)) {
            add(t, `${t.text}() is not defined: a script has JavaScript's built-ins and its context, nothing else (no fetch, require, console or timers).`);
        }
        if (t.text === "Math" && code[i + 1]?.text === "." && code[i + 2]?.text === "random") add(code[i + 2], "Math.random does not exist: scripts are deterministic.");
        // A built-in's own functions (Object.assign, JSON.stringify, Promise.all): the name must be one.
        else if (SANDBOX.has(t.text) && code[i - 1]?.text !== "." && code[i + 1]?.text === "." && code[i + 3]?.text === "(") {
            const holder = globalThis[t.text];
            const member = code[i + 2]?.text;
            if (holder && member && !(member in holder)) add(code[i + 2], `${t.text}.${member} does not exist.`);
        }
        if (t.text !== ctxName || code[i + 1]?.text !== "." || code[i - 1]?.text === ".") return;
        const member = code[i + 2];
        if (!member || assigned.has(member.text)) return;
        if (Object.hasOwn(given, member.text)) {
            const asked = code[i + 3]?.text === "." ? code[i + 4] : null;
            if (asked && !given[member.text].includes(asked.text)) add(asked, `${ctxName}.${member.text}.${asked.text} is not what this service may ask of the ${member.text} suite (${given[member.text].join(", ") || "nothing"}): tick it under what the service may touch.`);
            return;
        }
        if (spec.members && !spec.members.includes(member.text)) {
            add(member, `${ctxName}.${member.text} is not in a ${kind}'s context (${spec.members.join(", ")}).`);
            return;
        }
        if (code[i + 3]?.text === "(" && !spec.calls.includes(member.text)) add(member, `${ctxName}.${member.text} is not callable; the context's calls are ${spec.calls.map((c) => `${ctxName}.${c}()`).join(", ")}${spec.records ? ` and ${ctxName}.records.${spec.records.join("/")}()` : ""}.`);
        if (member.text === "records" && spec.records && code[i + 3]?.text === "." && code[i + 4] && !spec.records.includes(code[i + 4].text)) add(code[i + 4], `${ctxName}.records.${code[i + 4].text} does not exist: it has ${spec.records.join(", ")}.`);
        if (member.text === "transactions" && spec.transactions && code[i + 3]?.text === "." && code[i + 4] && !spec.transactions.includes(code[i + 4].text)) add(code[i + 4], `${ctxName}.transactions.${code[i + 4].text} does not exist: it has ${spec.transactions.join(", ")} (a transaction its design lists under what it may touch).`);
    });
    return problems;
}

// ---- editing: indentation ----
function lineStartOf(text, at) { return text.lastIndexOf("\n", at - 1) + 1; }

// Replaces the selection with `text` so the browser's undo keeps it, then puts the caret `caret`
// characters into what was inserted (at its end unless given).
function insert(ta, text, caret) {
    const from = ta.selectionStart;
    ta.focus();
    const done = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
    if (!done) {
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (caret !== undefined) ta.setSelectionRange(from + caret, from + caret);
}

// Indents (or, with `out`, dedents) every line the selection touches, and keeps them selected.
function shiftLines(ta, out) {
    const v = ta.value;
    const from = lineStartOf(v, ta.selectionStart);
    const endAt = ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === "\n" ? ta.selectionEnd - 1 : ta.selectionEnd;
    const nl = v.indexOf("\n", endAt);
    const to = nl < 0 ? v.length : nl;
    const block = v.slice(from, to);
    const shifted = block.split("\n").map((line) => (out ? line.replace(/^( {1,2}|\t)/, "") : line.length ? INDENT + line : line)).join("\n");
    if (shifted === block) return;
    ta.setSelectionRange(from, to);
    insert(ta, shifted);
    ta.setSelectionRange(from, from + shifted.length);
}

function onKey(ta, e, state) {
    if (ta.readOnly || e.isComposing) return;
    const v = ta.value;
    const s = ta.selectionStart;
    const t = ta.selectionEnd;
    const lineStart = lineStartOf(v, s);
    const before = v.slice(lineStart, s);
    // Escape, then Tab, leaves the editor (the keyboard's way out); Tab otherwise indents.
    if (e.key === "Escape") { state.tabLeaves = true; return; }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (state.tabLeaves) { state.tabLeaves = false; return; }
        e.preventDefault();
        if (e.shiftKey || (s !== t && v.slice(s, t).includes("\n"))) shiftLines(ta, e.shiftKey);
        else insert(ta, INDENT);
        return;
    }
    state.tabLeaves = false;
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const indent = /^[ \t]*/.exec(before)[0];
        const last = before.trimEnd().at(-1);
        const opens = last in CLOSER;
        const after = /^[ \t]*(.)?/.exec(v.slice(t))[1];
        if (opens && after === CLOSER[last]) {
            // Between a pair: the closer goes on its own line, the caret on an indented one between.
            insert(ta, `\n${indent}${INDENT}\n${indent}`, 1 + indent.length + INDENT.length);
        } else {
            insert(ta, `\n${indent}${opens ? INDENT : ""}`);
        }
        return;
    }
    // A closer typed on a line of only indentation goes back one level.
    if (e.key in OPENER && s === t && before.length && /^[ \t]+$/.test(before)) {
        e.preventDefault();
        ta.setSelectionRange(lineStart, s);
        insert(ta, before.slice(0, Math.max(0, before.length - INDENT.length)) + e.key);
        return;
    }
    // Backspace in the indentation removes one level.
    if (e.key === "Backspace" && s === t && before.length && /^ +$/.test(before)) {
        e.preventDefault();
        const remove = ((before.length - 1) % INDENT.length) + 1;
        ta.setSelectionRange(s - remove, s);
        insert(ta, "");
    }
}

// ---- drawing ----
function paintTokens(pre, text, mode) {
    const frag = document.createDocumentFragment();
    for (const token of tokenize(text, mode).tokens) {
        if (token.type === "space" || token.type === "plain" || token.type === "ident") { frag.append(token.text); continue; }
        const span = document.createElement("span");
        span.className = `tk-${token.type}`;
        span.textContent = token.text;
        frag.append(span);
    }
    // A <pre> drops a last empty line; the textarea keeps it.
    if (text.endsWith("\n") || !text) frag.append(" ");
    pre.replaceChildren(frag);
}

let seq = 0;

export function registerCodeEditor(juris) {
    juris.registerComponent("CodeEditor", ({ value, onInput, readOnly = false, mode = "js", rows = 12, label = "Code", lint = null, runError = null, onSubmit = null }, api) => {
        const read = () => String((typeof value === "function" ? value() : value) ?? "");
        const locked = () => Boolean(typeof readOnly === "function" ? readOnly() : readOnly);
        // On the server, and until the page is live: the text as it is, uncoloured.
        if (api.isServer) return { pre: { className: "code-editor ce-static", textContent: read() } };
        const id = `ce-${++seq}`;
        api.onMount(() => {
            const root = document.getElementById(id);
            if (!root) return undefined;
            const gutter = document.createElement("div");
            gutter.className = "ce-gutter";
            gutter.setAttribute("aria-hidden", "true");
            const body = document.createElement("div");
            body.className = "ce-body";
            const pre = document.createElement("pre");
            pre.className = "ce-hl";
            pre.setAttribute("aria-hidden", "true");
            const band = document.createElement("div");
            band.className = "ce-band";
            const ta = document.createElement("textarea");
            ta.className = "ce-input";
            ta.spellcheck = false;
            ta.setAttribute("wrap", "off");
            ta.setAttribute("autocapitalize", "off");
            ta.setAttribute("autocomplete", "off");
            ta.setAttribute("aria-label", label);
            body.append(band, pre, ta);
            const frame = document.createElement("div");
            frame.className = "ce-frame";
            frame.append(gutter, body);
            const status = document.createElement("div");
            status.className = "ce-status";
            status.setAttribute("role", "status");
            root.replaceChildren(frame, status);

            const state = { tabLeaves: false, lines: 0, error: null, warnings: [] };
            // What to show, most serious first: a syntax error, a dry run's error on this very text,
            // then what the script will not be able to call.
            const shown = () => {
                if (state.error) return { ...state.error, kind: "error" };
                const run = typeof runError === "function" ? runError() : null;
                if (run && run.source === ta.value && run.line) return { line: run.line, col: run.column, message: `Dry run: ${run.message}`, kind: "error" };
                if (state.warnings.length) return { ...state.warnings[0], kind: "warn", more: state.warnings.length - 1 };
                return null;
            };
            let timer = null;
            const lineHeight = () => parseFloat(getComputedStyle(ta).lineHeight) || 18;
            const size = () => {
                ta.style.height = "0px";
                ta.style.width = "0px";
                const minHeight = rows * lineHeight() + 20;
                const height = Math.max(ta.scrollHeight, minHeight);
                const width = Math.max(ta.scrollWidth, body.clientWidth);
                ta.style.height = `${height}px`;
                ta.style.width = `${width}px`;
                pre.style.height = `${height}px`;
                pre.style.width = `${width}px`;
            };
            const drawGutter = (mark = shown()) => {
                const count = ta.value.split("\n").length;
                if (count !== state.lines) {
                    state.lines = count;
                    const frag = document.createDocumentFragment();
                    for (let n = 1; n <= count; n++) {
                        const div = document.createElement("div");
                        div.textContent = String(n);
                        frag.append(div);
                    }
                    gutter.replaceChildren(frag);
                }
                const warned = new Set(state.error ? [] : state.warnings.map((w) => w.line));
                for (const [i, div] of [...gutter.children].entries()) {
                    div.classList.toggle("ce-error-line", mark?.kind === "error" && mark.line === i + 1);
                    div.classList.toggle("ce-warn-line", mark?.kind !== "error" && warned.has(i + 1));
                }
            };
            const showError = () => {
                const mark = shown();
                root.classList.toggle("has-error", mark?.kind === "error");
                root.classList.toggle("has-warn", mark?.kind === "warn");
                band.classList.toggle("ce-band-warn", mark?.kind === "warn");
                status.classList.toggle("ce-status-warn", mark?.kind === "warn");
                if (!mark) {
                    band.hidden = true;
                    status.textContent = "";
                } else {
                    band.hidden = false;
                    band.style.top = `${10 + (mark.line - 1) * lineHeight()}px`;
                    band.style.height = `${lineHeight()}px`;
                    status.textContent = `Line ${mark.line}${mark.col ? `, column ${mark.col}` : ""}: ${mark.message}${mark.more ? ` (and ${mark.more} more)` : ""}`;
                }
                state.mark = mark;
                drawGutter(mark);
            };
            const check = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    state.error = findSyntaxError(ta.value, mode);
                    state.warnings = !state.error && typeof lint === "function" ? lint(ta.value) : [];
                    showError();
                }, 250);
            };
            const paint = () => {
                paintTokens(pre, ta.value, mode);
                size();
                drawGutter();
                check();
            };

            ta.value = read();
            ta.readOnly = locked();
            paint();
            ta.addEventListener("input", () => {
                onInput?.(ta.value);
                paint();
            });
            ta.addEventListener("keydown", (e) => {
                if (onSubmit && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); return; }
                onKey(ta, e, state);
            });
            // Clicking the gutter's number of the error line (or the status) goes to it.
            status.addEventListener("click", () => {
                const mark = state.mark;
                if (!mark) return;
                const lines = ta.value.split("\n");
                const at = lines.slice(0, mark.line - 1).reduce((n, line) => n + line.length + 1, 0) + Math.max(0, (mark.col ?? 1) - 1);
                ta.focus();
                ta.setSelectionRange(at, at);
            });
            const resize = new ResizeObserver(() => size());
            resize.observe(root);
            // What the page holds may change beside this editor (a save, the copilot's draft).
            const stopValue = api.bindState(read, () => {
                const next = read();
                if (next !== ta.value) { ta.value = next; paint(); }
            });
            const stopLock = api.bindState(locked, () => { ta.readOnly = locked(); root.classList.toggle("ce-readonly", ta.readOnly); });
            const stopRun = typeof runError === "function" ? api.bindState(() => runError(), () => showError()) : () => {};
            root.classList.toggle("ce-readonly", ta.readOnly);
            return () => {
                clearTimeout(timer);
                resize.disconnect();
                stopValue();
                stopLock();
                stopRun();
            };
        });
        return { div: { id, className: `code-editor ce-${mode}` } };
    });
}
