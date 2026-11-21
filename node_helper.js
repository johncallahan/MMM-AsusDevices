/*
 * MMM-AsusDevices node helper.
 *
 * Runs on the MagicMirror server. One poller per module instance; every
 * browser showing that instance gets the same pushes, and a browser that
 * (re)connects immediately receives the latest snapshot.
 */

"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const { AsusHttpClient } = require("./lib/httpClient");
const { AsusSshClient } = require("./lib/sshClient");
const { DevicePoller } = require("./lib/poller");

/**
 * Stable key describing everything that affects how we poll.
 * @param {object} c module config
 * @returns {string} key
 */
function connectionKey (c) {
	return JSON.stringify([c.method, c.host, c.port, c.protocol, c.sshPort, c.username, c.password, c.privateKey,
		c.updateInterval, c.departureDelay, c.includeOffline, c.rejectUnauthorized, c.timeout, c.lanInterface]);
}

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.instances = new Map(); // identifier -> { key, poller }
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "ASUSDEV_START" || !payload?.identifier) return;
		const { identifier, config } = payload;
		const key = connectionKey(config);
		const existing = this.instances.get(identifier);

		if (existing && existing.key === key) {
			// Another browser (or a reload): replay the latest state.
			if (existing.poller.lastSnapshot) this.sendData(identifier, existing.poller.lastSnapshot);
			if (existing.poller.lastError) this.sendError(identifier, existing.poller.lastError);
			return;
		}
		if (existing) existing.poller.stop();

		let client;
		try {
			client = this.createClient(config);
		} catch (err) {
			this.sendError(identifier, { kind: err.kind || "CONFIG", message: err.message, at: Date.now(), retryIn: null });
			return;
		}

		const poller = new DevicePoller(client, {
			updateInterval: config.updateInterval,
			departureDelay: config.departureDelay,
			departedRetention: Math.max(config.showDeparted || 0, 60 * 1000)
		});
		poller.on("update", (snapshot) => this.sendData(identifier, snapshot));
		poller.on("error", (error) => {
			const retry = error.retryIn === null ? "polling stopped" : `retrying in ${Math.round(error.retryIn / 1000)}s`;
			Log.warn(`${config.host}: ${error.message} (${retry})`);
			this.sendError(identifier, error);
		});
		this.instances.set(identifier, { key, poller });
		Log.info(`polling ${config.host} via ${config.method} every ${Math.round(poller.updateInterval / 1000)}s`);
		poller.start();
	},

	createClient (config) {
		const common = {
			host: config.host,
			username: config.username,
			password: config.password,
			timeout: config.timeout
		};
		if (config.method === "ssh") {
			return new AsusSshClient({
				...common,
				sshPort: config.sshPort,
				privateKey: config.privateKey,
				passphrase: config.passphrase,
				lanInterface: config.lanInterface
			});
		}
		return new AsusHttpClient({
			...common,
			protocol: config.protocol,
			port: config.port,
			rejectUnauthorized: config.rejectUnauthorized,
			includeOffline: config.includeOffline
		});
	},

	sendData (identifier, snapshot) {
		this.sendSocketNotification("ASUSDEV_DATA", { identifier, serverTime: Date.now(), ...snapshot });
	},

	sendError (identifier, error) {
		this.sendSocketNotification("ASUSDEV_ERROR", { identifier, serverTime: Date.now(), error });
	},

	async stop () {
		await Promise.all([...this.instances.values()].map(({ poller }) => poller.stop()));
		this.instances.clear();
	}
});
