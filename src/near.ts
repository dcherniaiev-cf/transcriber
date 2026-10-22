import type { AudioExt } from "./audio";
import type { Transcript } from "./format";

const ENDPOINT = "https://cloud-api.near.ai/v1/audio/transcriptions";
export const WHISPER_MODEL = "openai/whisper-large-v3";

/** A failure with a message safe to show the person and the HTTP status to answer with. */
export class TranscriptionError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "TranscriptionError";
	}
}

interface NearResponse {
	text: string;
	duration?: number | null;
	language?: string | null;
	segments?: { start: number; end: number; text: string }[] | null;
}

export async function transcribe(
	apiKey: string,
	audio: Uint8Array,
	ext: AudioExt,
	language?: string,
): Promise<Transcript> {
	const form = new FormData();
	form.set("model", WHISPER_MODEL);
	form.set("response_format", "verbose_json");
	form.append("timestamp_granularities[]", "segment");
	if (language) form.set("language", language);
	form.set("file", new Blob([audio]), `audio.${ext}`);

	const send = () => fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
	let res = await send();
	// One retry for transient upstream failures; seen occasionally on short clips.
	if (res.status >= 500) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		res = await send();
	}
	if (!res.ok) throw await upstreamError(res);

	const raw = (await res.json()) as NearResponse;
	return {
		text: raw.text.trim(),
		language: raw.language ?? null,
		duration: raw.duration ?? null,
		segments: (raw.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
	};
}

async function upstreamError(res: Response): Promise<TranscriptionError> {
	const detail = await res
		.json<{ error?: { message?: string } }>()
		.then((body) => body.error?.message)
		.catch(() => undefined);
	console.error(JSON.stringify({ event: "near_error", status: res.status, detail }));

	if (res.status === 400) {
		return new TranscriptionError(`NEAR AI не зміг обробити аудіо: ${detail ?? "невідома причина"}`, 422);
	}
	if (res.status === 401 || res.status === 403) {
		return new TranscriptionError("Ключ NEAR AI на сервері недійсний. Повідомте адміністратора конектора.", 502);
	}
	if (res.status === 429) {
		return new TranscriptionError("Сервіс транскрибації перевантажений. Спробуйте за хвилину.", 503);
	}
	return new TranscriptionError(`NEAR AI повернув помилку ${res.status}. Спробуйте ще раз.`, 502);
}
