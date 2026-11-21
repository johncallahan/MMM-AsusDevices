"use strict";

/**
 * Error with a machine-readable `kind` so the poller can decide how long to back off.
 *
 * Kinds: CONFIG, UNREACHABLE, TIMEOUT, TLS, SESSION, AUTH_FAILED, LOCKED,
 *        ANOTHER_SESSION, CAPTCHA, RESET_REQUIRED, BAD_RESPONSE, SSH, ROUTER_ERROR
 */
class RouterError extends Error {
	constructor (kind, message, extra = {}) {
		super(message, extra.cause ? { cause: extra.cause } : undefined);
		this.name = "RouterError";
		this.kind = kind;
		this.retryAfter = extra.retryAfter || null;
		this.status = extra.status === undefined ? null : extra.status;
	}
}

module.exports = { RouterError };
