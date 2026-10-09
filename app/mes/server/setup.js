// Setup (DESIGN.md §5.15): while a plant is being set up, a designer's change executes on their own
// signature, without review or approval. IT opens it once, for a new installation, before its first start
// (`SETUP=1`); after that it is the organization's setting, ended or opened again by a change approved by
// governance like any other. Here: the opening at install, as the platform, audited.
import { appendAudit } from "./audit.js";
import { platformWrites, sealDesigns, ACCESS } from "./integrity.js";

// Why setup cannot be opened at install here (→ null when it can): it is for a new installation only. One
// whose organization has ever said either way, or where a change already went through review and approval,
// governs already: there it is opened again by a change governance approves (People & departments).
export async function setupRefusal(q) {
    const [said] = await q.query("SELECT version FROM mes.organization WHERE body ? 'setup' ORDER BY version LIMIT 1");
    if (said) return `the organization has said whether it is being set up already (version ${said.version}): open it again from People & departments, through a change governance approves`;
    const [executed] = await q.query("SELECT id, title FROM mes.change_requests WHERE state = 'executed' AND setup IS NULL LIMIT 1");
    if (executed) return `changes were already reviewed and approved here ("${executed.title}"): this installation governs; open setup from People & departments, through a change governance approves`;
    return null;
}

// Opens setup, as the platform, when IT asked for it (`SETUP=1`) and the installation is new. → { opened }
// or { refused: why } (said in the log and the event log; the server starts either way).
export async function openSetupAtInstall(db, { by = "platform:install", events = null, log = console } = {}) {
    const result = await db.transaction(async (tx) => {
        const [live] = await tx.query("SELECT version, body FROM mes.organization WHERE status = 'published' FOR UPDATE");
        if (live?.body?.setup?.open === true) return { opened: false, already: true };
        const why = await setupRefusal(tx);
        if (why) return { refused: why };
        await platformWrites(tx);
        const version = (live?.version ?? 0) + 1;
        if (live) await tx.query("UPDATE mes.organization SET status = 'superseded' WHERE status = 'published'");
        await tx.query("INSERT INTO mes.organization (version, status, body) VALUES ($1, 'published', $2)", [version, JSON.stringify({ ...(live?.body ?? {}), setup: { open: true } })]);
        await appendAudit(tx, { actor: by, object: "$organization", recordId: null, defVersion: version, action: "setup:opened", after: { version, how: "SETUP=1 at install: a designer's change executes on their signature until the organization ends it" } });
        await sealDesigns(tx, undefined, [ACCESS]);
        return { opened: true, version };
    });
    if (result.opened) {
        log.warn?.("setup: open (SETUP=1): a designer's change executes on their signature, without review or approval, until People & departments ends it");
        events?.emit?.("setup.opened", { severity: "warning", message: "Setup is open: a designer's change executes on their own signature, without review or approval, until People & departments ends it.", details: { version: result.version } });
    } else if (result.refused) {
        log.warn?.(`setup: SETUP=1 ignored: ${result.refused}`);
        events?.emit?.("setup.refused", { severity: "warning", message: `SETUP=1 was ignored: ${result.refused}.` });
    }
    return result;
}
