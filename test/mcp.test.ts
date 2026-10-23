import { readFileSync, existsSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/mcp";
import { verifyUploadTicket } from "../src/uploads";

vi.mock("agents/mcp/server", () => ({
	getMcpAuthContext: () => ({ props: { email: "test@culturalforces.org", name: "Test" } }),
}));

// Live transcription runs only with a real key in .dev.vars and the sample made by
// `ffmpeg -i ... -ac 1 -ar 16000 -b:a 32k test-audio/low.mp3` (both gitignored).
const devVars = existsSync(".dev.vars")
	? Object.fromEntries(
			readFileSync(".dev.vars", "utf8")
				.split(/\r?\n/)
				.filter((line: string) => line.includes("="))
				.map((line: string) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
		)
	: {};
const liveKey = devVars.NEAR_API_KEY?.startsWith("sk-") ? devVars.NEAR_API_KEY : undefined;
const sample = "test-audio/low.mp3";

const env = {
	SIGNING_SECRET: "s".repeat(40),
	PUBLIC_ORIGIN: "https://transcriber.example",
	NEAR_API_KEY: liveKey ?? "sk-test",
} as Env;

let client: Client;

beforeAll(async () => {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createServer(env).connect(serverSide);
	client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(clientSide);
});

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
	(result.content as { type: string; text: string }[]).map((c) => c.text).join("");

describe("MCP tools", () => {
	it("lists both tools", async () => {
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["create_upload_link", "transcribe_audio"]);
	});

	it("issues a signed upload link with a ready curl command", async () => {
		const result = await client.callTool({ name: "create_upload_link", arguments: { format: "srt", language: "uk" } });
		const body = textOf(result);
		const url = body.match(/https:\/\/transcriber\.example\/upload\/(\S+)/);
		expect(url).not.toBeNull();
		expect(await verifyUploadTicket(env.SIGNING_SECRET, url![1])).toMatchObject({ format: "srt", language: "uk" });
		expect(body).toContain('-o "AUDIO.srt"');
		expect(body).toMatch(/^ffmpeg -i "AUDIO" .*libopus.* "AUDIO\.ogg"$/m);
	});

	it("rejects an invalid language code", async () => {
		const result = await client.callTool({ name: "create_upload_link", arguments: { language: "ukrainian" } });
		expect(result.isError).toBe(true);
	});

	it("explains unsupported formats instead of calling NEAR", async () => {
		const m4a = Buffer.from([0, 0, 0, 0x20, ...Buffer.from("ftypM4A ")]).toString("base64");
		const result = await client.callTool({ name: "transcribe_audio", arguments: { audio_base64: m4a } });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("m4a/mp4/mov");
	});

	it.skipIf(!liveKey || !existsSync(sample))("transcribes a real clip through NEAR", async () => {
		const audio = readFileSync(sample).toString("base64");
		const result = await client.callTool({
			name: "transcribe_audio",
			arguments: { audio_base64: audio, format: "timestamped" },
		});
		expect(result.isError, textOf(result)).toBeFalsy();
		expect(textOf(result)).toMatch(/^\[00:00:00\] Hello, this is a test/);
	}, 60_000);
});
