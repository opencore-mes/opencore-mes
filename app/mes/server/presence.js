// Who else has a record open (DESIGN.md §10.1): a page says it is viewing (or editing) a record,
// every 15 s while it is open; `presence.get` is a live query answering the others. A page that
// goes away without saying so drops out 40 s after its last word, at the next re-run.
//
// Kept in an UNLOGGED table on the primary, so every instance sees the same people; a change to it
// crosses the bus like any other (its `touches`), so a page on another instance hears of it. An
// unlogged table is not replicated, so it is always read on the primary.
import { fail } from "../../../src/errors.js";
import { callKind } from "../../../src/live-protocol.js";

const STALE_S = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/;

export function createPresence({ store }) {
    const { db } = store;
    const check = (object, id) => {
        if (typeof object !== "string" || !IDENTIFIER.test(object) || typeof id !== "string" || !UUID.test(id)) fail("A bad record.");
    };
    async function viewer(self, as) {
        const kind = callKind(self);
        const user = kind === "preload" || kind === "live" ? await store.user(as) : kind === "direct" ? await store.userForSession(self?.sessionId) : null;
        if (!user) fail("Sign in first.", { status: 401 });
        return user;
    }

    const services = {
        async "presence.join"({ object, id, editing } = {}) {
            const user = await viewer(this);
            check(object, id);
            if (!(await store.rolesFor(user.id, object)).length) fail("Not found.", { status: 404 });
            await db.query(
                `INSERT INTO mes.presence (object, id, user_id, name, editing) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (object, id, user_id) DO UPDATE SET editing = EXCLUDED.editing, seen = now(),
                   since = CASE WHEN mes.presence.seen < now() - make_interval(secs => ${STALE_S}) THEN now() ELSE mes.presence.since END`,
                [object, id, user.id, user.name, Boolean(editing)],
            );
            await db.query(`DELETE FROM mes.presence WHERE object = $1 AND id = $2 AND seen < now() - make_interval(secs => ${STALE_S})`, [object, id]);
            return { ok: true };
        },
        async "presence.leave"({ object, id } = {}) {
            const user = await viewer(this);
            check(object, id);
            await db.query("DELETE FROM mes.presence WHERE object = $1 AND id = $2 AND user_id = $3", [object, id, user.id]);
            return { ok: true };
        },
        // The others with this record open: never the asker, never anyone gone quiet.
        async "presence.get"({ object, id, as } = {}) {
            const user = await viewer(this, as);
            check(object, id);
            if (!(await store.rolesFor(user.id, object)).length) return [];
            const rows = await db.query(
                `SELECT user_id, name, editing, since FROM mes.presence
                 WHERE object = $1 AND id = $2 AND user_id <> $3 AND seen > now() - make_interval(secs => ${STALE_S})
                 ORDER BY since`,
                [object, id, user.id],
            );
            return rows.map((r) => ({ id: r.user_id, name: r.name, editing: r.editing, since: new Date(r.since).toISOString() }));
        },
    };
    const here = ({ object, id } = {}) => [{ name: "presence.get", where: { object, id } }];
    return { services, touches: { "presence.join": here, "presence.leave": here }, queries: ["presence.get"] };
}
