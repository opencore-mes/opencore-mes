// Schedules (client/schedule.js): the checks, the next runs, daylight saving. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runsOf, instantOf, scheduleProblems, describeSchedule, nextRunOf } from "../client/schedule.js";
import { validateService, integrationFootprint } from "../client/definition.js";

const iso = (t) => new Date(t).toISOString();
const berlin = "Europe/Berlin";

test("every N minutes, in a window, on weekdays", () => {
    const t = { schedule: { every: { minutes: 15 }, between: ["06:00", "22:00"], days: ["mon", "tue", "wed", "thu", "fri"], tz: berlin } };
    // Friday 2026-10-02, 21:40 in Berlin (CEST, UTC+2): 21:45, then Monday 06:00.
    assert.deepEqual(runsOf(t, Date.UTC(2026, 9, 2, 19, 40), { limit: 3 }).map(iso), ["2026-10-02T19:45:00.000Z", "2026-10-05T04:00:00.000Z", "2026-10-05T04:15:00.000Z"]);
    assert.equal(describeSchedule(t), "every 15 min, 06:00–22:00, Mon Tue Wed Thu Fri (Europe/Berlin)");
});

test("times of day, a window across midnight, and `until`", () => {
    assert.deepEqual(runsOf({ schedule: { at: ["22:00", "06:00", "14:00"] } }, Date.UTC(2026, 8, 30, 12, 0), { limit: 4 }).map(iso),
        ["2026-09-30T14:00:00.000Z", "2026-09-30T22:00:00.000Z", "2026-10-01T06:00:00.000Z", "2026-10-01T14:00:00.000Z"]);
    const night = { schedule: { every: { hours: 2 }, between: ["22:00", "06:00"], tz: "UTC" } };
    assert.deepEqual(runsOf(night, Date.UTC(2026, 8, 30, 20, 0), { untilMs: Date.UTC(2026, 9, 1, 12, 0), limit: 100 }).map(iso),
        ["2026-09-30T22:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-10-01T02:00:00.000Z", "2026-10-01T04:00:00.000Z"]);
});

test("daylight saving: a skipped time runs once when it would have been; a repeated one runs once, the first time", () => {
    assert.equal(iso(instantOf(2027, 3, 28, 2, 30, berlin)), "2027-03-28T01:30:00.000Z", "02:30 does not exist: 03:30 CEST");
    assert.equal(iso(instantOf(2026, 10, 25, 2, 30, berlin)), "2026-10-25T00:30:00.000Z", "02:30 happens twice: the first");
    const hourly = { schedule: { every: { hours: 1 }, tz: berlin } };
    assert.deepEqual(runsOf(hourly, Date.UTC(2027, 2, 27, 23, 30), { limit: 3 }).map(iso), ["2027-03-28T00:00:00.000Z", "2027-03-28T01:00:00.000Z", "2027-03-28T02:00:00.000Z"], "01:00, 03:00 (for 02:00), 04:00: 03:00 once");
    assert.deepEqual(runsOf(hourly, Date.UTC(2026, 9, 24, 22, 30), { limit: 3 }).map(iso), ["2026-10-24T23:00:00.000Z", "2026-10-25T00:00:00.000Z", "2026-10-25T02:00:00.000Z"], "02:00 runs once, not twice");
});

test("the checks name what is wrong", () => {
    assert.deepEqual(scheduleProblems({ schedule: { every: { minutes: 15 } } }), []);
    assert.match(scheduleProblems({ schedule: {} })[0], /either every/);
    assert.match(scheduleProblems({ schedule: { every: { minutes: 0 } } })[0], /1–720/);
    assert.match(scheduleProblems({ schedule: { at: ["6:00"] } })[0], /HH:MM/);
    assert.match(scheduleProblems({ schedule: { every: { hours: 1 }, tz: "Mars/Base" } })[0], /not a time zone/);
    assert.match(scheduleProblems({ schedule: { every: { hours: 1 }, days: ["someday"] } })[0], /days are/);
    assert.match(scheduleProblems({ schedule: { at: ["06:00"], between: ["06:00", "07:00"] } })[0], /narrows/);
    assert.match(scheduleProblems({ schedule: { every: { hours: 12 }, between: ["01:00", "02:00"] } })[0], /never runs/);
    assert.match(scheduleProblems({ schedule: { every: { hours: 1 } }, missed: "maybe" })[0], /missed is/);
    assert.equal(nextRunOf([{ object: "lot", event: "create" }], 0, "UTC"), null);
});

