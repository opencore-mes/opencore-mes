// The navigator shows by search (§10.1), end to end, as the server draws it:
//   1. Favorites are objects by name, and screens and transactions as screen:<name> and
//      transaction:<name>; anything else is refused in words.
//   2. With none, the navigator lists no object, screen or transaction, only a hint and "Show all";
//      the home page has no cards.
//   3. Starred, each shows at the top of the navigator and as a card on the home page (with its kind);
//      what is not starred still does not.
//   4. A favorite whose element is gone (retired, a suite removed) is kept, unshown, and breaks nothing.
//   5. A record found by search says where it stands: its state and tone, the first fields of its
//      object's list the person may read (a reference by its title), and whether what matched is
//      its title.
//
//   DATABASE_URL=postgres:///openmes_test node app/mes/test/navigator.mjs   (after a reset)
import pg from "pg";
import { randomBytes } from "node:crypto";
import { fromPg } from "@opencore-mes/juris-kit/server/db.js";
import { createApp } from "../app.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres:///openmes_poc" });
const db = fromPg(pool);
const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail }) });

const app = await createApp({ db, dev: false, build: "test", outboxEveryMs: 0, schedulerEveryMs: 0 });
const { url: mes } = await app.listen({ port: 0 });
const sid = `nv-${randomBytes(8).toString("hex")}`;
await db.query("INSERT INTO mes.sessions (id, user_id, expires_at) VALUES ($1, 'olga', now() + interval '1 hour')", [sid]);
const call = async (name, args) => {
    const res = await fetch(`${mes}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", cookie: `mes_session=${sid}` }, body: JSON.stringify([args]) });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
    return body;
};
const refused = async (favorites) => call("prefs.set", { favorites }).then(() => null, (e) => e.message);
// The home page as the server draws it: its navigator and its cards.
const home = async () => {
    const html = await (await fetch(`${mes}/`, { headers: { cookie: `mes_session=${sid}` } })).text();
    const between = (start, end) => { const i = html.indexOf(start); return i < 0 ? "" : html.slice(i, html.indexOf(end, i)); };
    const nav = between('<aside class="nav"', "</aside>");
    const cards = between('<div class="cards"', '</div></div>');
    const links = (part) => [...part.matchAll(/href="(\/[ost]\/[a-z0-9_]+)"/g)].map((m) => m[1]);
    return { nav, links: links(nav), cards: links(cards), kinds: [...cards.matchAll(/card-kind[^>]*>([^<]+)</g)].map((m) => m[1]) };
};

try {
    const [screen] = await db.query("SELECT name FROM mes.screens WHERE status = 'published' AND body->'callers'->'groups' ? 'production' ORDER BY name LIMIT 1");
    const [tx] = await db.query("SELECT name FROM mes.transactions WHERE status = 'published' ORDER BY name LIMIT 1");
    const mine = (await call("transactions.list", { as: "olga" })).map((t) => t.name);
    const txName = mine.includes(tx?.name) ? tx.name : mine[0];
    if (!screen || !txName) throw new Error("the seed has no screen or transaction for olga");

    // ---- 1. what a favorite is ----
    await call("prefs.set", { favorites: ["lot", `screen:${screen.name}`, `transaction:${txName}`] });
    const prefs = await call("prefs.get", { as: "olga" });
    step("an object, a screen and a transaction may be starred", JSON.stringify(prefs.favorites) === JSON.stringify(["lot", `screen:${screen.name}`, `transaction:${txName}`]), prefs.favorites);
    const words = await refused(["screen:"]);
    step("anything else is refused, in words", words?.includes("screen:<name>") && (await refused(["Lot"])) && (await refused(["report:x"])), words);

    // ---- 2. none starred ----
    await call("prefs.set", { favorites: [] });
    const bare = await home();
    step("none starred: the navigator lists no object, screen or transaction", bare.nav.length > 0 && bare.links.length === 0, bare.links);
    step("…it says to search and star, and offers the whole list", bare.nav.includes("star it to keep it here") && /Show all \d+/.test(bare.nav));
    step("…and the home page has no cards", bare.cards.length === 0, bare.cards);

    // ---- 3. starred ----
    await call("prefs.set", { favorites: [`screen:${screen.name}`, "lot", `transaction:${txName}`] });
    const starred = await home();
    step("starred: each at the top of the navigator, in the order starred", JSON.stringify(starred.links) === JSON.stringify([`/s/${screen.name}`, "/o/lot", `/t/${txName}`]), starred.links);
    step("…what is not starred is still not listed", !starred.links.includes("/o/work_order"), starred.links);
    step("…and each is a card on the home page, with its kind", JSON.stringify(starred.cards) === JSON.stringify([`/s/${screen.name}`, "/o/lot", `/t/${txName}`]) && starred.kinds.join() === "Screen,Object,Transaction", { cards: starred.cards, kinds: starred.kinds });

    // ---- 4. an element that is gone ----
    await call("prefs.set", { favorites: ["lot", "screen:gone_away", "no_such_object"] });
    const gone = await home();
    const kept = await call("prefs.get", { as: "olga" });
    step("a favorite whose element is gone is kept, and only what exists shows", kept.favorites.includes("screen:gone_away") && JSON.stringify(gone.links) === JSON.stringify(["/o/lot"]), { kept: kept.favorites, links: gone.links });

    // ---- 5. a record found: where it stands ----
    const [lotDef] = await db.query("SELECT body FROM mes.definitions WHERE object = 'lot' AND status = 'published'");
    const [lot] = await db.query("SELECT id, data->>'lot_no' AS no, state FROM mes.records WHERE object = 'lot' AND archived_at IS NULL ORDER BY data->>'lot_no' LIMIT 1");
    const hits = await call("records.search", { q: lot.no });
    const hit = hits.find((h) => h.id === lot.id);
    const seen = await call("records.get", { object: "lot", id: lot.id, as: "olga" });
    const want = lotDef.body.list.columns.filter((c) => c !== lotDef.body.titleField && seen[c] !== undefined && seen[c] !== null && seen[c] !== "").slice(0, 3)
        .map((c) => ({ label: lotDef.body.fields[c].label ?? c, value: lotDef.body.fields[c].type === "ref" ? seen.$titles?.[c] : seen[c] })).filter((d) => d.value !== null && d.value !== undefined);
    step("a lot found by its number: its state and its tone, the first fields of its list as Olga reads them (a reference by its title), the title as what matched",
        hit && hit.state === lot.state && hit.tone === (lotDef.body.states.tones?.[lot.state] ?? null) && hit.match?.title === true
        && JSON.stringify(hit.details.map((d) => ({ label: d.label, value: d.value }))) === JSON.stringify(want) && hit.details.every((d) => typeof d.type === "string"),
        { hit, want });
} catch (error) {
    step("the test ran to the end", false, { error: error.message, body: error.body });
} finally {
    await app.close();
    await pool.end();
}

const failed = steps.filter((s) => !s.ok);
for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `\n    ${JSON.stringify(s.detail)}`}`);
console.log(failed.length ? `\n${failed.length} of ${steps.length} steps failed` : `\nall ${steps.length} steps passed`);
process.exit(failed.length ? 1 : 0);
