// Reads the services share: published definitions, scripts, services and connections, users and their
// roles, sessions.
// Definitions and scripts change only when a change executes (DESIGN.md §5); the POC has no
// executor yet, so they are cached until the process restarts or `forget()` is called.

import { PSEUDO_ROLES, READ_ALL_ROLE } from "../client/definition.js";
import { createHash } from "node:crypto";

// A session as the database keeps it: the SHA-256 of the id the browser holds (migrate-auth-hardening.sql).
export const sessionKey = (id) => createHash("sha256").update(String(id), "utf8").digest("hex");

// `read` answers reads a replica may serve (routing.js); without one, the primary does.
export function createStore(db, { read = (sql, params) => db.query(sql, params) } = {}) {
    // What is published, kept until `forget()`. Each is kept as the read itself (its promise), and
    // forgetting drops the read: one that began before a change committed and ends after the forget
    // is no longer anyone's, so it can never put back what was published before (it used to: a sub
    // flow published a moment ago was then "not published", until the next forget).
    const definitions = new Map();   // object -> the read of { version, body } (or of null)
    const kept = {};                 // scripts | services | connections | transactions | screens | flows -> the read of its Map
    const keep = (key, load) => {
        if (!kept[key]) {
            const mine = load();
            kept[key] = mine;
            mine.catch(() => { if (kept[key] === mine) delete kept[key]; });
        }
        return kept[key];
    };
    const published = (table) => read(`SELECT name, version, body FROM mes.${table} WHERE status = 'published'`)
        .then((rows) => new Map(rows.map((row) => [row.name, { version: row.version, body: row.body }])));

    const store = {
        db,
        read,

        async definition(object) {
            if (typeof object !== "string") return null;
            if (!definitions.has(object)) {
                const mine = read("SELECT version, body FROM mes.definitions WHERE object = $1 AND status = 'published'", [object]).then(([row]) => (row ? { version: row.version, body: row.body } : null));
                definitions.set(object, mine);
                // One that is not there, or could not be read, is asked again next time.
                mine.then((found) => { if (!found && definitions.get(object) === mine) definitions.delete(object); }, () => { if (definitions.get(object) === mine) definitions.delete(object); });
            }
            return definitions.get(object);
        },

        async allDefinitions() {
            const rows = await read("SELECT object FROM mes.definitions WHERE status = 'published' ORDER BY object");
            return Promise.all(rows.map((row) => store.definition(row.object)));
        },

        // Every published definition's body by its object: what a derived field (§6.11) reads through is
        // worked out from them, at each write. Kept like the rest, forgotten when a change executes.
        bodies: () => keep("bodies", () => read("SELECT object, body FROM mes.definitions WHERE status = 'published'").then((rows) => new Map(rows.map((row) => [row.object, row.body])))),

        scripts: () => keep("scripts", () => read("SELECT name, version, source FROM mes.scripts WHERE status = 'published'").then((rows) => new Map(rows.map((row) => [row.name, { version: row.version, source: row.source }])))),

        // The published services and connections: injected by executing a change, read here on the
        // next call, with no restart (a published change forgets them on every instance).
        services: () => keep("services", () => published("services")),
        connections: () => keep("connections", () => published("connections")),
        // The published transactions (§25): read on the next call once a change publishes one.
        transactions: () => keep("transactions", () => published("transactions")),
        // The published screens (§26), likewise.
        screens: () => keep("screens", () => published("screens")),
        // The published flows (§32), likewise.
        flows: () => keep("flows", () => published("flows")),
        // The published report layouts (§34.5), likewise.
        layouts: () => keep("layouts", () => published("layouts")),
        // The published named queries (§23.1), likewise.
        queries: () => keep("queries", () => published("queries")),
        // The published design elements of the suites' kinds (§30.11), likewise.
        elements: () => keep("elements", () => published("elements")),

        // Services, their scripts and connections: what the trigger worker re-reads before each
        // batch, since an instance off the change bus hears of no execution elsewhere.
        forgetIntegration() {
            delete kept.services;
            delete kept.connections;
            delete kept.scripts;
        },
        // The scripts alone: a flow's node reads them again when one it names is not among them (§32).
        forgetScripts() {
            delete kept.scripts;
        },
        // The flows alone: a timer or a node that finds one missing reads them again (§32).
        forgetFlows() {
            delete kept.flows;
        },

        forget() {
            definitions.clear();
            for (const key of Object.keys(kept)) delete kept[key];
        },

        async user(id) {
            if (typeof id !== "string") return null;
            const [row] = await read("SELECT id, name FROM mes.users WHERE id = $1 AND active", [id]);
            return row ?? null;
        },

        // The person a session is, while it has not expired nor been idle longer than the plant allows
        // (§8.2: `sessionIdle`, minutes; 0 for none). Sessions are kept by the SHA-256 of their id.
        async userForSession(sessionId) {
            if (typeof sessionId !== "string" || !sessionId) return null;
            const [row] = await db.query(
                `SELECT u.id, u.name, s.home, s.home_label, s.created_at AS since, u2.id AS second_id, u2.name AS second_name
                 FROM mes.sessions s JOIN mes.users u ON u.id = s.user_id LEFT JOIN mes.users u2 ON u2.id = s.second_user_id AND u2.active
                 WHERE s.id = $1 AND s.expires_at > now() AND u.active AND ($2::int = 0 OR s.last_seen > now() - make_interval(mins => $2::int))`,
                [sessionKey(sessionId), store.sessionIdle ?? 0],
            );
            if (!row) return null;
            // The second person signed in beside them (§7.4), if any: who verifies what needs it.
            const { second_id, second_name, ...user } = row;
            return { ...user, second: second_id ? { id: second_id, name: second_name } : null };
        },

        // Something the person did (a page opened): the session's idle clock starts again, written at
        // most once a minute.
        async touchSession(sessionId) {
            if (typeof sessionId !== "string" || !sessionId) return;
            await db.query("UPDATE mes.sessions SET last_seen = now() WHERE id = $1 AND last_seen < now() - interval '1 minute'", [sessionKey(sessionId)]);
        },

        // The user's roles on one object: their own assignments and their groups'.
        // The certifications a person holds on `day` (§27.9): their certification records active, in use,
        // in date (valid from on or before it, until on or after it, either empty), of one People &
        // departments recognizes. → [ids], sorted.
        async certificationsOf(userId, day) {
            const rows = await read(
                `SELECT DISTINCT c.data->>'kind' AS kind
                   FROM mes.records c
                   JOIN mes.records p ON p.object = 'person' AND p.id::text = c.data->>'person' AND p.data->>'user' = $1
                   JOIN mes.organization o ON o.status = 'published' AND o.body->'certifications' ? (c.data->>'kind')
                  WHERE c.object = 'certification' AND c.state = 'active' AND c.archived_at IS NULL
                    AND coalesce(c.data->>'valid_from', '') <= $2
                    AND (coalesce(c.data->>'valid_until', '') = '' OR c.data->>'valid_until' >= $2)
                  ORDER BY 1`,
                [userId, day],
            );
            return rows.map((r) => r.kind);
        },

        async rolesFor(userId, object) {
            const rows = await read(
                `SELECT DISTINCT a.role FROM mes.assignments a
                 WHERE a.object = $2 AND ((a.subject_kind = 'user' AND a.subject_id = $1)
                    OR (a.subject_kind = 'group' AND a.subject_id IN (SELECT group_id FROM mes.group_members WHERE user_id = $1)))
                 ORDER BY a.role`,
                [userId, object],
            );
            const roles = rows.map((row) => row.role);
            // Who reads every record (§27.7): on a published object, never the designer or the query page.
            if (!PSEUDO_ROLES[object] && (await store.definition(object))) {
                const [reader] = await read(
                    `SELECT 1 FROM mes.organization o, jsonb_array_elements_text(coalesce(o.body->'readers', '[]'::jsonb)) r
                     WHERE o.status = 'published' AND (r = 'user:' || $1 OR r IN (SELECT 'group:' || group_id FROM mes.group_members WHERE user_id = $1)) LIMIT 1`,
                    [userId],
                );
                if (reader) roles.push(READ_ALL_ROLE);
            }
            return roles;
        },

        async departmentsOf(userId) {
            const rows = await read(
                `SELECT g.id FROM mes.groups g JOIN mes.group_members m ON m.group_id = g.id
                 WHERE m.user_id = $1 AND g.kind = 'department' ORDER BY g.id`,
                [userId],
            );
            return rows.map((row) => row.id);
        },
    };
    return store;
}
