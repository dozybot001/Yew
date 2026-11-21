import { styleText } from "node:util";

export interface OutStream {
	write(chunk: string): unknown;
	isTTY?: boolean;
}

export interface InStream extends AsyncIterable<string | Buffer> {
	isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
}

/** Everything a command touches outside its arguments, so tests can swap it out. */
export interface CliIo {
	stdout: OutStream;
	stderr: OutStream;
	stdin: InStream;
	env: Record<string, string | undefined>;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** Thrown for bad arguments; the runner prints it with a pointer to --help and exits with 2. */
export class UsageError extends Error {}

/** clig.dev: no ANSI colors when NO_COLOR is non-empty or the stream is not a terminal. */
export function wantsColor(stream: OutStream, env: CliIo["env"]): boolean {
	if (env.NO_COLOR) return false;
	if (env.TERM === "dumb") return false;
	return stream.isTTY === true;
}

/**
 * Reads a secret. On a terminal it prompts on stderr and reads without echo; otherwise it reads all of
 * standard input, so `pbpaste | yew key set deepseek` works. Never takes the secret from arguments.
 */
export async function readSecret(io: CliIo, prompt: string): Promise<string> {
	const stdin = io.stdin;
	if (!stdin.isTTY || !stdin.setRawMode) {
		let data = "";
		for await (const chunk of stdin) data += chunk.toString();
		return data.trim();
	}
	io.stderr.write(prompt);
	stdin.setRawMode(true);
	let value = "";
	try {
		for await (const chunk of stdin) {
			for (const char of chunk.toString()) {
				if (char === "\r" || char === "\n") {
					io.stderr.write("\n");
					return value.trim();
				}
				if (char === "\u0003" || char === "\u0004") {
					io.stderr.write("\n");
					throw new Error("Cancelled.");
				}
				if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
				else value += char;
			}
		}
		return value.trim();
	} finally {
		stdin.setRawMode(false);
	}
}

/** Asks a yes/no question on a terminal; anything but y or yes means no. */
export async function confirm(io: CliIo, question: string): Promise<boolean> {
	io.stderr.write(`${question} [y/N] `);
	for await (const chunk of io.stdin) {
		const answer = chunk.toString().split(/\r?\n/)[0]?.trim().toLowerCase() ?? "";
		return answer === "y" || answer === "yes";
	}
	return false;
}

export function paint(
	format: Parameters<typeof styleText>[0],
	text: string,
	stream: OutStream,
	env: CliIo["env"],
): string {
	return wantsColor(stream, env) ? styleText(format, text, { validateStream: false }) : text;
}
