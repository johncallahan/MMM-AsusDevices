/*
 * Polls a router client on an interval, keeps track of when each device was
 * first/last seen, works out who joined and who left, and backs off politely
 * when the router complains (so a typo in the password does not get the
 * router to lock you out).
 */

"use strict";

const { EventEmitter } = require("events");

const orDefault = (value, fallback) => (value === null || value === undefined ? fallback : value);

const MINUTE = 60 * 1000;

class DevicePoller extends EventEmitter {
	/**
	 * @param {{getDevices: Function, close: Function}} client transport
	 * @param {object} [options] options
	 * @param {number} [options.updateInterval] ms between polls
	 * @param {number} [options.departureDelay] ms a device must be missing before it counts as gone
	 * @param {number} [options.departedRetention] ms to remember departed devices
	 * @param {Function} [options.now] clock (for tests)
	 */
	constructor (client, options = {}) {
		super();
		this.client = client;
		this.updateInterval = Math.max(2000, Number(options.updateInterval) || 10000);
		this.departureDelay = Math.max(0, Number(orDefault(options.departureDelay, 15000)));
		this.departedRetention = Math.max(0, Number(orDefault(options.departedRetention, 10 * MINUTE)));
		this.now = options.now || Date.now;

		this.known = new Map();     // mac -> device (+ firstSeen, lastSeen, presentAtStart)
		this.departed = new Map();  // mac -> device (+ leftAt)
		this.initialized = false;
		this.lastSnapshot = null;
		this.lastError = null;
		this.consecutiveErrors = 0;
		this.timer = null;
		this.running = false;
		this.inFlight = null;
	}

	start () {
		if (this.running) return;
		this.running = true;
		this.schedule(0);
	}

	async stop () {
		this.running = false;
		clearTimeout(this.timer);
		this.timer = null;
		try {
			await this.inFlight;
		} catch (e) {
			// ignore
		}
		if (this.client.close) await this.client.close();
	}

	schedule (delay) {
		if (!this.running) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			const clear = () => {
				this.inFlight = null;
			};
			this.inFlight = this.poll().then(clear, clear);
		}, delay);
	}

	/**
	 * How long to wait after an error before trying again.
	 * @param {object} err RouterError
	 * @returns {number|null} delay in ms, or null to stop polling
	 */
	backoffFor (err) {
		switch (err.kind) {
			case "CONFIG":
				return null;
			case "AUTH_FAILED":
			case "RESET_REQUIRED":
				return 5 * MINUTE;
			case "LOCKED":
				return Math.max((err.retryAfter || 0) * 1000 + 5000, MINUTE);
			case "CAPTCHA":
				return 10 * MINUTE;
			case "ANOTHER_SESSION":
				return MINUTE;
			default: {
				// network-ish problems: exponential, capped at 5 minutes
				const factor = 2 ** Math.min(this.consecutiveErrors - 1, 5);
				return Math.min(this.updateInterval * factor, 5 * MINUTE);
			}
		}
	}

	async poll () {
		let devices;
		try {
			devices = await this.client.getDevices();
		} catch (err) {
			this.consecutiveErrors += 1;
			const retryIn = this.backoffFor(err);
			this.lastError = {
				kind: err.kind || "ERROR",
				message: err.message || String(err),
				at: this.now(),
				retryIn
			};
			this.emit("error", this.lastError, this.lastSnapshot);
			if (retryIn === null) {
				this.running = false;
				return;
			}
			this.schedule(retryIn);
			return;
		}

		this.consecutiveErrors = 0;
		this.lastError = null;
		const snapshot = this.ingest(devices);
		this.lastSnapshot = snapshot;
		this.emit("update", snapshot);
		this.schedule(this.updateInterval);
	}

	/**
	 * Merge a fresh device list into the tracked state.
	 * @param {object[]} devices normalized devices
	 * @returns {object} snapshot
	 */
	ingest (devices) {
		const now = this.now();
		const joined = [];
		const left = [];
		const seenNow = new Set();

		for (const device of devices) {
			seenNow.add(device.mac);
			const prev = this.known.get(device.mac);
			if (prev) {
				Object.assign(prev, device, { lastSeen: now });
			} else {
				this.departed.delete(device.mac);
				this.known.set(device.mac, {
					...device,
					firstSeen: now,
					lastSeen: now,
					presentAtStart: !this.initialized
				});
				if (this.initialized) joined.push(device.mac);
			}
		}

		for (const [mac, device] of this.known) {
			if (seenNow.has(mac)) continue;
			if (now - device.lastSeen >= this.departureDelay) {
				this.known.delete(mac);
				this.departed.set(mac, { ...device, leftAt: device.lastSeen });
				left.push(mac);
			}
		}

		for (const [mac, device] of this.departed) {
			if (now - device.leftAt > this.departedRetention) this.departed.delete(mac);
		}

		this.initialized = true;
		return {
			updatedAt: now,
			devices: [...this.known.values()].map((d) => ({ ...d, missing: !seenNow.has(d.mac) })),
			departed: [...this.departed.values()],
			joined,
			left
		};
	}
}

module.exports = { DevicePoller };
