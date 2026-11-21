"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { fromSshOutput, splitSections, parseCustomClientList } = require("../lib/normalize");
const { AsusSshClient, PROBE_SCRIPT } = require("../lib/sshClient");

// ---- fake router userland: nvram, wl, ip ---------------------------------
function makeStubBin () {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asusdev-bin-"));
	const write = (name, body) => {
		fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	};
	write("nvram", `
case "$2" in
  wl0_ifname) echo eth6 ;;
  wl1_ifname) echo eth7 ;;
  wl2_ifname) echo eth8 ;;
  wl0_vifs) echo wl0.1 ;;
  wl0_nband) echo 2 ;;
  wl1_nband) echo 1 ;;
  wl2_nband) echo 4 ;;
  custom_clientlist) echo '<Sam&#39;s iPhone>AC:84:C6:11:22:33>0>10>><Kitchen plug>50:C7:BF:10:20:30>0>0>>' ;;
  *) echo "" ;;
esac`);
	write("wl", `
IF="$2"; CMD="$3"; MAC="$4"
case "$IF:$CMD" in
  eth6:assoclist) echo "assoclist 50:C7:BF:10:20:30" ;;
  wl0.1:assoclist) echo "assoclist D8:3A:DD:12:34:56" ;;
  eth7:assoclist) echo "assoclist AC:84:C6:11:22:33"; echo "assoclist 3C:22:FB:77:88:99" ;;
  eth8:assoclist) echo "assoclist F0:18:98:44:55:66" ;;
  *:rssi) case "$MAC" in AC:*) echo -52;; 50:*) echo -71;; D8:*) echo -79;; 3C:*) echo -63;; *) echo -47;; esac ;;
  *:sta_info) printf ' STA %s:\\n\\t aid:1\\n\\t idle 0 seconds\\n\\t in network 8025 seconds\\n\\t state: AUTHENTICATED ASSOCIATED AUTHORIZED\\n\\t rate of last tx pkt: 866667 kbps - 650000 kbps\\n\\t rate of last rx pkt: 780000 kbps\\n' "$MAC" ;;
esac`);
	write("ip", `
cat <<'EOF'
192.168.50.120 dev br0 lladdr ac:84:c6:11:22:33 REACHABLE
192.168.50.5 dev br0 lladdr 00:11:32:aa:bb:cc STALE
192.168.50.12 dev br0 lladdr b8:27:eb:01:02:03 router DELAY
192.168.50.66 dev br0  FAILED
100.64.0.1 dev eth0 lladdr 11:22:33:44:55:66 REACHABLE
fe80::1 dev br0 lladdr 00:11:32:aa:bb:cc STALE
EOF`);
	return dir;
}

function runScriptLocally (binDir) {
	return execFileSync("sh", ["-s"], { input: PROBE_SCRIPT, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } }).toString();
}

test("probe script runs under POSIX sh and produces parseable sections", () => {
	const bin = makeStubBin();
	const out = runScriptLocally(bin);
	const s = splitSections(out);
	for (const key of ["CLJSON", "LEASES", "NAMES", "NEIGH", "ARP", "BAND", "WL", "END"]) assert.ok(key in s, `section ${key}`);
	assert.deepEqual(s.BAND, ["0 2", "1 1", "2 4"]);
	assert.ok(s.WL.includes("1 eth7 AC:84:C6:11:22:33 -52 8025 866667 780000"), s.WL.join("\n"));
	assert.ok(s.WL.some((l) => l.startsWith("0 wl0.1 D8:3A:DD:12:34:56")));
});

