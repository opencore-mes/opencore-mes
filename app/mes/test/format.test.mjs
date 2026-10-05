// How the plant writes dates, times and numbers (§27.6), without a server. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, parseDate, formatDateTime, formatTime, formatNumber, formatsProblems, formatsOf, dayOf, DEFAULT_FORMATS } from "../client/format.js";

const de = formatsOf({ locale: "de-DE", date: "DD.MM.YYYY", time: "24h", timeZone: "Europe/Berlin" });
const us = formatsOf({ locale: "en-US", date: "MM/DD/YYYY", time: "12h", timeZone: "America/Chicago" });

test("dates: written and typed the plant's way; stored as YYYY-MM-DD", () => {
    assert.equal(formatDate("2027-03-31", de), "31.03.2027");
    assert.equal(formatDate("2027-03-31", us), "03/31/2027");
    assert.equal(formatDate("2027-03-31", DEFAULT_FORMATS), "2027-03-31");
    assert.equal(formatDate(null, de), "");
    assert.equal(parseDate("31.3.2027", de), "2027-03-31");
    assert.equal(parseDate("3/31/27", us), "2027-03-31");
    assert.equal(parseDate("2027-03-31", us), "2027-03-31", "ISO is always understood");
    assert.equal(parseDate("31.02.2027", de), null, "not a real date");
    assert.equal(parseDate("03/31/2027", de), null, "the other way round is refused, not guessed");
    assert.equal(parseDate("", de), null);
});

test("moments: on the plant's clock, 24h or 12h", () => {
    const at = "2026-10-01T22:30:00Z"; // Berlin 00:30 next day; Chicago 17:30
    assert.equal(formatDateTime(at, de), "02.10.2026 00:30");
    assert.equal(formatDateTime(at, us), "10/01/2026 5:30 PM");
    assert.equal(formatTime(at, us, { seconds: true }), "5:30:00 PM");
    assert.equal(dayOf(at, de), "2026-10-02", "today, where the plant is");
    assert.equal(formatDateTime("not a date", de), "");
});

test("numbers as the locale writes them", () => {
    assert.equal(formatNumber(1250.5, de), "1.250,5");
    assert.equal(formatNumber(1250.5, us), "1,250.5");
    assert.equal(formatNumber(2 / 3, de, { max: 3 }), "0,667");
    // A stored value is shown whole: what an approver reads is what was entered.
    assert.equal(formatNumber(0.0004, us), "0.0004");
    assert.equal(formatNumber("0.00012", de), "0,00012");
    assert.equal(formatNumber(1.23456, us), "1.23456");
    assert.equal(formatNumber(1250, us), "1,250");
    assert.equal(formatNumber("9007199254740993", us), "9007199254740993");
    assert.equal(formatNumber(null, de), "");
});

test("a setting's mistakes named", () => {
    assert.deepEqual(formatsProblems({ locale: "de-DE", date: "DD.MM.YYYY", time: "24h", firstDay: 1, timeZone: "Europe/Berlin" }), []);
    const m = formatsProblems({ locale: "xx_YY!!", date: "D.M.Y", time: "25h", firstDay: 9, timeZone: "Mars/Olympus", colour: "red" }).join("\n");
    for (const expected of [/not a locale/, /dates are written/, /24h or 12h/, /first day/, /not a time zone/, /"colour"/]) assert.match(m, expected);
});