test("a service with a schedule: validated, runOn checked, and no object stewards for the clock", () => {
    const known = { scripts: ["tick"], users: [], groups: [], objects: {}, connections: [], departments: ["production"] };
    const body = { name: "tick", label: "Tick", on: [{ schedule: { every: { minutes: 5 } } }], runAs: "service", roles: {}, uses: { objects: {}, connections: [] }, stewards: ["production"] };
    assert.deepEqual(validateService(body, known), []);
    assert.match(validateService({ ...body, on: [{ schedule: { every: { minutes: 0 } } }] }, known)[0].message, /Trigger 1 \(schedule\)/);
    assert.match(validateService({ ...body, runAs: "caller" }, known)[0].message, /schedule has no caller/);
    assert.match(validateService({ ...body, runOn: "ERP zone" }, known)[0].message, /node tag/);
    assert.deepEqual(validateService({ ...body, runOn: "erp-zone" }, known), []);
    const fp = integrationFootprint("service", "tick", body, { ...body, runOn: "erp" }, { objects: {} });
    assert.deepEqual(fp.map((f) => f.element), ["service:tick.runOn"]);
});

test("a schedule from a suite's kind (§30.11): its shape here, its times and its own check by the server", () => {
    const kinds = { "acme.shift_end": { label: "At every shift end", config: { calendar: "string", offset: "number" }, required: ["calendar"] } };
    const t = { schedule: { from: "acme.shift_end", calendar: "plant", tz: berlin }, missed: "last", overlap: "skip" };
    assert.deepEqual(scheduleProblems(t, { suiteSchedules: kinds }), []);
    assert.deepEqual(scheduleProblems(t), [], "without the kinds, only its shape: the server decides");
    assert.deepEqual(runsOf(t, 0, { limit: 3 }), [], "the browser cannot work its times out");
    assert.equal(nextRunOf([t], 0, "UTC"), null);
    assert.equal(describeSchedule(t, "UTC", kinds), "At every shift end (Europe/Berlin)");
    assert.equal(describeSchedule(t, "UTC", { "acme.shift_end": { ...kinds["acme.shift_end"], describe: (s) => `at every shift end (${s.calendar})` } }), "at every shift end (plant) (Europe/Berlin)");
    assert.match(describeSchedule(t, "UTC", {}), /needs the acme suite/);
    const words = (x) => scheduleProblems(x, { suiteSchedules: kinds }).join(" | ");
    assert.match(words({ schedule: { from: "acme.shift_end" } }), /"calendar" is needed/);
    assert.match(words({ schedule: { from: "acme.shift_end", calendar: "plant", every: { minutes: 5 } } }), /no every, at, between or days/);
    assert.match(words({ schedule: { from: "acme.shift_end", calendar: "plant", colour: "red" } }), /no setting "colour"/);
    assert.match(words({ schedule: { from: "acme.shift_end", calendar: "plant", offset: "ten" } }), /"offset" is a number/);
    assert.match(words({ schedule: { from: "nowhere.calendar" } }), /needs the nowhere suite, which is not installed here/);
    assert.match(words({ schedule: { from: "Shift End" } }), /<suite>\.<kind>/);
    const known = { scripts: ["tick"], users: [], groups: [], objects: {}, connections: [], departments: ["production"], suiteSchedules: kinds };
    const body = { name: "tick", label: "Tick", on: [t], runAs: "service", roles: {}, uses: { objects: {}, connections: [] }, stewards: ["production"] };
    assert.deepEqual(validateService(body, known), []);
    assert.match(validateService(body, { ...known, suiteSchedules: {} })[0].message, /Trigger 1 \(schedule\): "acme.shift_end" needs the acme suite/);
});
