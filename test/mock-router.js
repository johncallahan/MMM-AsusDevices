/*
 * A small stand-in for the Asuswrt httpd, good enough to exercise the module:
 * login.cgi / appGet.cgi / Logout.asp, asus_token cookies, error_status codes,
 * login lockout, token expiry (HTML redirect like the real router), and
 * optional device churn so you can watch the mirror update.
 *
 * Standalone:  node test/mock-router.js --port 8080 --churn
 *              (login admin / password)
 */

"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");

const SAMPLE_DEVICES = [
	{ mac: "AC:84:C6:11:22:33", name: "iPhone", nickName: "Sam's iPhone", ip: "192.168.50.120", vendor: "Apple", isWL: "2", rssi: "-52", curTx: "866.7", curRx: "780", wlConnectTime: "02:13:45" },
	{ mac: "F0:18:98:44:55:66", name: "MacBook-Pro", nickName: "", ip: "192.168.50.101", vendor: "Apple", isWL: "4", rssi: "-47", curTx: "1921.5", curRx: "1729.4", wlConnectTime: "26:02:10" },
	{ mac: "B8:27:EB:01:02:03", name: "magicmirror", nickName: "MagicMirror Pi", ip: "192.168.50.12", vendor: "Raspberry Pi", isWL: "0" },
	{ mac: "00:11:32:AA:BB:CC", name: "DS920", nickName: "Synology NAS", ip: "192.168.50.5", vendor: "Synology", isWL: "0" },
	{ mac: "50:C7:BF:10:20:30", name: "HS110", nickName: "Kitchen plug", ip: "192.168.50.140", vendor: "TP-Link", isWL: "1", rssi: "-71", curTx: "65", curRx: "72.2", wlConnectTime: "142:07:01" },
	{ mac: "3C:22:FB:77:88:99", name: "Galaxy-Tab", nickName: "", ip: "192.168.50.133", vendor: "Samsung", isWL: "2", rssi: "-63", curTx: "433.3", curRx: "390", wlConnectTime: "00:41:12" },
	{ mac: "D8:3A:DD:12:34:56", name: "", nickName: "", ip: "192.168.101.20", vendor: "Espressif", isWL: "1", isGN: "1", rssi: "-79", curTx: "24", curRx: "18", wlConnectTime: "05:00:00" },
	{ mac: "68:FF:7B:AB:CD:EF", name: "Living-Room-TV", nickName: "Living room TV &amp; soundbar", ip: "192.168.50.150", vendor: "LG", isWL: "0" },
	{ mac: "9C:B6:D0:01:01:01", name: "old-laptop", nickName: "", ip: "192.168.50.199", vendor: "Dell", isWL: "2", isOnline: "0", rssi: "0" }
];

const CHURN_POOL = [
	{ mac: "A4:83:E7:0A:0B:0C", name: "Pixel-8", nickName: "Guest phone", ip: "192.168.50.177", vendor: "Google", isWL: "2", rssi: "-58", curTx: "600", curRx: "520", wlConnectTime: "00:00:05" },
	{ mac: "E4:5F:01:DD:EE:FF", name: "PS5", nickName: "PlayStation 5", ip: "192.168.50.160", vendor: "Sony", isWL: "0" }
];

function clientEntry (d) {
	return {
		type: "0", defaultType: "0", name: d.name ?? "", nickName: d.nickName ?? "", ip: d.ip ?? "", mac: d.mac,
		from: "networkmapd", macRepeat: "0", isGateway: "0", isWebServer: "0", isPrinter: "0", isITunes: "0",
		dpiType: "", dpiDevice: "", vendor: d.vendor ?? "", isWL: d.isWL ?? "0", isGN: d.isGN ?? "",
		isOnline: d.isOnline ?? "1", ssid: "", isLogin: "0", opMode: "0", rssi: d.rssi ?? "", curTx: d.curTx ?? "",
		curRx: d.curRx ?? "", totalTx: "", totalRx: "", wlConnectTime: d.wlConnectTime ?? "", ipMethod: "DHCP",
		ROG: "0", group: "", callback: "", keeparp: "", qosLevel: "", wtfast: "0", internetMode: "allow",
		internetState: "1", amesh_isReClient: "1", amesh_papMac: d.node ?? "04:D9:F5:AA:BB:CC"
	};
}

/**
 * @param {object} [opts] options
 * @returns {Promise<object>} handle
 */
