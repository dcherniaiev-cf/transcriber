export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accepts standard or URL-safe base64, with or without padding or a `data:` prefix. */
export function fromBase64(input: string): Uint8Array {
	const clean = input
		.replace(/^data:[^,]*,/, "")
		.replace(/\s+/g, "")
		.replace(/-/g, "+")
		.replace(/_/g, "/");
	const binary = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function randomToken(byteLength: number): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return toBase64Url(new Uint8Array(digest));
}
