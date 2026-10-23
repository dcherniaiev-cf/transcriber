// Formats NEAR's Whisper endpoint actually accepts. Its docs also list m4a and
// webm, but both are rejected in practice (checked 2026-10-22), so they are
// caught here with a conversion hint instead of a vague upstream error.
export type AudioExt = "mp3" | "wav" | "ogg" | "flac";

export type Sniffed = { ok: true; ext: AudioExt } | { ok: false; detected: string };

export const MAX_AUDIO_BYTES = 25_000_000;

/** Mono 16 kHz Opus at 24 kbit/s: what Whisper needs, ~2 hours in 25 MB. */
export const ffmpegCommand = (input: string, output: string) =>
	`ffmpeg -i "${input}" -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k "${output}"`;

export const CONVERT_HINT = `Конвертуйте файл у ogg (заодно стисне: ~2 години вміщаються в 25 МБ): ${ffmpegCommand("ВХІДНИЙ_ФАЙЛ", "РЕЗУЛЬТАТ.ogg")}`;

/** Detects the container from magic bytes, so the file name doesn't matter. */
export function sniffAudio(bytes: Uint8Array): Sniffed {
	const ascii = (offset: number, length: number) =>
		String.fromCharCode(...bytes.subarray(offset, offset + length));

	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { ok: true, ext: "wav" };
	if (ascii(0, 4) === "OggS") return { ok: true, ext: "ogg" };
	if (ascii(0, 4) === "fLaC") return { ok: true, ext: "flac" };
	if (ascii(0, 3) === "ID3") return { ok: true, ext: "mp3" };
	if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
		// MPEG frame sync. Layer bits 00 mean ADTS AAC rather than MP3.
		return (bytes[1] & 0x06) === 0 ? { ok: false, detected: "aac" } : { ok: true, ext: "mp3" };
	}
	if (ascii(4, 4) === "ftyp") return { ok: false, detected: "m4a/mp4/mov" };
	if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
		return { ok: false, detected: "webm/mkv" };
	}
	return { ok: false, detected: "невідомий" };
}
