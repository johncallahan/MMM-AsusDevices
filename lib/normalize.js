/*
 * Shared helpers that turn raw Asuswrt / Asuswrt-Merlin data into one
 * normalized device shape, no matter which transport (HTTP or SSH) fetched it.
 *
 * Normalized device:
 * {
 *   mac:        "AA:BB:CC:DD:EE:FF",
 *   name:       "Living Room TV",
 *   ip:         "192.168.50.23" | null,
 *   connection: "wired" | "2.4G" | "5G" | "5G-2" | "6G" | "wireless",
 *   wireless:   true | false,
 *   guest:      0 (main network) | 1..n (guest network index),
 *   rssi:       -54 | null,          // dBm, wireless only
 *   txRate:     866.7 | null,        // Mbps link rate
 *   rxRate:     780 | null,          // Mbps link rate
 *   connectedSeconds: 7322 | null,   // how long the router says it has been associated
 *   vendor:     "Apple" | null,
 *   node:       "AA:BB:..." | null   // AiMesh node the client is attached to
 * }
 */

"use strict";

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

/**
 * value, or fallback when null/undefined (written out so this runs on Node 8+)
 * @param {*} value value
 * @param {*} fallback fallback
 * @returns {*} result
 */
function orDefault (value, fallback) {
	return value === null || value === undefined ? fallback : value;
}

// isWL codes used by get_clientlist()
const ISWL_TO_CONNECTION = {
	0: "wired",
	1: "2.4G",
	2: "5G",
	3: "5G-2",
	4: "6G"
};

// Keys used by /tmp/clientlist.json (AiMesh "allclientlist")
const ALLCLIENT_KEY_TO_CONNECTION = {
	"2G": "2.4G",
	"5G": "5G",
	"5G1": "5G-2",
	"5G2": "5G-2",
	"6G": "6G"
};

// wlX_nband nvram values
const NBAND_TO_CONNECTION = {
	1: "5G",
	2: "2.4G",
	4: "6G"
};

/**
 * Normalize a MAC address to upper-case colon form, or return null.
 * @param {string} mac raw MAC address
 * @returns {string|null} normalized MAC or null
 */
function normalizeMac (mac) {
	if (typeof mac !== "string") return null;
	const cleaned = mac.trim().toUpperCase().replace(/-/g, ":");
	return MAC_RE.test(cleaned) ? cleaned : null;
}

/**
 * Parse a number, returning null when missing or not numeric.
 * @param {*} value raw value
 * @returns {number|null} number or null
 */
