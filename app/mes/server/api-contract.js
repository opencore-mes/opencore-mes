// The HTTP APIs' contract as the running core holds it (docs/contracts/http-apis, DESIGN.md §31.2,
// §31.5): the version every answer of /ai/v1 and /svc/v1 says it provides, and what is deprecated, with
// the headers each answer to it carries and a note of who still calls it.
//
//   const c = apiContract({ onDeprecatedUse });   c.version → "1.0"
//   c.headers(api, operation) → { "api-version", deprecation?, sunset?, link? }
//   c.used(api, operation, who)   the deprecated operation's use, noted once a day per caller
import { readFileSync } from "node:fs";
import { deprecationHeaders } from "../../../docs/contracts/http-apis/surface.mjs";

const SCHEMA = new URL("../../../docs/contracts/http-apis/schema.json", import.meta.url);
export const httpContract = () => JSON.parse(readFileSync(SCHEMA, "utf8"));

// `schema`: the contract (the published one by default; a test gives its own); `onDeprecatedUse(api,
// operation, who, notice)`: where a deprecated operation's use is noted (the event log).
export function apiContract({ schema = httpContract(), onDeprecatedUse = () => {}, now = () => Date.now() } = {}) {
    const version = schema["x-contract"]?.version ?? "1.0";
    const deprecated = schema["x-deprecated"] ?? {};
    const noted = new Map(); // "<api> <operation> <who>" → the day it was last noted
    return {
        version,
        notice: (api, operation) => (operation ? deprecated[api]?.[operation] ?? null : null),
        headers(api, operation, notice = operation ? deprecated[api]?.[operation] : null) {
            return { "api-version": version, ...deprecationHeaders(notice) };
        },
        used(api, operation, who, notice = deprecated[api]?.[operation]) {
            if (!notice) return;
            const day = new Date(now()).toISOString().slice(0, 10);
            const key = `${api} ${operation} ${who}`;
            if (noted.get(key) === day) return;
            noted.set(key, day);
            if (noted.size > 5000) noted.delete(noted.keys().next().value);
            try { onDeprecatedUse(api, operation, who, notice); } catch { /* a note's failure is not the caller's */ }
        },
    };
}