test("without clientlist.json: radios + neighbour table", () => {
	const out = runScriptLocally(makeStubBin());
	const devices = fromSshOutput(out);
	const by = Object.fromEntries(devices.map((d) => [d.mac, d]));
	assert.equal(by["AC:84:C6:11:22:33"].connection, "5G");
	assert.equal(by["AC:84:C6:11:22:33"].name, "Sam's iPhone", "custom_clientlist name, entity-decoded");
	assert.equal(by["AC:84:C6:11:22:33"].ip, "192.168.50.120");
	assert.equal(by["AC:84:C6:11:22:33"].rssi, -52);
	assert.equal(by["AC:84:C6:11:22:33"].connectedSeconds, 8025);
	assert.equal(by["AC:84:C6:11:22:33"].txRate, 866.7);
	assert.equal(by["F0:18:98:44:55:66"].connection, "6G", "band from wl2_nband");
	assert.equal(by["50:C7:BF:10:20:30"].connection, "2.4G");
	assert.equal(by["D8:3A:DD:12:34:56"].guest, 1, "wl0.1 is a guest network");
	assert.equal(by["00:11:32:AA:BB:CC"].connection, "wired");
	assert.equal(by["00:11:32:AA:BB:CC"].ip, "192.168.50.5", "IPv6 neighbour ignored");
	assert.equal(by["B8:27:EB:01:02:03"].ip, "192.168.50.12", "'router' flag handled");
	assert.equal(by["11:22:33:44:55:66"], undefined, "WAN-side neighbour ignored");
	assert.equal(devices.length, 7);
});

test("with clientlist.json: AiMesh list is authoritative", () => {
	const cl = {
		"04:D9:F5:AA:BB:CC": {
			"2G": { "50:C7:BF:10:20:30": { ip: "192.168.50.140", rssi: "-70" } },
			"5G": { "AC:84:C6:11:22:33": { ip: "192.168.50.120", rssi: "-52" } },
			"2G_1": { "D8:3A:DD:12:34:56": { ip: "192.168.101.20", rssi: "-80" } },
			wired_mac: { "00:11:32:AA:BB:CC": { ip: "192.168.50.5" } }
		},
		"10:7B:44:01:02:03": {
			"5G1": { "3C:22:FB:77:88:99": { ip: "", rssi: "-60" } }
		}
	};
	const out = [
		"##CLJSON", JSON.stringify(cl),
		"##LEASES", "1700000000 3c:22:fb:77:88:99 192.168.50.133 Galaxy-Tab 01:3c:22:fb:77:88:99",
		"##NAMES",
		"##NEIGH",
		"192.168.50.12 dev br0 lladdr b8:27:eb:01:02:03 STALE",
		"192.168.50.133 dev br0 lladdr 3c:22:fb:77:88:99 REACHABLE",
		"##BAND", "0 2", "1 1",
		"##WL", "1 eth7 AC:84:C6:11:22:33 -51 300 866667 780000",
		"0 eth6 99:99:99:99:99:99 -60 10 0 0",
		"##END"
	].join("\n");
	const devices = fromSshOutput(out);
	const by = Object.fromEntries(devices.map((d) => [d.mac, d]));
	assert.equal(devices.length, 5, "stale neighbour + unlisted WL association are not added");
	assert.equal(by["3C:22:FB:77:88:99"].connection, "5G-2");
	assert.equal(by["3C:22:FB:77:88:99"].node, "10:7B:44:01:02:03");
	assert.equal(by["3C:22:FB:77:88:99"].ip, "192.168.50.133", "IP filled from neighbour table");
	assert.equal(by["3C:22:FB:77:88:99"].name, "Galaxy-Tab", "name from DHCP lease");
	assert.equal(by["D8:3A:DD:12:34:56"].guest, 1);
	assert.equal(by["AC:84:C6:11:22:33"].rssi, -52, "clientlist value wins");
	assert.equal(by["AC:84:C6:11:22:33"].connectedSeconds, 300, "enriched from wl sta_info");
	assert.equal(by["00:11:32:AA:BB:CC"].wireless, false);
});