function toNumber (value) {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/**
 * Parse "HH:MM:SS" (hours may exceed 24) or a plain seconds value.
 * @param {string|number} value connection time
 * @returns {number|null} seconds
 */
function parseDuration (value) {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const str = String(value).trim();
	if (/^\d+$/.test(str)) return Number(str);
	const parts = str.split(":").map((p) => Number(p));
	if (parts.length < 2 || parts.some((p) => !Number.isFinite(p))) return null;
	let seconds = 0;
	for (const part of parts) seconds = (seconds * 60) + part;
	return seconds;
}

/**
 * Decode the handful of HTML entities the router uses in device names.
 * @param {string} str raw string
 * @returns {string} decoded string
 */
function decodeEntities (str) {
	if (typeof str !== "string") return "";
	return str
		.replace(/&#(\d+);?/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);?/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.trim();
}

/**
 * Lenient JSON parser: the router's httpd sometimes emits control characters,
 * doubled commas or keys without values. Mirrors what other Asuswrt clients do.
 * @param {string} text response body
 * @returns {object|null} parsed object or null if it is not JSON
 */
function parseRouterJson (text) {
	if (typeof text !== "string") return null;
	let content = text.replace(/^﻿/, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
	const trimmed = content.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	try {
		return JSON.parse(trimmed);
	} catch (e) {
		content = trimmed
			.replace(/\s*,\s*,/g, ", ")
			.replace(/^\s*{\s*,/, "{")
			.replace(/,\s*}\s*$/, "}")
			.replace(/:\s*(,|\})/g, ": null$1");
		try {
			return JSON.parse(content);
		} catch (e2) {
			return null;
		}
	}
}

/**
 * Build a normalized device object with defaults.
 * @param {object} fields partial device
 * @returns {object} device
 */
function makeDevice (fields) {
	const connection = fields.connection || "wired";
	return {
		mac: fields.mac,
		// nameless devices: "Espressif (34:56)" reads better than a bare MAC
		name: fields.name || (fields.vendor ? `${fields.vendor} (${fields.mac.slice(-5)})` : fields.mac),
		ip: fields.ip || null,
		connection,
		wireless: connection !== "wired",
		guest: fields.guest || 0,
		rssi: orDefault(fields.rssi, null),
		txRate: orDefault(fields.txRate, null),
		rxRate: orDefault(fields.rxRate, null),
		connectedSeconds: orDefault(fields.connectedSeconds, null),
		vendor: fields.vendor || null,
		node: fields.node || null
	};
}

/**
 * Normalize the object returned by appGet.cgi?hook=get_clientlist().
 * @param {object} json parsed response
 * @param {object} [options] options
 * @param {boolean} [options.includeOffline] keep devices the router marks offline
 * @returns {object[]} devices
 */
function fromClientList (json, options = {}) {
	if (!json || typeof json !== "object") return [];
	const list = json.get_clientlist && typeof json.get_clientlist === "object" ? json.get_clientlist : json;
	const macs = Array.isArray(list.maclist) && list.maclist.length
		? list.maclist
		: Object.keys(list).filter((key) => MAC_RE.test(key));

	const devices = [];
	const seen = new Set();
	for (const rawMac of macs) {
		const entry = list[rawMac] || list[String(rawMac).toUpperCase()];
		const mac = normalizeMac((entry && entry.mac) || rawMac);
		if (!entry || typeof entry !== "object" || !mac || seen.has(mac)) continue;

		const online = String(orDefault(entry.isOnline, "1")) === "1";
		if (!online && !options.includeOffline) continue;
		seen.add(mac);

		const isWL = orDefault(toNumber(entry.isWL), 0);
		const connection = ISWL_TO_CONNECTION[isWL] || "wireless";
		const wireless = connection !== "wired";
		const rssi = wireless ? toNumber(entry.rssi) : null;

		const device = makeDevice({
			mac,
			name: decodeEntities(entry.nickName) || decodeEntities(entry.name) || null,
			ip: entry.ip && entry.ip !== "0.0.0.0" ? entry.ip : null,
			connection,
			guest: toNumber(entry.isGN) || 0,
			rssi: rssi === 0 ? null : rssi,
			txRate: wireless ? toNumber(entry.curTx) : null,
			rxRate: wireless ? toNumber(entry.curRx) : null,
			connectedSeconds: wireless ? parseDuration(entry.wlConnectTime) : null,
			vendor: decodeEntities(entry.vendor) || null,
			node: normalizeMac(entry.amesh_papMac) || null
		});
		device.online = online;
		devices.push(device);
	}
	return devices;
}

/**
 * Parse nvram custom_clientlist: "<Name>MAC>0>type>>" repeated.
 * @param {string} raw nvram value
 * @returns {Map<string,string>} MAC -> name
 */
function parseCustomClientList (raw) {
	const names = new Map();
	if (typeof raw !== "string") return names;
	for (const record of raw.split("<")) {
		if (!record) continue;
		const [name, mac] = record.split(">");
		const nmac = normalizeMac(mac);
		if (nmac && name) names.set(nmac, decodeEntities(name));
	}
	return names;
}

/**
 * Split the output of the SSH probe script into its "##SECTION" blocks.
 * @param {string} output script stdout
 * @returns {object} section name -> array of lines
 */
function splitSections (output) {
	const sections = {};
	let current = null;
	for (const rawLine of String(output).split(/\r?\n/)) {
		const line = rawLine.replace(/\s+$/, "");
		const header = line.match(/^##([A-Z_]+)(?:\s+(.*))?$/);
		if (header) {
			current = header[1];
			if (!sections[current]) sections[current] = [];
			if (header[2] !== undefined) sections[current].push(`@${header[2]}`);
			continue;
		}
		if (current && line) sections[current].push(line);
	}
	return sections;
}

/**
 * Turn the SSH probe output into normalized devices.
 * Sources, in priority order:
 *   - CLJSON:  /tmp/clientlist.json (AiMesh-aware online client list)
 *   - WL:      `wl assoclist` + sta_info on the main router's radios
 *   - NEIGH:   `ip neigh` on the LAN bridge (wired + anything else with a live ARP entry)
 *   - ARP:     /proc/net/arp fallback when `ip` is unavailable
 * Names come from the custom client list (user-set names), then DHCP leases.
 * @param {string} output script stdout
 * @param {object} [options] options
 * @param {string} [options.lanInterface] LAN bridge (default br0)
 * @returns {object[]} devices
 */
function fromSshOutput (output, options = {}) {
	const lanIf = options.lanInterface || "br0";
	const s = splitSections(output);
	const byMac = new Map();
	const upsert = (mac, fields) => {
		const existing = byMac.get(mac) || { mac };
		for (const [key, value] of Object.entries(fields)) {
			if (value !== null && value !== undefined && value !== "" && (existing[key] === undefined || existing[key] === null)) {
				existing[key] = value;
			}
		}
		byMac.set(mac, existing);
	};

	// Band per radio unit: "@<unit> <nband>"
	const unitBand = {};
	for (const line of s.BAND || []) {
		const m = line.match(/^(\d+)\s+(\d+)/);
		if (m) unitBand[m[1]] = NBAND_TO_CONNECTION[m[2]] || null;
	}

	// DHCP leases: "<expiry> <mac> <ip> <hostname> <clientid>"
	const leases = new Map();
	for (const line of s.LEASES || []) {
		const [, mac, ip, host] = line.split(/\s+/);
		const nmac = normalizeMac(mac);
		if (nmac) leases.set(nmac, { ip, host: host && host !== "*" ? host : null });
	}

	const customNames = parseCustomClientList((s.NAMES || []).join(""));

	// AiMesh client list JSON. When present it is the router's own (networkmap)
	// view of who is online, so it decides membership; other sources only enrich it.
	const clJson = parseRouterJson((s.CLJSON || []).join("\n"));
	if (clJson && typeof clJson === "object") {
		for (const [node, conns] of Object.entries(clJson)) {
			if (!conns || typeof conns !== "object") continue;
			for (const [connKey, clients] of Object.entries(conns)) {
				if (!clients || typeof clients !== "object") continue;
				let connection = "wired";
				let guest = 0;
				if (connKey !== "wired_mac") {
					const [band, guestIdx] = connKey.split("_");
					connection = ALLCLIENT_KEY_TO_CONNECTION[band] || "wireless";
					guest = toNumber(guestIdx) || 0;
				}
				for (const [mac, info] of Object.entries(clients)) {
					const nmac = normalizeMac(mac);
					if (!nmac) continue;
					const rssi = toNumber(info && info.rssi);
					upsert(nmac, {
						connection,
						guest,
						ip: (info && info.ip) || null,
						rssi: connection === "wired" || rssi === 0 ? null : rssi,
						node: normalizeMac(node)
					});
				}
			}
		}
	}

	const authoritative = byMac.size > 0;

	// Wireless associations on this router: "<unit> <iface> <mac> <rssi> <secs> <txkbps> <rxkbps>"
	for (const line of s.WL || []) {
		const [unit, iface, mac, rssi, secs, tx, rx] = line.split(/\s+/);
		const nmac = normalizeMac(mac);
		if (!nmac) continue;
		const guestMatch = String(iface || "").match(/^wl\d+\.(\d+)$/);
		const txK = toNumber(tx);
		const rxK = toNumber(rx);
		const rssiN = toNumber(rssi);
		if (authoritative && !byMac.has(nmac)) continue;
		upsert(nmac, {
			connection: unitBand[unit] || ISWL_TO_CONNECTION[Number(unit) + 1] || "wireless",
			guest: guestMatch ? Number(guestMatch[1]) : 0,
			rssi: rssiN === 0 ? null : rssiN,
			connectedSeconds: toNumber(secs) || null,
			txRate: txK ? Math.round(txK / 100) / 10 : null,
			rxRate: rxK ? Math.round(rxK / 100) / 10 : null
		});
	}

	// Live neighbours on the LAN bridge. Without clientlist.json these are how wired
	// clients are found; with it they only fill in missing IP addresses.
	const addNeighbour = (mac, ip) => {
		if (authoritative && !byMac.has(mac)) return;
		upsert(mac, { ip });
	};
	const neighLines = s.NEIGH || [];
	if (neighLines.length) {
		for (const line of neighLines) {
			// "192.168.50.10 dev br0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
			const m = line.match(/^(\S+)\s+dev\s+(\S+)\s+lladdr\s+(\S+)\s+(?:\S+\s+)*?(REACHABLE|STALE|DELAY|PROBE|PERMANENT)\s*$/);
			if (!m || m[2] !== lanIf || m[1].includes(":")) continue;
			const nmac = normalizeMac(m[3]);
			if (nmac) addNeighbour(nmac, m[1]);
		}
	} else {
		for (const line of s.ARP || []) {
			// "IP address HW type Flags HW address Mask Device"
			const parts = line.split(/\s+/);
			if (parts.length < 6 || parts[0] === "IP") continue;
			const [ip, , flags, hw, , dev] = parts;
			const nmac = normalizeMac(hw);
			if (!nmac || dev !== lanIf || flags === "0x0" || nmac === "00:00:00:00:00:00") continue;
			addNeighbour(nmac, ip);
		}
	}

	const devices = [];
	for (const entry of byMac.values()) {
		const lease = leases.get(entry.mac);
		devices.push(makeDevice({
			...entry,
			connection: entry.connection || "wired",
			ip: entry.ip || (lease && lease.ip) || null,
			name: customNames.get(entry.mac) || (lease && lease.host) || null
		}));
	}
	return devices;
}

module.exports = {
	normalizeMac,
	parseDuration,
	parseRouterJson,
	decodeEntities,
	fromClientList,
	fromSshOutput,
	parseCustomClientList,
	splitSections
};
