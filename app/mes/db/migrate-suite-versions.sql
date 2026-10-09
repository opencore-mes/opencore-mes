-- Every suite version an installation has run (§29.5): its name and version, what it gave designs (capabilities,
-- step, block, schedule, element and flow node kinds, a part of an object's design) and its design pack's version,
-- when it first and last ran. Never deleted: so the AI and the people who look after the installation know what an
-- earlier version gave, and which one to go back to when an update drops something a design needs (§29.10).
CREATE TABLE IF NOT EXISTS mes.suite_versions (
    name text NOT NULL,
    version text NOT NULL,
    label text NOT NULL,
    gives jsonb NOT NULL DEFAULT '{}',
    pack_version text,
    first_run timestamptz NOT NULL DEFAULT now(),
    last_run timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (name, version)
);
