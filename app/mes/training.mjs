// A training instance (TRAINING.md), beside development on the same machine: its own database, port,
// sign-in cookie and event log, so a course never touches the development data and trainees signing
// in never sign the developer out. It starts blank: people only, every model designed in the course.
//   npm run training:reset   recreate its database, blank (people, departments, their approval steps,
//                            roles on the designer and the query page; no objects, nothing else)
//   npm run training         start it: http://<this machine>:9091
//   npm run training -- --recover-designer <user> [--reviewer <user>] "<why>"   when nobody is left
//                            to change it (db/recover-designer.mjs): gives the roles back, audited
//   TRAINING_DATABASE_URL    default postgres:///openmes_training (never DATABASE_URL, which is the
//                            development one, so a training reset cannot wipe it)
//   TRAINING_PORT            default 9091
// Everything else is as for `npm run dev` (app/mes/server.mjs), .env included (the copilot, HOST).
import { fileURLToPath } from "node:url";

const url = process.env.TRAINING_DATABASE_URL ?? "postgres:///openmes_training";
if (url === (process.env.DATABASE_URL ?? "postgres:///openmes_poc")) {
    console.error(`TRAINING_DATABASE_URL is the development database (${url}): give the training instance its own.`);
    process.exit(1);
}
Object.assign(process.env, {
    DATABASE_URL: url,
    PORT: process.env.TRAINING_PORT ?? "9091",
    INSTANCE: "training",
    SESSION_COOKIE: "mes_training_session",
    EVENT_LOG_DIR: process.env.TRAINING_EVENT_LOG_DIR ?? fileURLToPath(new URL("../../.local/events-training", import.meta.url)),
});

const recover = process.argv.indexOf("--recover-designer");
if (recover >= 0) {
    process.argv = [process.argv[0], "recover-designer.mjs", ...process.argv.slice(recover + 1)];
    await import("./db/recover-designer.mjs");
} else if (process.argv.includes("--reset")) {
    process.argv.push("--blank");
    await import("./db/reset.mjs");
} else {
    await import("./server.mjs");
}
