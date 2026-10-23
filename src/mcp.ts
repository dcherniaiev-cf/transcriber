import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import * as z from "zod";
import { ffmpegCommand } from "./audio";
import { fromBase64 } from "./encoding";
import { OUTPUT_FORMATS, type OutputFormat } from "./format";
import { TranscriptionError } from "./near";
import { checkAudio, runTranscription } from "./pipeline";
import { UPLOAD_TTL_SECONDS, signUploadTicket } from "./uploads";

/** Who signed in, stored encrypted in the grant and handed back on every MCP request. */
export type UserProps = { email: string; name: string };

function currentUser(): UserProps {
	const props = getMcpAuthContext()?.props as Partial<UserProps> | undefined;
	if (!props?.email) throw new Error("MCP request without a signed-in user");
	return { email: props.email, name: props.name ?? props.email };
}

const FILE_EXTENSIONS: Record<OutputFormat, string> = {
	text: "txt",
	timestamped: "txt",
	srt: "srt",
	vtt: "vtt",
	json: "json",
};

const transcriptOptions = {
	language: z
		.string()
		.regex(/^[a-z]{2,3}$/)
		.optional()
		.describe("ISO 639-1 code of the spoken language, e.g. 'uk' or 'en'. Omit to auto-detect."),
	format: z
		.enum(OUTPUT_FORMATS)
		.default("text")
		.describe(
			"text: plain transcript. timestamped: one line per phrase, prefixed with [hh:mm:ss]. srt / vtt: subtitles. json: text, language, duration and segments with start/end in seconds.",
		),
};

export function createServer(env: Env): McpServer {
	const server = new McpServer({ name: "ks-transcriber", title: "Транскрайбер КС", version: "0.1.0" });

	server.registerTool(
		"create_upload_link",
		{
			title: "Посилання для транскрибації файлу",
			description: [
				"Transcribe an audio file that is on the user's disk (Claude Code, Cowork, a sandbox with network access), using Whisper large-v3 on NEAR AI.",
				"Returns a one-time upload URL and a ready curl command: the file goes straight to the server, never through this conversation, and the HTTP response body is the transcript.",
				"Accepted: mp3, wav, ogg, flac, up to 25 MB. m4a, aac, webm, mp4, mov and other video must be converted first with ffmpeg (the command is in the result).",
				"Word-level timestamps are not available; segments (phrases) are.",
			].join(" "),
			inputSchema: z.object(transcriptOptions),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ language, format }) => {
			const user = currentUser();
			const { token, ticket } = await signUploadTicket(env.SIGNING_SECRET, { format, language });
			console.log(JSON.stringify({ event: "upload_link", email: user.email, nonce: ticket.nonce, format }));

			const url = `${env.PUBLIC_ORIGIN}/upload/${token}`;
			const ext = FILE_EXTENSIONS[format];
			return {
				content: [
					{
						type: "text",
						text: [
							`One-time upload URL, valid ${UPLOAD_TTL_SECONDS / 60} minutes:`,
							url,
							"",
							"Run (replace AUDIO with the file path; quote paths with spaces or non-Latin letters):",
							`curl -sS -T "AUDIO" "${url}" -o "AUDIO.${ext}" -w "HTTP %{http_code}\\n"`,
							"",
							`HTTP 200: AUDIO.${ext} holds the transcript (${format}). Read it from the file rather than printing it: long recordings produce long text.`,
							`Any other code: the file holds the error message; the link stays valid for a retry until it expires.`,
							"",
							"Before uploading m4a/aac/webm/mp4/mov or anything over 25 MB, convert:",
							ffmpegCommand("AUDIO", "AUDIO.ogg"),
						].join("\n"),
					},
				],
			};
		},
	);

	server.registerTool(
		"transcribe_audio",
		{
			title: "Транскрибувати аудіо (base64)",
			description: [
				"Transcribe audio passed inline as base64, using Whisper large-v3 on NEAR AI.",
				"Only for clients that can attach file bytes to a tool call (for example a Claude artifact) or for clips of a few seconds.",
				"For a file on disk use create_upload_link instead: a real recording is far too large to write into a tool call.",
				"Accepted: mp3, wav, ogg, flac, up to 25 MB.",
			].join(" "),
			inputSchema: z.object({
				audio_base64: z.string().min(1).describe("The audio file's bytes, base64-encoded (a data: URL prefix is fine)."),
				...transcriptOptions,
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ audio_base64, language, format }) => {
			const user = currentUser();
			try {
				const bytes = fromBase64(audio_base64);
				const ext = checkAudio(bytes);
				const out = await runTranscription(env.NEAR_API_KEY, bytes, ext, { format, language }, { via: "tool", email: user.email });
				return { content: [{ type: "text", text: out.body }] };
			} catch (error) {
				if (error instanceof TranscriptionError) return { isError: true, content: [{ type: "text", text: error.message }] };
				if (error instanceof DOMException) {
					return { isError: true, content: [{ type: "text", text: "audio_base64 is not valid base64." }] };
				}
				throw error;
			}
		},
	);

	return server;
}