function createMockRouter (opts = {}) {
	const state = {
		username: opts.username || "admin",
		password: opts.password || "password",
		devices: (opts.devices || SAMPLE_DEVICES).map((d) => ({ ...d })),
		tokens: new Set(),
		logins: 0,
		failedLogins: 0,
		lockAfter: opts.lockAfter ?? 5,
		captcha: false,
		appGets: 0,
		userAgents: [],
		logouts: 0,
		delayMs: 0
	};

	const send = (res, status, body, headers = {}) => {
		res.writeHead(status, { "Content-Type": "text/html", ...headers });
		res.end(body);
	};

	const handler = (req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const go = () => {
				state.userAgents.push(req.headers["user-agent"]);
				const url = new URL(req.url, "http://router");
				const form = new URLSearchParams(body);
				const cookie = req.headers.cookie || "";
				const token = (cookie.match(/asus_token=([^;]+)/) || [])[1];

				if (url.pathname === "/login.cgi" && req.method === "POST") {
					if (state.captcha) return send(res, 200, JSON.stringify({ error_status: "10" }));
					if (state.failedLogins >= state.lockAfter) {
						return send(res, 200, JSON.stringify({ error_status: "7", remaining_lock_time: "45" }));
					}
					const auth = Buffer.from(form.get("login_authorization") || "", "base64").toString("utf8");
					if (auth !== `${state.username}:${state.password}`) {
						state.failedLogins++;
						return send(res, 200, JSON.stringify({ error_status: "3" }));
					}
					state.failedLogins = 0;
					state.logins++;
					const t = crypto.randomBytes(16).toString("hex");
					state.tokens.add(t);
					return send(res, 200, JSON.stringify({ asus_token: t }), {
						"Set-Cookie": `asus_token=${t}; HttpOnly;`,
						"Content-Type": "application/json"
					});
				}

				if (url.pathname === "/appGet.cgi") {
					if (!token || !state.tokens.has(token)) {
						// real routers answer 200 with a JS redirect to the login page
						return send(res, 200, "<HTML><HEAD><script>top.location.href='/Main_Login.asp';</script>\n</HEAD></HTML>");
					}
					state.appGets++;
					const hook = form.get("hook") || url.searchParams.get("hook") || "";
					if (hook.includes("get_clientlist()")) {
						const list = { maclist: state.devices.map((d) => d.mac), ClientAPILevel: "2" };
						for (const d of state.devices) list[d.mac] = clientEntry(d);
						// emulate the router's sloppy JSON once in a while: trailing comma
						const json = JSON.stringify({ get_clientlist: list });
						return send(res, 200, opts.sloppyJson ? json.replace(/}}$/, "},}") : json, { "Content-Type": "application/json" });
					}
					return send(res, 200, "{}", { "Content-Type": "application/json" });
				}

				if (url.pathname === "/Logout.asp") {
					if (token) state.tokens.delete(token);
					state.logouts++;
					return send(res, 200, "<html>logged out</html>");
				}

				return send(res, 404, "not found");
			};
			if (state.delayMs) setTimeout(go, state.delayMs);
			else go();
		});
	};

	const server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);
	return new Promise((resolve) => {
		server.listen(opts.port || 0, "127.0.0.1", () => {
			resolve({
				state,
				port: server.address().port,
				expireTokens: () => state.tokens.clear(),
				close: () => new Promise((r) => {
					server.closeAllConnections?.();
					server.close(() => r());
				})
			});
		});
	});
}

module.exports = { createMockRouter, SAMPLE_DEVICES, CHURN_POOL };

if (require.main === module) {
	const args = process.argv.slice(2);
	const port = Number(args[args.indexOf("--port") + 1]) || 8080;
	const churn = args.includes("--churn");
	const every = Number(args[args.indexOf("--every") + 1]) || 20;
	createMockRouter({ port }).then((router) => {
		console.log(`mock router on http://127.0.0.1:${router.port} (admin / password)${churn ? ", churning devices" : ""}`);
		if (!churn) return;
		let i = 0;
		setInterval(() => {
			const candidate = CHURN_POOL[i % CHURN_POOL.length];
			const idx = router.state.devices.findIndex((d) => d.mac === candidate.mac);
			if (idx >= 0) {
				router.state.devices.splice(idx, 1);
				console.log(`- ${candidate.nickName} left`);
			} else {
				router.state.devices.push({ ...candidate });
				console.log(`+ ${candidate.nickName} joined`);
			}
			// wiggle signal strength a little
			for (const d of router.state.devices) {
				if (d.rssi && d.rssi !== "0") d.rssi = String(Math.max(-88, Math.min(-40, Number(d.rssi) + Math.round((Math.random() - 0.5) * 6))));
			}
			i++;
		}, every * 1000);
	});
}
