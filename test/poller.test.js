"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DevicePoller } = require("../lib/poller");
const { RouterError } = require("../lib/errors");

const dev = (mac, extra = {}) => ({ mac, name: mac, connection: "wired", wireless: false, ...extra });

test("tracks joins and departures with a departure delay", () => {
	let now = 1_000_000;
	const p = new DevicePoller({ getDevices: async () => [] }, { departureDelay: 15000, now: () => now });

	let snap = p.ingest([dev("A"), dev("B")]);
	assert.deepEqual(snap.joined, [], "devices present at start are not 'joined'");
	assert.ok(snap.devices.every((d) => d.presentAtStart));

	now += 10000;
	snap = p.ingest([dev("A"), dev("C")]);
	assert.deepEqual(snap.joined, ["C"]);
	assert.deepEqual(snap.left, [], "B only missing 10s, still within the delay");
	assert.equal(snap.devices.find((d) => d.mac === "B").missing, true);
	assert.equal(snap.devices.find((d) => d.mac === "C").presentAtStart, false);

	now += 10000;
	snap = p.ingest([dev("A"), dev("C")]);
	assert.deepEqual(snap.left, ["B"]);
	assert.equal(snap.departed[0].mac, "B");
	assert.equal(snap.departed[0].leftAt, 1_000_000, "leftAt = last time it was seen");

	now += 10000;
	snap = p.ingest([dev("A"), dev("B"), dev("C")]);
	assert.deepEqual(snap.joined, ["B"], "returning device counts as joined");
	assert.equal(snap.departed.length, 0);
});

test("departed devices are forgotten after the retention window", () => {
	let now = 0;
	const p = new DevicePoller({ getDevices: async () => [] }, { departureDelay: 0, departedRetention: 60000, now: () => now });
	p.ingest([dev("A")]);
	now += 1000;
	assert.equal(p.ingest([]).departed.length, 1);
	now += 70000;
	assert.equal(p.ingest([]).departed.length, 0);
});

test("backoff policy protects the router from lockouts", () => {
	const p = new DevicePoller({ getDevices: async () => [] }, { updateInterval: 10000 });
	assert.equal(p.backoffFor(new RouterError("CONFIG", "x")), null);
	assert.equal(p.backoffFor(new RouterError("AUTH_FAILED", "x")), 5 * 60000);
	assert.equal(p.backoffFor(new RouterError("LOCKED", "x", { retryAfter: 300 })), 305000);
	assert.equal(p.backoffFor(new RouterError("CAPTCHA", "x")), 10 * 60000);
	p.consecutiveErrors = 1;
	assert.equal(p.backoffFor(new RouterError("UNREACHABLE", "x")), 10000);
	p.consecutiveErrors = 3;
	assert.equal(p.backoffFor(new RouterError("UNREACHABLE", "x")), 40000);
	p.consecutiveErrors = 20;
	assert.equal(p.backoffFor(new RouterError("TIMEOUT", "x")), 5 * 60000);
});

test("emits update/error events and stops on config errors", async () => {
	let calls = 0;
	const client = {
		getDevices: async () => {
			calls++;
			if (calls === 1) return [dev("A")];
			throw new RouterError("CONFIG", "bad config");
		},
		close: async () => {}
	};
	const p = new DevicePoller(client, { updateInterval: 2000 });
	const updates = [];
	const errors = [];
	p.on("update", (s) => updates.push(s));
	p.on("error", (e, last) => errors.push({ e, last }));
	await p.poll();
	await p.poll();
	assert.equal(updates.length, 1);
	assert.equal(errors.length, 1);
	assert.equal(errors[0].e.kind, "CONFIG");
	assert.equal(errors[0].e.retryIn, null);
	assert.ok(errors[0].last, "last good snapshot is passed along");
	assert.equal(p.running, false);
	await p.stop();
});
