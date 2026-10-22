import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { signUploadTicket } from "../src/uploads";

// Against a running Worker: E2E_ORIGIN=http://localhost:8788 npx vitest run test/e2e.test.ts
// Signs upload links with SIGNING_SECRET from .dev.vars, so it only works against `wrangler dev`.
const origin = process.env.E2E_ORIGIN;
const secret = existsSync(".dev.vars")
	? readFileSync(".dev.vars", "utf8").match(/^SIGNING_SECRET=(.+)$/m)?.[1]?.trim()
	: undefined;

describe.skipIf(!origin || !secret)("deployed routes", () => {
	it("serves the landing page", async () => {
		const res = await fetch(`${origin}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("/mcp");
	});

	it("challenges unauthenticated MCP requests", async () => {
		const res = await fetch(`${origin}/mcp`, { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/mcp");
	});

	it("registers a client and shows the consent page, then sends to Google with the domain hint", async () => {
		const registration = await fetch(`${origin}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "E2E test",
				redirect_uris: ["http://localhost:9999/callback"],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(registration.status).toBe(201);
		const { client_id } = (await registration.json()) as { client_id: string };

		const authorize = new URL(`${origin}/authorize`);
		authorize.search = new URLSearchParams({
			response_type: "code",
			client_id,
			redirect_uri: "http://localhost:9999/callback",
			state: "xyz",
			code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			code_challenge_method: "S256",
		}).toString();
		const consent = await fetch(authorize, { redirect: "manual" });
		const page = await consent.text();
		expect(consent.status, page).toBe(200);
		expect(page).toContain("@culturalforces.org");

		const handle = page.match(/name="handle" value="([^"]+)"/)![1];
		const cookie = consent.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		const approve = await fetch(`${origin}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ handle, decision: "approve" }),
		});
		expect(approve.status, await approve.clone().text()).toBe(302);
		const google = new URL(approve.headers.get("Location")!);
		expect(google.origin).toBe("https://accounts.google.com");
		expect(google.searchParams.get("hd")).toBe("culturalforces.org");
		expect(google.searchParams.get("code_challenge_method")).toBe("S256");
		expect(google.searchParams.get("redirect_uri")).toBe(`${origin}/callback`);
	});

	it("refuses forged upload links", async () => {
		const res = await fetch(`${origin}/upload/forged.token`, { method: "PUT", body: "x" });
		expect(res.status).toBe(404);
	});

	it.skipIf(!existsSync("test-audio/low.mp3"))("transcribes an upload once, then refuses the link", async () => {
		const { token } = await signUploadTicket(secret!, { format: "srt" });
		const audio = readFileSync("test-audio/low.mp3");
		const first = await fetch(`${origin}/upload/${token}`, { method: "PUT", body: audio });
		const body = await first.text();
		expect(first.status, body).toBe(200);
		expect(body).toMatch(/^1\n00:00:00,000 --> /);

		const again = await fetch(`${origin}/upload/${token}`, { method: "PUT", body: audio });
		expect(again.status).toBe(410);
	}, 60_000);

	it.skipIf(!existsSync("test-audio/test-en.m4a"))("explains how to convert m4a", async () => {
		const { token } = await signUploadTicket(secret!, { format: "text" });
		const res = await fetch(`${origin}/upload/${token}`, { method: "PUT", body: readFileSync("test-audio/test-en.m4a") });
		expect(res.status).toBe(415);
		expect(await res.text()).toContain("ffmpeg");
	});
});
