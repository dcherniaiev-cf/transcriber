import { existsSync, readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Base64Url, randomToken } from "../src/encoding";

// Walks the whole path an MCP client takes, against a running Worker:
//   E2E_ORIGIN=http://localhost:8788 npm run test:e2e
// In password mode the login comes from E2E_USERNAME / E2E_PASSWORD, or from .dev.vars.
const origin = process.env.E2E_ORIGIN;
const devVars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
const fromDevVars = (name: string) => devVars.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
const username = process.env.E2E_USERNAME ?? fromDevVars("LOGIN_USERNAME");
const password = process.env.E2E_PASSWORD ?? fromDevVars("LOGIN_PASSWORD");

const REDIRECT_URI = "http://localhost:9999/callback";
const cookiesOf = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
const handleOf = (page: string) => page.match(/name="handle" value="([^"]+)"/)![1];

describe.skipIf(!origin)("end to end", () => {
	let clientId: string;
	const verifier = randomToken(32);

	beforeAll(async () => {
		const registration = await fetch(`${origin}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_name: "E2E test", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
		});
		expect(registration.status).toBe(201);
		clientId = ((await registration.json()) as { client_id: string }).client_id;
	});

	async function openConsent() {
		const url = new URL(`${origin}/authorize`);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: REDIRECT_URI,
			state: "xyz",
			code_challenge: await sha256Base64Url(verifier),
			code_challenge_method: "S256",
		}).toString();
		const res = await fetch(url, { redirect: "manual" });
		const page = await res.text();
		expect(res.status, page).toBe(200);
		return { page, cookie: cookiesOf(res) };
	}

	const submit = (cookie: string, fields: Record<string, string>) =>
		fetch(`${origin}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields),
		});

	it("serves the landing page and challenges anonymous MCP calls", async () => {
		expect((await fetch(`${origin}/`)).status).toBe(200);
		const res = await fetch(`${origin}/mcp`, { method: "POST", body: "{}" });
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/mcp");
	});

	it("refuses forged upload links", async () => {
		expect((await fetch(`${origin}/upload/forged.token`, { method: "PUT", body: "x" })).status).toBe(404);
	});

	describe("Google mode", () => {
		it("sends the person to Google with the domain hint", async (ctx) => {
			const { page, cookie } = await openConsent();
			if (page.includes('name="password"')) ctx.skip();
			const res = await submit(cookie, { handle: handleOf(page), decision: "approve" });
			expect(res.status).toBe(302);
			const google = new URL(res.headers.get("Location")!);
			expect(google.origin).toBe("https://accounts.google.com");
			expect(google.searchParams.get("hd")).toBe("culturalforces.org");
			expect(google.searchParams.get("redirect_uri")).toBe(`${origin}/callback`);
		});
	});

	describe.skipIf(!username || !password)("password mode", () => {
		let accessToken: string;
		let mcp: Client;

		it("rejects a wrong password and shows the form again", async (ctx) => {
			const { page, cookie } = await openConsent();
			if (!page.includes('name="password"')) ctx.skip();
			const res = await submit(cookie, { handle: handleOf(page), decision: "approve", username: username!, password: "wrong-password-123" });
			const again = await res.text();
			expect(res.status, again).toBe(401);
			expect(again).toContain("Невірний логін або пароль");
			expect(again).toContain('name="handle"');
		});

		it("signs in, gets a token and calls the tools", async (ctx) => {
			const { page, cookie } = await openConsent();
			if (!page.includes('name="password"')) ctx.skip();
			const res = await submit(cookie, { handle: handleOf(page), decision: "approve", username: username!, password: password! });
			expect(res.status, await res.clone().text()).toBe(302);
			const back = new URL(res.headers.get("Location")!);
			expect(back.origin + back.pathname).toBe(REDIRECT_URI);
			expect(back.searchParams.get("state")).toBe("xyz");

			const token = await fetch(`${origin}/token`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: back.searchParams.get("code")!,
					redirect_uri: REDIRECT_URI,
					client_id: clientId,
					code_verifier: verifier,
				}),
			});
			expect(token.status).toBe(200);
			accessToken = ((await token.json()) as { access_token: string }).access_token;

			mcp = new Client({ name: "e2e", version: "1.0.0" });
			await mcp.connect(
				new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
					requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
				}),
			);
			const { tools } = await mcp.listTools();
			expect(tools.map((t) => t.name).sort()).toEqual(["create_upload_link", "transcribe_audio"]);
		});

		const uploadUrl = async (format: string) => {
			const result = await mcp.callTool({ name: "create_upload_link", arguments: { format } });
			const text = (result.content as { text: string }[])[0].text;
			return text.match(/https?:\/\/\S+\/upload\/\S+/)![0];
		};

		it.skipIf(!existsSync("test-audio/low.mp3"))("transcribes an upload once, then refuses the link", async (ctx) => {
			if (!mcp) ctx.skip();
			const url = await uploadUrl("srt");
			const audio = readFileSync("test-audio/low.mp3");
			const first = await fetch(url, { method: "PUT", body: audio });
			const body = await first.text();
			expect(first.status, body).toBe(200);
			expect(body).toMatch(/^1\n00:00:00,000 --> .*\nHello, this is a test/);
			expect((await fetch(url, { method: "PUT", body: audio })).status).toBe(410);
		}, 60_000);

		it.skipIf(!existsSync("test-audio/test-en.m4a"))("explains how to convert m4a", async (ctx) => {
			if (!mcp) ctx.skip();
			const res = await fetch(await uploadUrl("text"), { method: "PUT", body: readFileSync("test-audio/test-en.m4a") });
			expect(res.status).toBe(415);
			expect(await res.text()).toContain("ffmpeg");
		});
	});
});
