export const OUTPUT_FORMATS = ["text", "timestamped", "srt", "vtt", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface Segment {
	start: number;
	end: number;
	text: string;
}

export interface Transcript {
	text: string;
	language: string | null;
	duration: number | null;
	segments: Segment[];
}

export interface Rendered {
	body: string;
	contentType: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 83.5 -> "00:01:23" or, with a separator, "00:01:23,500". */
export function clock(seconds: number, msSeparator?: "," | "."): string {
	const totalMs = Math.max(0, Math.round(seconds * 1000));
	const h = Math.floor(totalMs / 3_600_000);
	const m = Math.floor((totalMs % 3_600_000) / 60_000);
	const s = Math.floor((totalMs % 60_000) / 1000);
	const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
	return msSeparator ? `${base}${msSeparator}${pad(totalMs % 1000, 3)}` : base;
}

export function render(t: Transcript, format: OutputFormat): Rendered {
	const plain = "text/plain; charset=utf-8";
	switch (format) {
		case "text":
			return { body: t.text, contentType: plain };
		case "timestamped":
			return {
				body: t.segments.map((s) => `[${clock(s.start)}] ${s.text}`).join("\n"),
				contentType: plain,
			};
		case "srt":
			return {
				body: t.segments
					.map((s, i) => `${i + 1}\n${clock(s.start, ",")} --> ${clock(s.end, ",")}\n${s.text}\n`)
					.join("\n"),
				contentType: "application/x-subrip; charset=utf-8",
			};
		case "vtt":
			return {
				body: `WEBVTT\n\n${t.segments
					.map((s) => `${clock(s.start, ".")} --> ${clock(s.end, ".")}\n${s.text}\n`)
					.join("\n")}`,
				contentType: "text/vtt; charset=utf-8",
			};
		case "json":
			return { body: JSON.stringify(t, null, 2), contentType: "application/json; charset=utf-8" };
	}
}
