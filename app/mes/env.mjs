// Settings from a file, in development: `--env <file>` after the script's name (`npm run dev`). Read
// here, by the server's first import, so every module that reads the environment as it loads sees
// them; what the environment already says wins, as with Node's own --env-file.
//
// Not Node's --env-file under --watch: Node then watches the file's whole folder, the repository's
// root, and with --watch-path every change anywhere in it restarts the server: the event log the
// server writes as it starts (.local/events), so it restarted itself without end.
import { existsSync } from "node:fs";

const at = process.argv.indexOf("--env");
const file = at > 1 ? process.argv[at + 1] : null;
if (file && existsSync(file)) process.loadEnvFile(file);
