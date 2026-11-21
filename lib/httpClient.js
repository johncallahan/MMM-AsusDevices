/*
 * Talks to the Asuswrt / Asuswrt-Merlin web API (the same one the ASUS Router
 * mobile app uses):
 *
 *   POST /login.cgi     login_authorization=base64(user:pass)  -> {"asus_token": "..."}
 *   POST /appGet.cgi    hook=get_clientlist()                  -> {"get_clientlist": {...}}
 *   GET  /Logout.asp
 *
 * The token is reused between polls and refreshed automatically when the
 * router expires it. Logging in with the app's user agent does not kick an
 * admin out of the web UI the way a browser login would.
 */

"use strict";

const http = require("http");
const https = require("https");
const { RouterError } = require("./errors");
const { parseRouterJson, fromClientList } = require("./normalize");

const USER_AGENT = "asusrouter--DUTUtil-";

// error_status codes returned by login.cgi / appGet.cgi
const ERROR_STATUS = {
	2: "SESSION",          // not authorized / token invalid
	3: "AUTH_FAILED",      // wrong username or password
	7: "LOCKED",           // too many attempts, try again later
	8: "SESSION",          // logged out
	9: "ANOTHER_SESSION",  // another admin is logged in
	10: "CAPTCHA",         // router wants a captcha (too many failures)
	11: "RESET_REQUIRED"   // default password must be changed first
};

class AsusHttpClient {
	/**
	 * @param {object} options connection options
	 * @param {string} options.host router address
	 * @param {number} [options.port] port (default 80 / 8443)
	 * @param {string} [options.protocol] "http" | "https"
	 * @param {string} options.username admin user
	 * @param {string} options.password admin password
	 * @param {number} [options.timeout] request timeout in ms
	 * @param {boolean} [options.rejectUnauthorized] verify the router's TLS certificate
	 * @param {boolean} [options.includeOffline] keep devices the router marks offline
	 */
	constructor (options) {
		this.options = { protocol: "http", timeout: 10000, rejectUnauthorized: false, ...options };
		const { protocol } = this.options;
		if (protocol !== "http" && protocol !== "https") {
			throw new RouterError("CONFIG", `protocol must be "http" or "https", got "${protocol}"`);
		}
		this.port = Number(this.options.port) || (protocol === "https" ? 8443 : 80);
		this.token = null;
		this.transport = protocol === "https" ? https : http;
	}

	get baseUrl () {
		return `${this.options.protocol}://${this.options.host}:${this.port}`;
	}

