#!/usr/bin/env node
/*
 * Check that the module can talk to your router, without starting MagicMirror.
 *
 *   node scripts/probe.js --host 192.168.50.1 --user admin
 *   ASUS_PASSWORD=secret node scripts/probe.js --host 192.168.50.1 --user admin --protocol https
 *   node scripts/probe.js --method ssh --host 192.168.50.1 --user admin --key ~/.ssh/id_ed25519
 *   node scripts/probe.js ... --raw     # also dump the router's raw JSON
 */

"use strict";

const { AsusHttpClient } = require("../lib/httpClient");
const { AsusSshClient } = require("../lib/sshClient");

function parseArgs (argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) args[key] = true;
		else {
			args[key] = next;
			i++;
		}
	}
	return args;
}

async function main () {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.host) {
		console.log("Usage: node scripts/probe.js --host <router> [--user admin] [--pass <pw> | env ASUS_PASSWORD]\n"
			+ "         [--method http|ssh] [--protocol http|https] [--port N] [--ssh-port N] [--key <file>] [--raw]");
		process.exit(args.help ? 0 : 1);
	}
	const options = {
		host: args.host,
		username: args.user || "admin",
		password: args.pass || process.env.ASUS_PASSWORD,
		timeout: Number(args.timeout) || 10000
	};
	const client = args.method === "ssh"
		? new AsusSshClient({ ...options, sshPort: args["ssh-port"], privateKey: args.key })
		: new AsusHttpClient({ ...options, protocol: args.protocol || "http", port: args.port });

	const started = Date.now();
	try {
		if (args.raw && client instanceof AsusHttpClient) {
			console.log(JSON.stringify(await client.appGet("get_clientlist()"), null, 2));
		} else if (args.raw) {
			console.log(await client.runProbe());
		}
		const devices = await client.getDevices();
		const rows = devices
			.sort((a, b) => (a.connection.localeCompare(b.connection)) || a.name.localeCompare(b.name))
			.map((d) => ({
				name: d.name,
				ip: d.ip || "",
				mac: d.mac,
				link: d.connection + (d.guest ? " (guest)" : ""),
				rssi: d.rssi === null || d.rssi === undefined ? "" : d.rssi,
				up: d.connectedSeconds !== null ? `${Math.round(d.connectedSeconds / 60)}m` : ""
			}));
		if (console.table) {
			console.table(rows);
		} else {
			// Node < 10 has no console.table
			for (const r of rows) console.log([r.name, r.ip, r.mac, r.link, r.rssi, r.up].join("\t"));
		}
		console.log(`${devices.length} devices in ${Date.now() - started} ms — the module will work with these settings.`);
	} catch (err) {
		console.error(`FAILED [${err.kind || err.code || "ERROR"}]: ${err.message}`);
		process.exitCode = 1;
	} finally {
		await client.close();
	}
}

main();
