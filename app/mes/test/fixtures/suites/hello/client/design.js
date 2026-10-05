// The hello suite's part of an object's design (§29.4), checked the same in the designer and at the
// server: { greeting: "words", script?: "a script that turns them into the greeting" }.
export function validate(body, part) {
    const out = [];
    if (part === null || typeof part !== "object" || Array.isArray(part)) return ["The hello part is { greeting, script }."];
    if (typeof part.greeting !== "string" || !part.greeting.trim()) out.push(`Hello on ${body.label}: say the greeting.`);
    if (part.script !== undefined && (typeof part.script !== "string" || !/^[a-z][a-z0-9_]*$/.test(part.script))) out.push("Hello: the script is named in lower case.");
    return out;
}