test("falls back to /proc/net/arp when ip is unavailable", () => {
	const out = [
		"##NEIGH",
		"##ARP",
		"IP address       HW type     Flags       HW address            Mask     Device",
		"192.168.50.5     0x1         0x2         00:11:32:aa:bb:cc     *        br0",
		"192.168.50.66    0x1         0x0         00:00:00:00:00:00     *        br0",
		"100.64.0.1       0x1         0x2         11:22:33:44:55:66     *        eth0",
		"##END"
	].join("\n");
	const devices = fromSshOutput(out);
	assert.equal(devices.length, 1);
	assert.equal(devices[0].ip, "192.168.50.5");
});

test("busybox `ip neigh` output format (extra ref/used/probes fields)", () => {
	const out = [
		"##NEIGH",
		"192.168.50.77 dev br0 lladdr 00:aa:bb:cc:dd:ee ref 1 used 0/0/0 probes 1 REACHABLE",
		"192.168.50.78 dev br0 lladdr 00:aa:bb:cc:dd:ef used 12/12/9 probes 4 STALE",
		"192.168.50.79 dev br0 used 0/0/0 probes 6 FAILED",
		"##END"
	].join("\n");
	const devices = fromSshOutput(out);
	assert.deepEqual(devices.map((d) => d.ip).sort(), ["192.168.50.77", "192.168.50.78"]);
});

test("custom_clientlist parsing", () => {
	const names = parseCustomClientList("<TV>68:ff:7b:ab:cd:ef>0>0>><Bad>notamac>0>0>>");
	assert.equal(names.get("68:FF:7B:AB:CD:EF"), "TV");
	assert.equal(names.size, 1);
});

// ---- end-to-end through a real SSH server --------------------------------
let ssh2Available = true;
try {
	require.resolve("ssh2");
} catch {
	ssh2Available = false;
}

test("AsusSshClient end-to-end against an ssh2 test server", { skip: !ssh2Available && "ssh2 not installed (npm run install-ssh)" }, async () => {
	const { Server, utils } = require("ssh2");
	const bin = makeStubBin();
	const hostKey = utils.generateKeyPairSync("ed25519").private;
	const userKeys = utils.generateKeyPairSync("ed25519");
	const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "asusdev-key-")), "id_ed25519");
	fs.writeFileSync(keyFile, userKeys.private, { mode: 0o600 });
	const allowedPub = utils.parseKey(userKeys.public);

	const server = new Server({ hostKeys: [hostKey] }, (client) => {
		client.on("authentication", (ctx) => {
			if (ctx.method === "password" && ctx.username === "admin" && ctx.password === "pw") return ctx.accept();
			if (ctx.method === "publickey" && ctx.key.algo === allowedPub.type
				&& Buffer.compare(ctx.key.data, allowedPub.getPublicSSH()) === 0) {
				if (!ctx.signature) return ctx.accept();
				if (allowedPub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
			}
			ctx.reject();
		}).on("ready", () => {
			client.on("session", (accept) => {
				accept().on("exec", (acceptExec, _reject, info) => {
					const stream = acceptExec();
					const child = spawn("sh", ["-c", info.command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
					stream.pipe(child.stdin);
					child.stdout.pipe(stream, { end: false });
					child.stderr.pipe(stream.stderr);
					child.on("close", (code) => {
						stream.exit(code ?? 0);
						stream.end();
					});
				});
			});
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const sshPort = server.address().port;

	try {
		const pwClient = new AsusSshClient({ host: "127.0.0.1", sshPort, username: "admin", password: "pw", timeout: 5000 });
		const first = await pwClient.getDevices();
		const second = await pwClient.getDevices(); // reuses the connection
		assert.equal(first.length, 7);
		assert.equal(second.length, 7);
		await pwClient.close();

		const keyClient = new AsusSshClient({ host: "127.0.0.1", sshPort, username: "admin", privateKey: keyFile, timeout: 5000 });
		assert.equal((await keyClient.getDevices()).length, 7);
		await keyClient.close();

		const bad = new AsusSshClient({ host: "127.0.0.1", sshPort, username: "admin", password: "wrong", timeout: 5000 });
		await assert.rejects(bad.getDevices(), { kind: "AUTH_FAILED" });
	} finally {
		server.close();
	}
});
