"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMockRouter } = require("./mock-router");
const { AsusHttpClient, USER_AGENT } = require("../lib/httpClient");

const client = (router, extra = {}) => new AsusHttpClient({
	host: "127.0.0.1", port: router.port, username: "admin", password: "password", timeout: 2000, ...extra
});

test("logs in once and reuses the token across polls", async () => {
	const router = await createMockRouter();
	try {
		const c = client(router);
		for (let i = 0; i < 3; i++) {
			const devices = await c.getDevices();
			assert.equal(devices.length, 8, "offline device filtered out");
		}
		assert.equal(router.state.logins, 1);
		assert.equal(router.state.appGets, 3);
		assert.ok(router.state.userAgents.every((ua) => ua === USER_AGENT));
		await c.close();
		assert.equal(router.state.logouts, 1);
	} finally {
		await router.close();
	}
});

test("normalizes fields from get_clientlist", async () => {
	const router = await createMockRouter();
	try {
		const devices = await client(router).getDevices();
		const by = Object.fromEntries(devices.map((d) => [d.mac, d]));
		const phone = by["AC:84:C6:11:22:33"];
		assert.equal(phone.name, "Sam's iPhone", "nickName wins over name");
		assert.equal(phone.connection, "5G");
		assert.equal(phone.rssi, -52);
		assert.equal(phone.connectedSeconds, (2 * 3600) + (13 * 60) + 45);
		assert.equal(phone.txRate, 866.7);
		assert.equal(phone.node, "04:D9:F5:AA:BB:CC");
		assert.equal(by["F0:18:98:44:55:66"].connection, "6G");
		assert.equal(by["F0:18:98:44:55:66"].name, "MacBook-Pro", "falls back to name");
		assert.equal(by["F0:18:98:44:55:66"].connectedSeconds, (26 * 3600) + 130, "hours past 24");
		const nas = by["00:11:32:AA:BB:CC"];
		assert.equal(nas.wireless, false);
		assert.equal(nas.rssi, null);
		assert.equal(nas.connectedSeconds, null);
		assert.equal(by["50:C7:BF:10:20:30"].connection, "2.4G");
		assert.equal(by["D8:3A:DD:12:34:56"].guest, 1);
		assert.equal(by["D8:3A:DD:12:34:56"].name, "Espressif (34:56)", "nameless device falls back to vendor + MAC tail");
		assert.equal(by["68:FF:7B:AB:CD:EF"].name, "Living room TV & soundbar", "HTML entities decoded");
		assert.equal(by["9C:B6:D0:01:01:01"], undefined);
	} finally {
		await router.close();
	}
});

test("includeOffline keeps devices the router marks offline", async () => {
	const router = await createMockRouter();
	try {
		const devices = await client(router, { includeOffline: true }).getDevices();
		assert.equal(devices.length, 9);
	} finally {
		await router.close();
	}
});

test("transparently logs in again when the router expires the session", async () => {
	const router = await createMockRouter();
	try {
		const c = client(router);
		await c.getDevices();
		router.expireTokens();
		const devices = await c.getDevices();
		assert.equal(devices.length, 8);
		assert.equal(router.state.logins, 2);
	} finally {
		await router.close();
	}
});

test("tolerates the router's sloppy JSON", async () => {
	const router = await createMockRouter({ sloppyJson: true });
	try {
		assert.equal((await client(router).getDevices()).length, 8);
	} finally {
		await router.close();
	}
});

test("wrong password -> AUTH_FAILED; repeated -> LOCKED with retryAfter", async () => {
	const router = await createMockRouter({ lockAfter: 2 });
	try {
		const c = client(router, { password: "nope" });
		await assert.rejects(c.getDevices(), { kind: "AUTH_FAILED" });
		await assert.rejects(c.getDevices(), { kind: "AUTH_FAILED" });
		await assert.rejects(c.getDevices(), (err) => err.kind === "LOCKED" && err.retryAfter === 45);
	} finally {
		await router.close();
	}
});

test("captcha demand is reported clearly", async () => {
	const router = await createMockRouter();
	router.state.captcha = true;
	try {
		await assert.rejects(client(router).getDevices(), (err) => err.kind === "CAPTCHA" && /ssh/.test(err.message));
	} finally {
		await router.close();
	}
});

test("credentials with characters that need URL-encoding in base64", async () => {
	// "admin:p?>~~" base64-encodes with '+' and '/' characters
	const pw = "p?>~~ünï";
	const router = await createMockRouter({ password: pw });
	try {
		assert.match(Buffer.from(`admin:${pw}`).toString("base64"), /[+/=]/);
		assert.equal((await client(router, { password: pw }).getDevices()).length, 8);
	} finally {
		await router.close();
	}
});

test("unreachable router -> UNREACHABLE", async () => {
	const router = await createMockRouter();
	const { port } = router;
	await router.close();
	await assert.rejects(new AsusHttpClient({ host: "127.0.0.1", port, username: "a", password: "b" }).getDevices(), { kind: "UNREACHABLE" });
});

test("slow router -> TIMEOUT", async () => {
	const router = await createMockRouter();
	router.state.delayMs = 1500;
	try {
		await assert.rejects(client(router, { timeout: 300 }).getDevices(), { kind: "TIMEOUT" });
	} finally {
		await router.close();
	}
});

test("missing credentials -> CONFIG", async () => {
	await assert.rejects(new AsusHttpClient({ host: "127.0.0.1", port: 1, username: "admin", password: "" }).getDevices(), { kind: "CONFIG" });
});

test("https with the router's self-signed certificate", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asusdev-tls-"));
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"),
		"-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=router.asus.com"], { stdio: "ignore" });
	const tls = { key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) };
	const router = await createMockRouter({ tls });
	try {
		const ok = client(router, { protocol: "https" });
		assert.equal((await ok.getDevices()).length, 8);
		const strict = client(router, { protocol: "https", rejectUnauthorized: true });
		await assert.rejects(strict.getDevices(), { kind: "TLS" });
		const wrongProto = client(router, { protocol: "http" });
		await assert.rejects(wrongProto.getDevices());
	} finally {
		await router.close();
	}
});
