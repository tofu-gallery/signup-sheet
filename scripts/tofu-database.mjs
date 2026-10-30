// @ts-check
// The database connection settings the migrate script and the app share (see TOFU.md, Database).
//
// Tofu's DATABASE_URL carries `sslmode=require`. node-postgres reads a URL's TLS parameters itself (some of them as
// file paths) and lets them replace an `ssl` object passed beside the URL, so they are removed here and TLS is set up
// from what they asked for: the server is verified against Node's own roots plus SUPABASE_CA_CERT, the root Tofu's
// databases chain to. Verification is never switched off. Errors here are fixed sentences: never the URL parser's
// error, which can carry the URL and its password.
import { rootCertificates } from 'node:tls';

// The connection-string parameters node-postgres takes TLS settings from.
const TLS_PARAMETERS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat'];

export const CONFIG_SENTENCES = {
	missingUrl: 'DATABASE_URL is not set.',
	badUrl: 'DATABASE_URL must be a PostgreSQL URL.',
	missingCa: "SUPABASE_CA_CERT is not set: it is needed to check the database server's certificate."
};

/** A database setting that cannot work. Its message is one of CONFIG_SENTENCES, safe to print. */
export class DatabaseConfigError extends Error {
	/** @param {string} sentence */
	constructor(sentence) {
		super(sentence);
		this.name = 'DatabaseConfigError';
	}
}

/**
 * The connection string (with its TLS parameters removed) and the TLS settings for DATABASE_URL.
 *
 * TLS is used when the URL asks for it: an `sslmode` other than `disable`, `ssl=true` or `ssl=1`, or a certificate
 * parameter. Every TLS mode, `prefer` and `no-verify` included, becomes a fully verified connection.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ connectionString: string, ssl?: { ca: string[], rejectUnauthorized: true } }}
 */
export function connectionSettings(env) {
	const raw = env.DATABASE_URL?.trim();
	if (!raw) throw new DatabaseConfigError(CONFIG_SENTENCES.missingUrl);

	/** @type {URL} */
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new DatabaseConfigError(CONFIG_SENTENCES.badUrl);
	}
	if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
		throw new DatabaseConfigError(CONFIG_SENTENCES.badUrl);
	}

	const useTls = asksForTls(url.searchParams);
	for (const name of TLS_PARAMETERS) url.searchParams.delete(name);
	if (!useTls) return { connectionString: url.toString() };

	const ca = env.SUPABASE_CA_CERT?.trim();
	if (!ca) throw new DatabaseConfigError(CONFIG_SENTENCES.missingCa);
	return { connectionString: url.toString(), ssl: { ca: [...rootCertificates, ca], rejectUnauthorized: true } };
}

/** @param {URLSearchParams} params */
function asksForTls(params) {
	const mode = params.get('sslmode');
	if (mode !== null) return mode.trim().toLowerCase() !== 'disable';
	const ssl = params.get('ssl');
	if (ssl !== null && ['true', '1'].includes(ssl.trim().toLowerCase())) return true;
	return ['sslcert', 'sslkey', 'sslrootcert'].some((name) => params.has(name));
}