	/**
	 * Low-level request helper.
	 * @param {string} method HTTP method
	 * @param {string} path request path
	 * @param {string} [body] form-encoded body
	 * @param {object} [extraHeaders] additional headers
	 * @returns {Promise<{status:number, headers:object, body:string}>} response
	 */
	request (method, path, body, extraHeaders = {}) {
		const headers = {
			"User-Agent": USER_AGENT,
			Accept: "application/json, text/plain, */*",
			Connection: "close",
			...extraHeaders
		};
		if (this.token) headers.Cookie = `asus_token=${this.token}`;
		if (body !== undefined) {
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			headers["Content-Length"] = Buffer.byteLength(body);
		}

		return new Promise((resolveOnce, rejectOnce) => {
			let settled = false;
			const resolve = (v) => {
				if (!settled) {
					settled = true;
					resolveOnce(v);
				}
			};
			const reject = (e) => {
				if (!settled) {
					settled = true;
					rejectOnce(e);
				}
			};
			const req = this.transport.request({
				host: this.options.host,
				port: this.port,
				path,
				method,
				headers,
				timeout: this.options.timeout,
				rejectUnauthorized: this.options.rejectUnauthorized
			}, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
				res.on("error", reject);
			});
			req.on("timeout", () => {
				reject(new RouterError("TIMEOUT", `No response from ${this.baseUrl} after ${this.options.timeout} ms`));
				req.abort();
			});
			req.on("error", (err) => {
				if (err instanceof RouterError) return reject(err);
				const tlsCodes = ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED"];
				if (tlsCodes.includes(err.code)) {
					return reject(new RouterError("TLS", `Router TLS certificate rejected (${err.code}). Set rejectUnauthorized: false or use protocol: "http".`, { cause: err }));
				}
				if (err.code === "EPROTO" || /wrong version number|packet length too long/i.test(err.message)) {
					return reject(new RouterError("TLS", `TLS handshake failed against ${this.baseUrl} — is this the HTTPS port? (${err.message})`, { cause: err }));
				}
				reject(new RouterError("UNREACHABLE", `Cannot reach router at ${this.baseUrl}: ${err.code || err.message}`, { cause: err }));
			});
			if (body !== undefined) req.write(body);
			req.end();
		});
	}

	/**
	 * Raise a RouterError for an error_status payload, if there is one.
	 * @param {object|null} json parsed body
	 */
	static checkErrorStatus (json) {
		if (!json || json.error_status === undefined) return;
		const code = Number(json.error_status);
		const kind = ERROR_STATUS[code] || "ROUTER_ERROR";
		const messages = {
			SESSION: "Router session expired",
			AUTH_FAILED: "Router rejected the username or password",
			LOCKED: "Router has temporarily locked logins after too many attempts",
			ANOTHER_SESSION: "Another administrator session is blocking the login",
			CAPTCHA: "Router is asking for a CAPTCHA after failed logins; log in once in a browser to clear it, or use method: \"ssh\"",
			RESET_REQUIRED: "Router requires the default password to be changed before API access",
			ROUTER_ERROR: `Router returned error_status ${code}`
		};
		const retryAfter = Number(json.remaining_lock_time) || null;
		throw new RouterError(kind, messages[kind] + (retryAfter ? ` (retry in ${retryAfter}s)` : ""), { retryAfter, status: code });
	}

	/**
	 * Log in and store the session token.
	 * @returns {Promise<string>} token
	 */
	async login () {
		this.token = null;
		const { username, password } = this.options;
		if (!username || !password) throw new RouterError("CONFIG", "username and password are required");
		const auth = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
		const res = await this.request("POST", "/login.cgi", `login_authorization=${encodeURIComponent(auth)}`);

		const json = parseRouterJson(res.body);
		AsusHttpClient.checkErrorStatus(json);

		let token = json && json.asus_token;
		if (!token) {
			const cookies = [].concat(res.headers["set-cookie"] || []);
			const match = cookies.join(";").match(/asus_token=([^;]+)/);
			token = match && match[1];
		}
		if (!token || token === "deleted") {
			throw new RouterError(res.status >= 400 ? "UNREACHABLE" : "AUTH_FAILED", `Login failed (HTTP ${res.status}); no session token returned`, { status: res.status });
		}
		this.token = token;
		return token;
	}

	/**
	 * Run an appGet.cgi hook, logging in (again) when needed.
	 * @param {string} hook e.g. "get_clientlist()"
	 * @returns {Promise<object>} parsed JSON
	 */
	async appGet (hook) {
		if (!this.token) await this.login();
		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await this.request("POST", "/appGet.cgi", `hook=${encodeURIComponent(hook)}`);
			const json = parseRouterJson(res.body);
			let sessionProblem = false;
			if (res.status === 401 || res.status === 403 || res.status === 302) {
				sessionProblem = true;
			} else if (!json) {
				// An HTML body here is the router redirecting to Main_Login.asp
				sessionProblem = true;
			} else {
				try {
					AsusHttpClient.checkErrorStatus(json);
					return json;
				} catch (err) {
					if (err.kind !== "SESSION") throw err;
					sessionProblem = true;
				}
			}
			if (sessionProblem && attempt === 0) {
				await this.login();
				continue;
			}
			if (res.status >= 400) throw new RouterError("UNREACHABLE", `appGet.cgi returned HTTP ${res.status}`, { status: res.status });
			throw new RouterError("BAD_RESPONSE", "Router did not return JSON from appGet.cgi even after re-login");
		}
		throw new RouterError("BAD_RESPONSE", "Unreachable");
	}

	/**
	 * Fetch connected devices.
	 * @returns {Promise<object[]>} normalized devices
	 */
	async getDevices () {
		const json = await this.appGet("get_clientlist()");
		if (!json.get_clientlist) {
			throw new RouterError("BAD_RESPONSE", "Router response did not include get_clientlist — firmware may be too old (needs 384.x or newer)");
		}
		return fromClientList(json, { includeOffline: this.options.includeOffline });
	}

	/** End the session on the router so it does not count against session limits. */
	async close () {
		if (!this.token) return;
		try {
			await this.request("GET", "/Logout.asp");
		} catch (e) {
			// ignore: we are shutting down anyway
		}
		this.token = null;
	}
}

module.exports = { AsusHttpClient, USER_AGENT };
