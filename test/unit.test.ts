import { describe, expect, it } from "vitest";
import { sniffAudio } from "../src/audio";
import { fromBase64, toBase64Url } from "../src/encoding";
import { clock, render, type Transcript } from "../src/format";
import { isAllowedUser, type GoogleUser } from "../src/google";
import { credentialsMatch, passwordLoginConfigured } from "../src/password-login";
import { checkAudio } from "../src/pipeline";
import { signUploadTicket, verifyUploadTicket } from "../src/uploads";

const bytes = (...parts: (string | number[])[]) =>
	new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("clock", () => {
	it("formats hours, minutes, seconds and milliseconds", () => {
		expect(clock(83.5)).toBe("00:01:23");
		expect(clock(3723.0456, ",")).toBe("01:02:03,046");
		expect(clock(5.1000000000000005, ".")).toBe("00:00:05.100");
	});
});

describe("render", () => {
	const t: Transcript = {
		text: "Привіт. Як справи?",
		language: "uk",
		duration: 9.5,
		segments: [
			{ start: 0, end: 4.18, text: "Привіт." },
			{ start: 5.1, end: 9.52, text: "Як справи?" },
		],
	};

	it("renders srt with numbered cues", () => {
		expect(render(t, "srt").body).toBe(
			"1\n00:00:00,000 --> 00:00:04,180\nПривіт.\n\n2\n00:00:05,100 --> 00:00:09,520\nЯк справи?\n",
		);
	});

	it("renders vtt with a header", () => {
		expect(render(t, "vtt").body).toMatch(/^WEBVTT\n\n00:00:00\.000 --> 00:00:04\.180\nПривіт\.\n/);
	});

	it("renders one timestamped line per segment", () => {
		expect(render(t, "timestamped").body).toBe("[00:00:00] Привіт.\n[00:00:05] Як справи?");
	});
});

describe("sniffAudio", () => {
	it("accepts the formats NEAR takes", () => {
		expect(sniffAudio(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "))).toEqual({ ok: true, ext: "wav" });
		expect(sniffAudio(bytes("OggS", [0, 2]))).toEqual({ ok: true, ext: "ogg" });
		expect(sniffAudio(bytes("fLaC", [0]))).toEqual({ ok: true, ext: "flac" });
		expect(sniffAudio(bytes("ID3", [4, 0]))).toEqual({ ok: true, ext: "mp3" });
		expect(sniffAudio(bytes([0xff, 0xfb, 0x90, 0x64]))).toEqual({ ok: true, ext: "mp3" });
	});

	it("names the formats NEAR rejects", () => {
		expect(sniffAudio(bytes([0, 0, 0, 0x20], "ftypM4A "))).toEqual({ ok: false, detected: "m4a/mp4/mov" });
		expect(sniffAudio(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toEqual({ ok: false, detected: "webm/mkv" });
		expect(sniffAudio(bytes([0xff, 0xf1, 0x50, 0x80]))).toEqual({ ok: false, detected: "aac" });
	});

	it("is enforced before any upstream call", () => {
		expect(() => checkAudio(new Uint8Array())).toThrow("порожній");
		expect(() => checkAudio(bytes([0, 0, 0, 0x20], "ftypM4A "))).toThrow("ffmpeg");
		expect(() => checkAudio(new Uint8Array(25_000_001))).toThrow("ліміт 25 МБ");
	});
});

describe("isAllowedUser", () => {
	const user = (over: Partial<GoogleUser>): GoogleUser => ({
		sub: "1",
		email: "d.cherniaiev@culturalforces.org",
		email_verified: true,
		hd: "culturalforces.org",
		...over,
	});

	it("lets in verified Workspace accounts of the domain", () => {
		expect(isAllowedUser(user({}), "culturalforces.org")).toBe(true);
		expect(isAllowedUser(user({ email: "D.Cherniaiev@CulturalForces.org" }), "culturalforces.org")).toBe(true);
	});

	it("keeps out everyone else", () => {
		expect(isAllowedUser(user({ email: "someone@gmail.com", hd: undefined }), "culturalforces.org")).toBe(false);
		expect(isAllowedUser(user({ hd: "evil.org", email: "x@evil.org" }), "culturalforces.org")).toBe(false);
		expect(isAllowedUser(user({ email_verified: false }), "culturalforces.org")).toBe(false);
		expect(isAllowedUser(user({ hd: undefined }), "culturalforces.org")).toBe(false);
		expect(isAllowedUser(user({ email: "x@culturalforces.org.evil.com" }), "culturalforces.org")).toBe(false);
	});
});

describe("password login", () => {
	const env = { LOGIN_USERNAME: "ks", LOGIN_PASSWORD: "correct horse battery" };

	it("accepts only the exact login and password", async () => {
		expect(await credentialsMatch(env, "ks", "correct horse battery")).toBe(true);
		expect(await credentialsMatch(env, "ks", "correct horse batter")).toBe(false);
		expect(await credentialsMatch(env, "KS", "correct horse battery")).toBe(false);
		expect(await credentialsMatch(env, "", "")).toBe(false);
	});

	it("stays closed until a long enough password is configured", async () => {
		expect(passwordLoginConfigured({})).toBe(false);
		expect(passwordLoginConfigured({ LOGIN_USERNAME: "ks", LOGIN_PASSWORD: "short" })).toBe(false);
		expect(await credentialsMatch({ LOGIN_USERNAME: "ks", LOGIN_PASSWORD: "" }, "ks", "")).toBe(false);
		expect(passwordLoginConfigured(env)).toBe(true);
	});
});

describe("upload tickets", () => {
	const secret = "s".repeat(40);

	it("round-trips and expires", async () => {
		const now = Date.UTC(2026, 9, 22, 12);
		const { token, ticket } = await signUploadTicket(secret, { format: "srt", language: "uk" }, now);
		expect(await verifyUploadTicket(secret, token, now)).toEqual(ticket);
		expect(await verifyUploadTicket(secret, token, now + 16 * 60_000)).toBeNull();
	});

	it("rejects forged, tampered and malformed tokens", async () => {
		const { token } = await signUploadTicket(secret, { format: "text" });
		expect(await verifyUploadTicket("x".repeat(40), token)).toBeNull();

		const [, signature] = token.split(".");
		const forged = toBase64Url(new TextEncoder().encode(JSON.stringify({ nonce: "n", format: "json", exp: 9e9 })));
		expect(await verifyUploadTicket(secret, `${forged}.${signature}`)).toBeNull();
		expect(await verifyUploadTicket(secret, "not-a-token")).toBeNull();
		expect(await verifyUploadTicket(secret, "forged.token")).toBeNull();
		expect(await verifyUploadTicket(secret, `${token}.extra`)).toBeNull();
	});
});

describe("fromBase64", () => {
	it("decodes standard, URL-safe and data-URL input", () => {
		const expected = [0xfb, 0xff, 0x00, 0x41];
		expect([...fromBase64("+/8AQQ==")]).toEqual(expected);
		expect([...fromBase64("-_8AQQ")]).toEqual(expected);
		expect([...fromBase64("data:audio/mpeg;base64,+/8AQQ==")]).toEqual(expected);
	});
});
