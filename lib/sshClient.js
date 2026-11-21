/*
 * Alternative transport: SSH into the router and read the client list straight
 * from the system. Useful when the web UI is locked down, when the router keeps
 * asking for a CAPTCHA, or when you prefer key-based auth.
 *
 * Requires the `ssh2` package (`npm run install-ssh`) and "Enable SSH: LAN only" on the router
 * (Administration -> System).
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RouterError } = require("./errors");
const { fromSshOutput } = require("./normalize");

// POSIX sh, runs under the router's busybox ash. Sent over stdin to avoid quoting issues.
const PROBE_SCRIPT = `
echo "##CLJSON"; cat /tmp/clientlist.json 2>/dev/null; echo
echo "##LEASES"; cat /var/lib/misc/dnsmasq.leases 2>/dev/null
echo "##NAMES"; nvram get custom_clientlist 2>/dev/null
echo "##NEIGH"; ip neigh show 2>/dev/null
echo "##ARP"; cat /proc/net/arp 2>/dev/null
echo "##BAND"
for u in 0 1 2 3; do
  b=$(nvram get wl\${u}_nband 2>/dev/null)
  [ -n "$b" ] && echo "$u $b"
done
echo "##WL"
for u in 0 1 2 3; do
  ifn=$(nvram get wl\${u}_ifname 2>/dev/null)
  [ -n "$ifn" ] || continue
  for i in $ifn $(nvram get wl\${u}_vifs 2>/dev/null); do
    wl -i "$i" assoclist 2>/dev/null | while read -r _ mac; do
      [ -n "$mac" ] || continue
      r=$(wl -i "$i" rssi "$mac" 2>/dev/null)
      info=$(wl -i "$i" sta_info "$mac" 2>/dev/null | awk '/in network/{t=$3} /rate of last tx pkt/{tx=$6} /rate of last rx pkt/{rx=$6} END{print t+0, tx+0, rx+0}')
      echo "$u $i $mac \${r:-0} $info"
    done
  done
done
echo "##END"
exit 0
`;

class AsusSshClient {
	/**
	 * @param {object} options connection options
	 * @param {string} options.host router address
	 * @param {number} [options.sshPort] SSH port (default 22)
	 * @param {string} options.username admin user
	 * @param {string} [options.password] password (if not using a key)
	 * @param {string} [options.privateKey] path to a private key file (~ allowed)
	 * @param {string} [options.passphrase] key passphrase
	 * @param {number} [options.timeout] timeout in ms
	 * @param {string} [options.lanInterface] LAN bridge name (default br0)
	 */
	constructor (options) {
		this.options = { sshPort: 22, timeout: 10000, lanInterface: "br0", ...options };
		this.conn = null;
		this.connecting = null;
	}

	loadSsh2 () {
		try {
			return require("ssh2");
		} catch {
			throw new RouterError("CONFIG", "method \"ssh\" needs the ssh2 package. Run `npm run install-ssh` inside the module folder.");
		}
	}

	readKey () {
		const keyPath = this.options.privateKey;
		if (!keyPath) return undefined;
		const resolved = keyPath.startsWith("~") ? path.join(os.homedir(), keyPath.slice(1)) : keyPath;
		try {
			return fs.readFileSync(resolved);
		} catch (err) {
			throw new RouterError("CONFIG", `Cannot read privateKey ${resolved}: ${err.message}`);
		}
	}

	/** Open (or reuse) the SSH connection. */
	connect () {
		if (this.conn) return Promise.resolve(this.conn);
		if (this.connecting) return this.connecting;
		const { Client } = this.loadSsh2();
		const privateKey = this.readKey();
		if (!this.options.username || (!this.options.password && !privateKey)) {
			throw new RouterError("CONFIG", "ssh needs username and either password or privateKey");
		}

		this.connecting = new Promise((resolve, reject) => {
			const conn = new Client();
			conn.on("ready", () => {
				this.conn = conn;
				this.connecting = null;
				resolve(conn);
			});
			conn.on("error", (err) => {
				this.conn = null;
				this.connecting = null;
				const auth = err.level === "client-authentication";
				reject(new RouterError(auth ? "AUTH_FAILED" : "UNREACHABLE", auth
					? "Router rejected the SSH credentials"
					: `SSH connection to ${this.options.host}:${this.options.sshPort} failed: ${err.code || err.message}`, { cause: err }));
			});
			conn.on("close", () => {
				this.conn = null;
			});
			conn.connect({
				host: this.options.host,
				port: Number(this.options.sshPort) || 22,
				username: this.options.username,
				password: privateKey ? undefined : this.options.password,
				privateKey,
				passphrase: this.options.passphrase,
				readyTimeout: this.options.timeout,
				keepaliveInterval: 30000
			});
		});
		return this.connecting;
	}

	/**
	 * Run the probe script and return its stdout.
	 * @returns {Promise<string>} output
	 */
	async runProbe () {
		const conn = await this.connect();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new RouterError("TIMEOUT", "SSH probe timed out")), this.options.timeout);
			conn.exec("sh -s", (err, stream) => {
				if (err) {
					clearTimeout(timer);
					this.conn = null;
					return reject(new RouterError("SSH", `SSH exec failed: ${err.message}`, { cause: err }));
				}
				let out = "";
				stream.on("data", (d) => {
					out += d.toString("utf8");
				});
				stream.stderr.on("data", () => {});
				stream.on("close", () => {
					clearTimeout(timer);
					if (!out.includes("##END")) {
						return reject(new RouterError("BAD_RESPONSE", "SSH probe output was incomplete"));
					}
					resolve(out);
				});
				stream.end(PROBE_SCRIPT);
			});
		});
	}

	async getDevices () {
		const out = await this.runProbe();
		return fromSshOutput(out, { lanInterface: this.options.lanInterface });
	}

	async close () {
		if (this.conn) {
			this.conn.end();
			this.conn = null;
		}
	}
}

module.exports = { AsusSshClient, PROBE_SCRIPT };
