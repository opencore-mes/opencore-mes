// The page a desktop opens at sign-in (DESIGN.md §6.8). A desktop is a record of the built-in Desktop
// object (client/builtins.js): its address, and the screen or the transaction it is for. Its records
// are the plant's (a form, the list, an Excel import); the platform reads them here, by the address a
// sign-in comes from, with its own rights (which page a desktop opens is not the person's to read or
// to be refused: what they may do on that page still is).
//
//   homeFor(user, address) → { path, desktop, label }, { desktop } or null
//
// null when the address is no desktop's; the desktop alone (for the sign-in's audit entry) when its
// page is not live or this person may not open it (its callers): they land on Home, as on any other
// computer. Nothing here knows what a work centre is: a desktop names a page, and the page is designed.
import { desktopAddress, desktopPath } from "../client/builtins.js";

export function createDesktops({ store }) {
    const { db } = store;
    // Who may open a screen or run a transaction: its callers, deny by default (screens.js, transactions.js).
    async function mayOpen(body, user) {
        const callers = body?.callers ?? {};
        if ((callers.users ?? []).includes(user.id)) return true;
        if (!(callers.groups ?? []).length) return false;
        const groups = await db.query("SELECT group_id FROM mes.group_members WHERE user_id = $1", [user.id]);
        return groups.some((g) => callers.groups.includes(g.group_id));
    }
    async function homeFor(user, address) {
        const at = desktopAddress(address);
        if (!at || !user) return null;
        // The built-in object only: a plant's own object that happens to be called "desktop" is not read.
        const def = await store.definition("desktop");
        if (!def?.body.builtIn) return null;
        // Compared as addresses are (a row typed " 10.20.3.41 " or ::ffff:10.20.3.41 is that desktop):
        // the few rows whose text could be it, then each read as an address. The newest wins. Rows spelled
        // as the rule keeps them come first: 10.0.0.1 is also in the text of 10.0.0.10 to 19 and 100 to 199,
        // and those, saved later, must not crowd it out of the few.
        const rows = await db.query(
            `SELECT id, data FROM mes.records WHERE object = 'desktop' AND archived_at IS NULL AND lower(data->>'address') LIKE '%' || $1 || '%'
              ORDER BY (btrim(lower(data->>'address')) IN ($1, '::ffff:' || $1)) DESC, updated_at DESC LIMIT 20`, [at]);
        const row = rows.find((r) => desktopAddress(r.data?.address) === at);
        if (!row) return null;
        const desktop = String(row.data.name ?? row.data.address);
        const path = desktopPath(row.data);
        if (!path) return { desktop };
        const page = row.data.opens === "screen" ? (await store.screens()).get(row.data.page) : (await store.transactions()).get(row.data.page);
        if (!page || !(await mayOpen(page.body, user))) return { desktop };
        return { path, desktop, label: page.body.label ?? row.data.page };
    }
    return { homeFor };
}
