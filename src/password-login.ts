// Temporary sign-in with one shared login and password, used while the Google
// OAuth client is not set up yet. Switched on by AUTH_MODE = "password".

export const MIN_PASSWORD_LENGTH = 12;
const MAX_FAILURES = 10;
const LOCKOUT_SECONDS = 15 * 60;

interface Credentials {
	LOGIN_USERNAME?: string;
	LOGIN_PASSWORD?: string;
}

/** Refuses to accept anything while the secrets are missing or the password is weak. */
export function passwordLoginConfigured(env: Credentials): boolean {
	return Boolean(env.LOGIN_USERNAME) && (env.LOGIN_PASSWORD ?? "").length >= MIN_PASSWORD_LENGTH;
}

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Compares fixed-length digests in constant time, so timing reveals nothing about either value. */
function equalDigests(a: Uint8Array, b: Uint8Array): boolean {
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export async function credentialsMatch(env: Credentials, username: string, password: string): Promise<boolean> {
	if (!passwordLoginConfigured(env)) return false;
	const [user, expectedUser, pass, expectedPass] = await Promise.all([
		digest(username),
		digest(env.LOGIN_USERNAME!),
		digest(password),
		digest(env.LOGIN_PASSWORD!),
	]);
	const userOk = equalDigests(user, expectedUser);
	const passOk = equalDigests(pass, expectedPass);
	return userOk && passOk;
}

// Failed attempts are counted per IP in KV: ten wrong passwords lock that IP out
// for fifteen minutes. KV is eventually consistent, so the limit is approximate.
const failureKey = (ip: string) => `login-fail:${ip}`;

export async function isLockedOut(kv: KVNamespace, ip: string): Promise<boolean> {
	return Number((await kv.get(failureKey(ip))) ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(kv: KVNamespace, ip: string): Promise<void> {
	const failures = Number((await kv.get(failureKey(ip))) ?? 0) + 1;
	await kv.put(failureKey(ip), String(failures), { expirationTtl: LOCKOUT_SECONDS });
}
