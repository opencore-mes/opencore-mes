#!/bin/sh
# The script runner's operating-system walls on Linux (DESIGN §12.4), with bubblewrap: set
#   SCRIPT_RUNNER_WRAP=/path/to/opencore-mes/ops/script-runner-sandbox.sh
# and the server starts the runner through it (server/rules.js passes the node binary, its flags, the
# runner and its arguments). Node's permission model already keeps a script from the files, child
# processes and native code; this adds what only the kernel can promise:
#   - no network: a network namespace of its own, with loopback only (no route to the plant, the
#     database or the internet, whatever a script finds in Node);
#   - nothing to read but the app's code (app/mes) and the system's libraries, read-only; no home, no
#     /etc, no other repository files, no .env; an empty /tmp of its own;
#   - no capabilities, its own PID and IPC namespaces, a new session (no typing into the server's
#     terminal), and it dies with the server.
# The runner reports what it finds (MES_SCRIPT_SANDBOX, and whether it sees any network): the server
# logs it at start and /healthz shows it, so an installation is checked by what it is.
#
# Install: apt-get install bubblewrap (dnf install bubblewrap). Ubuntu 23.10 and later refuse
# unprivileged user namespaces to programs without an AppArmor profile that allows them
# (kernel.apparmor_restrict_unprivileged_userns=1: why `unshare -r -n` fails there with "write failed
# /proc/self/uid_map"), and Ubuntu 24.04 ships none for bwrap by default: load
# ops/script-runner-sandbox.apparmor (its first lines say how).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

node=$1
shift
here=$(cd "$(dirname "$0")" && pwd -P)
app=$(cd "$here/../app/mes" && pwd -P)
nodedir=$(dirname "$(dirname "$(readlink -f "$node")")") # e.g. /opt/node for /opt/node/bin/node

command -v bwrap >/dev/null 2>&1 || { echo "script-runner-sandbox: bwrap is not installed (apt-get install bubblewrap)" >&2; exit 127; }

# Merged /usr (Debian 12, Ubuntu 22.04 and later): /bin, /lib, /lib64 are links into /usr.
links=""
for d in bin sbin lib lib32 lib64 libx32; do
    if [ -L "/$d" ]; then links="$links --symlink $(readlink "/$d") /$d"
    elif [ -d "/$d" ]; then links="$links --ro-bind /$d /$d"
    fi
done
case "$nodedir" in /usr|/usr/*) nodebind="" ;; *) nodebind="--ro-bind $nodedir $nodedir" ;; esac

# The inherited environment is kept on purpose: the server starts the runner with nothing in it but
# Node's IPC channel (NODE_CHANNEL_FD), which bubblewrap passes through with the descriptor itself.
# shellcheck disable=SC2086 # $links and $nodebind are lists of words
exec bwrap \
    --unshare-all \
    --die-with-parent \
    --new-session \
    --cap-drop ALL \
    --ro-bind /usr /usr \
    $links \
    $nodebind \
    --ro-bind "$app" "$app" \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --chdir "$app" \
    --setenv MES_SCRIPT_SANDBOX bwrap \
    -- "$node" "$@"
