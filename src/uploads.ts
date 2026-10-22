import { fromBase64, randomToken, toBase64Url } from "./encoding";
import type { OutputFormat } from "./format";

export const UPLOAD_TTL_SECONDS = 15 * 60;

/**
 * What an upload link carries. The link is signed rather than stored, so it works
 * from any Cloudflare location the instant it is issued (KV writes can take up to
 * a minute to reach other locations). No personal data: the e-mail is logged
 * against `nonce` when the link is issued.
 */
export interface UploadTicket {
	nonce: string;
	format: OutputFormat;
	language?: string;
	/** Expiry, epoch seconds. */
	exp: number;
}

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify") {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signUploadTicket(
	secret: string,
	options: { format: OutputFormat; language?: string },
	now = Date.now(),
): Promise<{ token: string; ticket: UploadTicket }> {
	const ticket: UploadTicket = {
		nonce: randomToken(16),
		...options,
		exp: Math.floor(now / 1000) + UPLOAD_TTL_SECONDS,
	};
	const payload = toBase64Url(encoder.encode(JSON.stringify(ticket)));
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(`upload:${payload}`));
	return { token: `${payload}.${toBase64Url(new Uint8Array(signature))}`, ticket };
}

/** Returns the ticket, or null when the token is malformed, forged or expired. */
export async function verifyUploadTicket(secret: string, token: string, now = Date.now()): Promise<UploadTicket | null> {
	const parts = token.split(".");
	if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]+$/.test(parts[1])) return null;
	const [payload, signature] = parts;

	let signatureBytes: Uint8Array;
	try {
		signatureBytes = fromBase64(signature);
	} catch {
		return null;
	}
	const valid = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(secret, "verify"),
		signatureBytes,
		encoder.encode(`upload:${payload}`),
	);
	if (!valid) return null;

	// Signed by us, so the payload is well-formed.
	const ticket = JSON.parse(new TextDecoder().decode(fromBase64(payload))) as UploadTicket;
	return ticket.exp * 1000 > now ? ticket : null;
}

// Single use is best effort: KV is eventually consistent, which only matters for
// the same link replayed from another continent within the same minute.
const usedKey = (nonce: string) => `upload-used:${nonce}`;

export async function isUploadUsed(kv: KVNamespace, nonce: string): Promise<boolean> {
	return (await kv.get(usedKey(nonce))) !== null;
}

export async function markUploadUsed(kv: KVNamespace, nonce: string): Promise<void> {
	await kv.put(usedKey(nonce), "1", { expirationTtl: UPLOAD_TTL_SECONDS + 60 });
}
