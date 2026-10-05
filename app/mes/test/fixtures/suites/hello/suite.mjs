// A suite as small as the contract allows (DESIGN.md §29), for test/suites.mjs: a migration, a live
// query and a write named after it, a page with a navigator entry and a stylesheet, a part of an
// object's design (a greeting, and a script that shapes it) with its check and its designer tab, and a
// flow node kind (test/flows.mjs), what it gives a service's script, transaction steps, a screen block,
// a kind of design element and kinds of schedule (test/suite-extensions.mjs); and a design pack that adds a field to the built-in Person and
// locks it, for test/suites.mjs's extension and locks (builtins.js).
import { validate } from "./client/design.js";
export default {
    name: "hello",
    label: "Hello suite",
    version: "1.0.0",
    migrations: [{ name: "notes", file: new URL("./db/notes.sql", import.meta.url) }],
    client: "client/index.js",
    designs: {
        label: "Hello designs", version: "1.0.0", description: "A nickname on every Person, to greet them by.",
        prefix: "hello_",
        extends: { person: { fields: { hello_nickname: { label: "Nickname", type: "string" } }, form: { label: "Hello" } } },
        locks: { person: { fields: ["hello_nickname"], why: "Hello greets people by their nickname." } },
        // A sample on a record the pack does not make: found, and set (test/reset-suites.mjs).
        records: [{ object: "person", find: { user: "olga" }, set: { hello_nickname: "Ollie" } }],
    },
    register({ db, fail, records, appendAudit, store, scripts, elements }) {
        const viewer = (self, as) => records.internals.requireViewer(self, as);
        return {
            // A flow node kind of its own (§32.9): a station that greets, behaving as an operation.
            flowNodes: {
                "hello.station": {
                    label: "Greeting station", extends: "sequence", palette: "Hello",
                    config: { greeting: "string" }, required: ["greeting"],
                    validate: (settings) => (/^[A-Z]/.test(settings.greeting ?? "") ? [] : ["a greeting starts with a capital letter."]),
                },
            },
            services: {
                async "hello.notes"({ as } = {}) {
                    await viewer(this, as);
                    return db.query("SELECT id, text, by_user FROM mes.hello_notes ORDER BY id");
                },
                // An object's greeting, through the script its design names, as approved.
                async "hello.greet"({ object } = {}) {
                    await viewer(this);
                    const part = (await store.definition(object))?.body.suites?.hello;
                    if (!part) fail(`${object} has no greeting.`, { status: 404 });
                    return part.script ? (await scripts.run(part.script, { text: part.greeting })).text : part.greeting;
                },
                // The published greeting cards (its own kind of design element), as approved.
                async "hello.cards"({ as } = {}) {
                    await viewer(this, as);
                    return (await elements.published("hello.card")).map((e) => ({ name: e.name, version: e.version, to: e.body.to, message: e.body.message }));
                },
                async "hello.add"({ text } = {}) {
                    const user = await viewer(this);
                    if (typeof text !== "string" || !text.trim()) fail("Say something.", { fields: { text: "Required." } });
                    return db.transaction(async (tx) => {
                        const [note] = await tx.query("INSERT INTO mes.hello_notes (text, by_user) VALUES ($1, $2) RETURNING id, text, by_user", [text.trim(), user.id]);
                        await appendAudit(tx, { actor: user.id, object: "$hello", action: "hello:add", after: note });
                        return note;
                    });
                },
            },
            // What a service's script may ask of it (§30.11, test/suite-extensions.mjs): ctx.hello.wave,
            // which in a dry run answers without leaving a note; ctx.hello.count, a plain function.
            capabilities: {
                wave: {
                    async run({ to } = {}, { user, service }) {
                        if (typeof to !== "string" || !to.trim()) fail("Say whom to wave to.", { fields: { to: "Required." } });
                        const [note] = await db.query("INSERT INTO mes.hello_notes (text, by_user) VALUES ($1, $2) RETURNING id", [`${service} waved to ${to.trim()}`, user.id]);
                        return { waved: to.trim(), note: note.id };
                    },
                    dry: async ({ to } = {}) => ({ waved: String(to ?? "").trim(), note: null }),
                },
                count: async () => (await db.query("SELECT count(*)::int AS n FROM mes.hello_notes"))[0].n,
            },
            // Transaction step kinds (§30.11): a note left in the run's own database transaction (kept
            // only if the whole run is), and a bell that cannot be un-rung, so it comes last; where the
            // instance reaches nothing outside (a sandbox), it does not ring.
            steps: {
                "hello.note": {
                    label: "Leave a note", config: { text: "expression" }, required: ["text"],
                    validate: (step) => (typeof step.text === "string" && step.text.length > 80 ? ["a note written into the design is at most 80 characters."] : []),
                    plan: async ({ text }) => {
                        if (!String(text ?? "").trim()) fail("A note says something.");
                        return { text: String(text).trim() };
                    },
                    apply: async (tx, { text }, { user }) => ({ note: (await tx.query("INSERT INTO mes.hello_notes (text, by_user) VALUES ($1, $2) RETURNING id", [text, user.id]))[0].id }),
                },
                "hello.bell": {
                    label: "Ring the bell", irreversible: true, config: { times: "expression" }, required: [],
                    apply: async (tx, { times }, { outbound }) => {
                        if (Number(times) > 3) fail("The bell rings three times at most.");
                        return { rang: outbound ? Number(times ?? 1) : 0 };
                    },
                },
            },
            // A screen block kind (§30.11): the latest notes, read for whoever looks at the screen.
            blocks: {
                "hello.notes": {
                    label: "Hello notes", config: { limit: "number", greeting: "string" }, required: ["greeting"],
                    validate: (b) => (b.limit !== undefined && !(Number.isInteger(Number(b.limit)) && Number(b.limit) >= 1 && Number(b.limit) <= 20) ? ["limit is 1 to 20 notes."] : []),
                    data: async (b, { user }) => ({ greeting: `${b.greeting}, ${user.name}`, notes: await db.query("SELECT id, text FROM mes.hello_notes ORDER BY id DESC LIMIT $1", [Number(b.limit ?? 5)]) }),
                },
            },
            // A kind of design element of its own (§30.11): a greeting card, designed, reviewed, approved
            // and versioned like the platform's own elements; hello.cards reads the published ones.
            elements: {
                "hello.card": {
                    label: "Greeting card",
                    template: () => ({ to: "everyone", message: "Hello" }),
                    validate: (body) => [
                        ...(typeof body.to === "string" && body.to.trim() ? [] : ["say whom the card is to."]),
                        ...(typeof body.message === "string" && body.message.length <= 60 ? [] : ["its message is text, at most 60 characters."]),
                    ],
                },
            },
            // Kinds of schedule a service may run on (§30.11): times only the suite works out. Every so
            // many seconds, counted from the epoch (simple, and the same on every node); and one whose
            // times cannot be read, so the scheduler is seen to go on without it.
            schedules: {
                "hello.every_n_seconds": {
                    label: "Every so many seconds", config: { seconds: "number" }, required: ["seconds"],
                    validate: (settings) => (Number.isInteger(settings.seconds) && settings.seconds >= 5 && settings.seconds <= 3600 ? [] : ["seconds is a whole number, 5 to 3600."]),
                    runs: async ({ seconds }, afterMs, { untilMs, limit }) => {
                        const step = seconds * 1000;
                        const out = [];
                        for (let t = (Math.floor(afterMs / step) + 1) * step; t <= untilMs && out.length < limit; t += step) out.push(t);
                        return out;
                    },
                    describe: ({ seconds }) => `every ${seconds} s, counted from the epoch`,
                },
                "hello.broken": {
                    label: "A calendar that cannot be read", config: {}, required: [],
                    runs: async () => { throw new Error("the calendar cannot be read"); },
                },
            },
            // Alerts beside a person's name (§29): Dana has one, and one without a link (left out); Eli's fail
            // (the inbox goes on without them).
            inbox: async (user) => {
                if (user.id === "eli") throw new Error("the alerts cannot be read");
                return user.id === "dana" ? [{ id: "welcome", title: "Hello, Dana", what: "An alert from the hello suite", link: "/design" }, { id: "nowhere", title: "No link" }] : [];
            },
            touches: { "hello.notes": [], "hello.add": [{ name: "hello.notes" }], "hello.greet": [], "hello.cards": [] },
            designs: { object: { validate } },
            queries: ["hello.notes"],
        };
    },
};
