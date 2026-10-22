import { CONVERT_HINT, MAX_AUDIO_BYTES, sniffAudio, type AudioExt } from "./audio";
import { render, type OutputFormat, type Rendered } from "./format";
import { TranscriptionError, transcribe } from "./near";

export interface TranscribeOptions {
	format: OutputFormat;
	language?: string;
}

const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

export function tooLargeError(bytes: number): TranscriptionError {
	return new TranscriptionError(`Файл ${megabytes(bytes)} МБ, а ліміт 25 МБ. ${CONVERT_HINT}`, 413);
}

/** Rejects what NEAR would reject, before spending an upstream call on it. */
export function checkAudio(bytes: Uint8Array): AudioExt {
	if (bytes.byteLength === 0) throw new TranscriptionError("Файл порожній.", 400);
	if (bytes.byteLength > MAX_AUDIO_BYTES) throw tooLargeError(bytes.byteLength);
	const sniffed = sniffAudio(bytes);
	if (!sniffed.ok) {
		throw new TranscriptionError(
			`Формат ${sniffed.detected} не підтримується (підходять mp3, wav, ogg, flac). ${CONVERT_HINT}`,
			415,
		);
	}
	return sniffed.ext;
}

export async function runTranscription(
	apiKey: string,
	bytes: Uint8Array,
	ext: AudioExt,
	options: TranscribeOptions,
	log: Record<string, string>,
): Promise<Rendered> {
	const started = Date.now();
	const transcript = await transcribe(apiKey, bytes, ext, options.language);
	console.log(
		JSON.stringify({
			event: "transcription",
			...log,
			bytes: bytes.byteLength,
			audio_seconds: transcript.duration,
			language: transcript.language,
			format: options.format,
			ms: Date.now() - started,
		}),
	);
	return render(transcript, options.format);
}
