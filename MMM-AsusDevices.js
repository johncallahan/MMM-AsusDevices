/* global Module, Log, config */

/*
 * MMM-AsusDevices
 * Shows the devices connected to an Asuswrt / Asuswrt-Merlin router, live.
 * MIT licensed.
 */

Module.register("MMM-AsusDevices", {
	defaults: {
		// --- connection ---
		method: "http",            // "http" (router web API) or "ssh"
		host: "192.168.50.1",      // router address (router.asus.com also works)
		protocol: "http",          // "http" or "https" (web API only)
		port: null,                // default 80 for http, 8443 for https
		rejectUnauthorized: false, // verify the router's TLS cert (it is self-signed by default)
		username: "admin",
		password: "",              // tip: use "${SECRET_ASUS_PASSWORD}" + config/config.env
		sshPort: 22,
		privateKey: null,          // e.g. "~/.ssh/id_ed25519" (ssh only)
		passphrase: null,
		lanInterface: "br0",       // ssh only
		timeout: 10000,

		// --- polling ---
		updateInterval: 10 * 1000, // how often to ask the router (ms)
		departureDelay: 15 * 1000, // how long a device must be missing before it counts as gone (ms)
		includeOffline: false,     // also list devices the router remembers but marks offline

		// --- what to show ---
		columns: ["icon", "name", "ip", "band", "signal", "uptime"], // + "mac", "vendor", "rate", "node"
		sortBy: "name",            // "name" | "ip" | "connection" | "signal" | "uptime" | "recent"
		groupByConnection: false,  // split into Wired / Wi-Fi sections
		maxDevices: 25,            // 0 = no limit
		showWired: true,
		showWireless: true,
		showGuest: true,
		includeMacs: [],           // if non-empty, only show these MACs
		excludeMacs: [],           // never show these MACs
		deviceNames: {},           // { "AA:BB:CC:DD:EE:FF": "Kitchen tablet" }
		nodeNames: {},             // AiMesh node MAC -> label, for the "node" column
		maxNameLength: 22,
		showSummary: true,         // "18 online · 11 Wi-Fi · 7 wired"
		showSignalDbm: false,      // show "-54 dBm" next to the bars
		highlightNew: 5 * 60 * 1000, // highlight devices that joined in the last N ms (0 = off)
		showDeparted: 2 * 60 * 1000, // keep departed devices visible, faded, for N ms (0 = off)
		hideWhenEmpty: false,
		animationSpeed: 1000,
		broadcastNotifications: true // send ASUS_DEVICES / ASUS_DEVICE_JOINED / ASUS_DEVICE_LEFT
	},

	getStyles () {
		return ["font-awesome.css", this.file("MMM-AsusDevices.css")];
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		this.snapshot = null;
		this.error = null;
		this.clockOffset = 0;
		this.loaded = false;
		this.normalizedNames = {};
		for (const [mac, name] of Object.entries(this.config.deviceNames || {})) {
			this.normalizedNames[this.normMac(mac)] = name;
		}
		this.normalizedNodes = {};
		for (const [mac, name] of Object.entries(this.config.nodeNames || {})) {
			this.normalizedNodes[this.normMac(mac)] = name;
		}
		this.include = new Set((this.config.includeMacs || []).map((m) => this.normMac(m)));
		this.exclude = new Set((this.config.excludeMacs || []).map((m) => this.normMac(m)));

		this.sendSocketNotification("ASUSDEV_START", { identifier: this.identifier, config: this.config });

		// Re-render every 30s so "uptime" and "left 2m ago" keep moving between polls
		this.ticker = setInterval(() => {
			if (this.snapshot) this.updateDom(0);
		}, 30 * 1000);
	},

	suspend () {
		clearInterval(this.ticker);
		this.ticker = null;
	},

	resume () {
		if (!this.ticker) {
			this.ticker = setInterval(() => {
				if (this.snapshot) this.updateDom(0);
			}, 30 * 1000);
		}
		this.updateDom(0);
	},

	socketNotificationReceived (notification, payload) {
		if (!payload || payload.identifier !== this.identifier) return;

		if (notification === "ASUSDEV_DATA") {
			this.clockOffset = Date.now() - payload.serverTime;
			this.snapshot = payload;
			this.error = null;
			const firstLoad = !this.loaded;
			this.loaded = true;
			this.updateDom(firstLoad ? this.config.animationSpeed : 0);
			this.broadcast(payload);
		} else if (notification === "ASUSDEV_ERROR") {
			this.clockOffset = Date.now() - payload.serverTime;
			this.error = payload.error;
			this.loaded = true;
			this.updateDom(0);
		}
	},

	broadcast (payload) {
		if (!this.config.broadcastNotifications) return;
		const visible = payload.devices.map((d) => this.present(d));
		this.sendNotification("ASUS_DEVICES", { devices: visible, count: visible.length, updatedAt: payload.updatedAt });
		for (const mac of payload.joined || []) {
			const d = payload.devices.find((x) => x.mac === mac);
			if (d) this.sendNotification("ASUS_DEVICE_JOINED", this.present(d));
		}
		for (const mac of payload.left || []) {
			const d = payload.departed.find((x) => x.mac === mac);
			if (d) this.sendNotification("ASUS_DEVICE_LEFT", this.present(d));
		}
	},

	// ---------- helpers ----------

	/** value, or fallback when null/undefined (avoids ?? for older Electron builds) */
	orDefault (value, fallback) {
		return value === null || value === undefined ? fallback : value;
	},

	normMac (mac) {
		return String(mac || "").trim().toUpperCase().replace(/-/g, ":");
	},

	/** Server time -> browser time. */
	local (ts) {
		return ts + this.clockOffset;
	},

	present (d) {
		return {
			mac: d.mac,
			name: this.normalizedNames[d.mac] || d.name || d.mac,
			ip: d.ip,
			connection: d.connection,
			wireless: d.wireless,
			guest: d.guest,
			rssi: d.rssi
		};
	},

	displayName (d) {
		const name = this.normalizedNames[d.mac] || d.name || d.mac;
		const max = this.config.maxNameLength;
		return max && name.length > max ? `${name.slice(0, max - 1)}…` : name;
	},

	passesFilters (d) {
		if (this.include.size && !this.include.has(d.mac)) return false;
		if (this.exclude.has(d.mac)) return false;
		if (!this.config.showWired && !d.wireless) return false;
		if (!this.config.showWireless && d.wireless) return false;
		if (!this.config.showGuest && d.guest) return false;
		return true;
	},

	ipValue (ip) {
		if (!ip) return Number.MAX_SAFE_INTEGER;
		return ip.split(".").reduce((acc, p) => (acc * 256) + (Number(p) || 0), 0);
	},

	uptimeSeconds (d) {
		const now = Date.now();
		if (d.connectedSeconds !== null && d.connectedSeconds !== undefined) {
			// router value was true at snapshot time; age it locally
			return d.connectedSeconds + Math.max(0, (now - this.local(this.snapshot.updatedAt)) / 1000);
		}
		if (!d.presentAtStart) return (now - this.local(d.firstSeen)) / 1000;
		return null;
	},

	sortDevices (list) {
		const connOrder = { wired: 0, "2.4G": 1, "5G": 2, "5G-2": 3, "6G": 4, wireless: 5 };
		const byName = (a, b) => this.displayName(a).localeCompare(this.displayName(b), undefined, { sensitivity: "base", numeric: true });
		const cmp = {
			name: byName,
			ip: (a, b) => this.ipValue(a.ip) - this.ipValue(b.ip),
			connection: (a, b) => (connOrder[a.connection] - connOrder[b.connection]) || byName(a, b),
			signal: (a, b) => (this.orDefault(b.rssi, -999) - this.orDefault(a.rssi, -999)) || byName(a, b),
			uptime: (a, b) => (this.orDefault(this.uptimeSeconds(b), -1) - this.orDefault(this.uptimeSeconds(a), -1)) || byName(a, b),
			recent: (a, b) => (b.firstSeen - a.firstSeen) || byName(a, b)
		}[this.config.sortBy] || byName;
		return list.sort(cmp);
	},

	formatDuration (seconds) {
		if (seconds === null || seconds === undefined) return "";
		const s = Math.floor(seconds);
		if (s < 60) return "<1m";
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ${m % 60}m`;
		const d = Math.floor(h / 24);
		return `${d}d ${h % 24}h`;
	},

	signalBars (rssi) {
		if (rssi === null || rssi === undefined) return 0;
		if (rssi >= -55) return 4;
		if (rssi >= -65) return 3;
		if (rssi >= -75) return 2;
		return 1;
	},

	el (tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined && text !== null) node.textContent = text;
		return node;
	},

	// ---------- rendering ----------

	getDom () {
		const wrapper = this.el("div", "asusdev");

		if (!this.loaded) {
			wrapper.appendChild(this.el("div", "dimmed light small", "Connecting to router…"));
			return wrapper;
		}

		if (!this.snapshot) {
			wrapper.appendChild(this.renderError(true));
			return wrapper;
		}

		const now = Date.now();
		const devices = this.snapshot.devices.filter((d) => this.passesFilters(d));
		const departed = this.config.showDeparted
			? this.snapshot.departed.filter((d) => this.passesFilters(d) && now - this.local(d.leftAt) <= this.config.showDeparted)
			: [];

		if (!devices.length && !departed.length && this.config.hideWhenEmpty) return wrapper;

		if (this.config.showSummary) wrapper.appendChild(this.renderSummary(devices));
		if (this.error) wrapper.appendChild(this.renderError(false));

		const table = this.el("table", `asusdev-table small${this.error ? " stale" : ""}`);
		const sorted = this.sortDevices(devices.slice());
		let budget = this.config.maxDevices > 0 ? this.config.maxDevices : Infinity;
		let hidden = 0;

		const addRows = (list) => {
			for (const d of list) {
				if (budget <= 0) {
					hidden++;
					continue;
				}
				table.appendChild(this.renderRow(d, false));
				budget--;
			}
		};

		if (this.config.groupByConnection) {
			const wired = sorted.filter((d) => !d.wireless);
			const wifi = sorted.filter((d) => d.wireless);
			for (const [label, list] of [["Wi-Fi", wifi], ["Wired", wired]]) {
				if (!list.length) continue;
				if (budget > 0) {
					const row = this.el("tr", "asusdev-group");
					const cell = this.el("td", "xsmall dimmed", `${label} · ${list.length}`);
					cell.colSpan = this.config.columns.length;
					row.appendChild(cell);
					table.appendChild(row);
				}
				addRows(list);
			}
		} else {
			addRows(sorted);
		}

		departed.sort((a, b) => b.leftAt - a.leftAt);
		for (const d of departed) {
			if (budget <= 0) break;
			table.appendChild(this.renderRow(d, true));
			budget--;
		}

		if (!devices.length && !departed.length) {
			const row = this.el("tr");
			const cell = this.el("td", "dimmed", "No devices connected");
			cell.colSpan = this.config.columns.length;
			row.appendChild(cell);
			table.appendChild(row);
		}

		wrapper.appendChild(table);

		if (hidden > 0) {
			wrapper.appendChild(this.el("div", "asusdev-more xsmall dimmed", `+ ${hidden} more`));
		}
		return wrapper;
	},

	renderSummary (devices) {
		const wifi = devices.filter((d) => d.wireless).length;
		const wired = devices.length - wifi;
		const guest = devices.filter((d) => d.guest).length;
		const summary = this.el("div", "asusdev-summary small");
		const count = this.el("span", "bright asusdev-count", String(devices.length));
		summary.appendChild(count);
		summary.appendChild(this.el("span", "normal", devices.length === 1 ? " device online" : " devices online"));
		const parts = [];
		// the Wi-Fi / wired split only adds information when both kinds are shown
		if (this.config.showWireless && this.config.showWired) parts.push(`${wifi} Wi-Fi`, `${wired} wired`);
		if (guest && this.config.showGuest) parts.push(`${guest} guest`);
		if (parts.length) summary.appendChild(this.el("span", "dimmed", `  ·  ${parts.join("  ·  ")}`));
		return summary;
	},

	renderError (fatal) {
		const err = this.error || { message: "Unknown error" };
		const box = this.el("div", `asusdev-error xsmall${fatal ? "" : " dimmed"}`);
		const icon = this.el("i", "fas fa-exclamation-triangle");
		box.appendChild(icon);
		let text = ` ${err.message}`;
		if (!fatal && this.snapshot) {
			const t = new Date(this.local(this.snapshot.updatedAt));
			text += ` — showing data from ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: (typeof config !== "undefined" ? config.timeFormat : 24) !== 24 })}`;
		} else if (err.retryIn === null) {
			text += " — check the module config";
		}
		box.appendChild(document.createTextNode(text));
		return box;
	},

	renderRow (d, isDeparted) {
		const now = Date.now();
		const row = this.el("tr", "asusdev-row");
		if (isDeparted) row.classList.add("departed");
		if (!isDeparted && this.config.highlightNew && !d.presentAtStart && now - this.local(d.firstSeen) <= this.config.highlightNew) {
			row.classList.add("is-new");
			// one-shot pulse only on the render right after the device appears
			if (now - this.local(d.firstSeen) <= this.config.updateInterval * 1.5) row.classList.add("just-joined");
		}

		for (const col of this.config.columns) {
			row.appendChild(this.renderCell(col, d, isDeparted));
		}
		return row;
	},

	renderCell (col, d, isDeparted) {
		const td = this.el("td", `col-${col}`);
		switch (col) {
			case "icon": {
				let icon = "fa-ethernet";
				if (isDeparted) icon = "fa-sign-out-alt";
				else if (d.wireless) icon = "fa-wifi";
				td.appendChild(this.el("i", `fas ${icon}`));
				break;
			}
			case "name": {
				td.classList.add("bright");
				td.textContent = this.displayName(d);
				if (!isDeparted && d.guest) {
					td.appendChild(this.el("span", "asusdev-tag guest", "guest"));
				}
				if (!isDeparted && d.missing) td.classList.add("dimmed");
				break;
			}
			case "ip":
				td.classList.add("dimmed");
				td.textContent = d.ip || "";
				break;
			case "mac":
				td.classList.add("dimmed", "mono");
				td.textContent = d.mac;
				break;
			case "vendor":
				td.classList.add("dimmed");
				td.textContent = d.vendor || "";
				break;
			case "band":
				if (d.wireless) {
					const label = d.connection === "wireless" ? "Wi-Fi" : d.connection;
					td.appendChild(this.el("span", `asusdev-tag band band-${label.replace(/[^a-z0-9]/gi, "").toLowerCase()}`, label));
				} else {
					td.appendChild(this.el("span", "asusdev-tag band band-wired", "LAN"));
				}
				break;
			case "signal": {
				if (!d.wireless || isDeparted) break;
				const bars = this.signalBars(d.rssi);
				const meter = this.el("span", `asusdev-signal s${bars}`);
				for (let i = 1; i <= 4; i++) meter.appendChild(this.el("span", i <= bars ? "on" : ""));
				td.appendChild(meter);
				if (this.config.showSignalDbm && d.rssi !== null) {
					td.appendChild(this.el("span", "xsmall dimmed asusdev-dbm", `${d.rssi}`));
				}
				break;
			}
			case "rate":
				td.classList.add("dimmed", "xsmall");
				if (d.wireless && d.txRate) td.textContent = `${Math.round(d.txRate)} Mb/s`;
				break;
			case "node":
				td.classList.add("dimmed", "xsmall");
				td.textContent = d.node ? (this.normalizedNodes[d.node] || d.node.slice(-5)) : "";
				break;
			case "uptime":
				td.classList.add("dimmed");
				if (isDeparted) {
					td.textContent = `left ${this.formatDuration((Date.now() - this.local(d.leftAt)) / 1000)} ago`;
					td.classList.add("xsmall");
				} else {
					td.textContent = this.formatDuration(this.uptimeSeconds(d));
				}
				break;
			default:
				break;
		}
		return td;
	}
});
