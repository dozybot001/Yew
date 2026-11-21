import { basename } from "node:path";

/**
 * A small, conservative shell parser for permission checks. It does not try to understand every
 * shell feature: anything it cannot follow is reported as not understood, and the caller then asks
 * the person instead of deciding.
 */

export interface Redirect {
	op: string;
	target: string;
}

export interface Segment {
	/** Words with quotes removed. Words containing an expansion keep the `$` text. */
	argv: string[];
	redirects: Redirect[];
	/** Contains `$VAR`, `$(...)`, backticks or process substitution, so the real arguments are unknown. */
	dynamic: boolean;
}

export interface ParsedCommand {
	segments: Segment[];
	/** False when the parser met something it does not follow; `reason` says what. */
	understood: boolean;
	reason?: string;
}

const OPERATOR_CHARS = new Set(["&", "|", ";", "\n"]);

/**
 * `$(cat <<'EOF' … EOF)`: a way to write a long literal argument (a commit message, say). With a
 * quoted delimiter nothing in the text is expanded and `cat` only hands it back, so it is the text.
 */
const LITERAL_TEXT =
	/^\$\(\s*cat\s*<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*\)/;

interface HereDocument {
	delimiter: string;
	/** `<<-`: leading tabs are removed from every line, the closing one too. */
	stripTabs: boolean;
	/** With a quoted delimiter the text is taken as written; otherwise `$…` and backticks in it run. */
	literal: boolean;
}

export function parseShell(command: string): ParsedCommand {
	const segments: Segment[] = [];
	let segment: Segment = { argv: [], redirects: [], dynamic: false };
	let word = "";
	let inWord = false;
	let pendingRedirect: string | null = null;
	let reason: string | undefined;
	/** Here-documents opened on the current line; their text starts on the next one. */
	const opened: HereDocument[] = [];

	const fail = (why: string) => {
		reason ??= why;
	};
	const endWord = () => {
		if (!inWord) return;
		if (pendingRedirect) {
			segment.redirects.push({ op: pendingRedirect, target: word });
			pendingRedirect = null;
		} else {
			segment.argv.push(word);
		}
		word = "";
		inWord = false;
	};
	const endSegment = () => {
		endWord();
		if (pendingRedirect) fail("a redirect without a target");
		if (segment.argv.length > 0 || segment.redirects.length > 0) segments.push(segment);
		segment = { argv: [], redirects: [], dynamic: false };
	};

	let i = 0;
	while (i < command.length) {
		const c = command[i] as string;
		const next = command[i + 1];

		if (c === "\\") {
			if (next === "\n") {
				i += 2;
				continue;
			}
			if (next !== undefined) word += next;
			inWord = true;
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end < 0) {
				fail("an unclosed single quote");
				break;
			}
			word += command.slice(i + 1, end);
			inWord = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let closed = false;
			while (j < command.length) {
				const d = command[j] as string;
				if (d === "\\" && j + 1 < command.length) {
					const escaped = command[j + 1] as string;
					word += '"\\$`'.includes(escaped) ? escaped : `\\${escaped}`;
					j += 2;
					continue;
				}
				if (d === '"') {
					closed = true;
					break;
				}
				if (d === "$") {
					const literal = LITERAL_TEXT.exec(command.slice(j));
					if (literal) {
						word += literal[3];
						j += literal[0].length;
						continue;
					}
				}
				if (d === "$" || d === "`") segment.dynamic = true;
				word += d;
				j++;
			}
			if (!closed) {
				fail("an unclosed double quote");
				break;
			}
			inWord = true;
			i = j + 1;
			continue;
		}
		if (c === "$") {
			const literal = LITERAL_TEXT.exec(command.slice(i));
			if (literal) {
				word += literal[3];
				inWord = true;
				i += literal[0].length;
				continue;
			}
		}
		if (c === "$" || c === "`") {
			segment.dynamic = true;
			word += c;
			inWord = true;
			i++;
			continue;
		}
		if (c === "#" && !inWord) {
			const end = command.indexOf("\n", i);
			i = end < 0 ? command.length : end;
			continue;
		}
		if (c === " " || c === "\t") {
			endWord();
			i++;
			continue;
		}
		if (c === "(" || c === ")" || c === "{" || c === "}") {
			if (c === "{" || c === "}") {
				// Braces inside a word (`a{b,c}` or `${x}`) are fine; on their own they start a group.
				if (inWord) {
					word += c;
					i++;
					continue;
				}
			}
			fail("a subshell or command group");
			word += c;
			inWord = true;
			i++;
			continue;
		}
		if (c === "<" || c === ">") {
			if (c === "<" && next === "<" && command[i + 2] === "<") {
				// A here-string: the next word is the command's input.
				endWord();
				pendingRedirect = "<<<";
				i += 3;
				continue;
			}
			if (c === "<" && next === "<") {
				// A here-document: the lines after this one, up to the delimiter, are the command's input.
				endWord();
				i += 2;
				const stripTabs = command[i] === "-";
				if (stripTabs) i++;
				while (command[i] === " " || command[i] === "\t") i++;
				const start = i;
				while (i < command.length && !/[\s;&|<>()]/.test(command[i] as string)) i++;
				const raw = command.slice(start, i);
				const delimiter = raw.replace(/['"\\]/g, "");
				if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(delimiter)) {
					fail("a here-document");
					continue;
				}
				opened.push({ delimiter, stripTabs, literal: raw !== delimiter });
				continue;
			}
			if (next === "(") {
				segment.dynamic = true;
				fail("process substitution");
				i += 2;
				continue;
			}
			// A word made only of digits right before the operator is a file descriptor: 2>, 1>>.
			let op = "";
			if (inWord && /^\d+$/.test(word)) {
				op = word;
				word = "";
				inWord = false;
			} else {
				endWord();
			}
			op += c;
			i++;
			if (command[i] === c) {
				op += c;
				i++;
			}
			if (command[i] === "&") {
				op += "&";
				i++;
			}
			pendingRedirect = op;
			continue;
		}
		if (c === "&" && next === ">") {
			endWord();
			let op = "&>";
			i += 2;
			if (command[i] === ">") {
				op += ">";
				i++;
			}
			pendingRedirect = op;
			continue;
		}
		if (c === "\n" && opened.length > 0) {
			// The text of each here-document is input, not commands: step over it.
			let at = i + 1;
			for (const doc of opened) {
				let closed = false;
				let text = "";
				while (at <= command.length) {
					const end = command.indexOf("\n", at);
					const line = command.slice(at, end < 0 ? command.length : end);
					at = end < 0 ? command.length + 1 : end + 1;
					if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
						closed = true;
						break;
					}
					text += `${line}\n`;
				}
				if (!closed) fail("an unclosed here-document");
				else if (!doc.literal && /[$`]/.test(text)) fail("a here-document that runs commands");
			}
			opened.length = 0;
			endSegment();
			i = Math.min(at, command.length);
			continue;
		}
		if (OPERATOR_CHARS.has(c)) {
			endSegment();
			if ((c === "&" || c === "|") && next === c) i += 2;
			else if (c === "|" && next === "&") i += 2;
			else i++;
			continue;
		}
		word += c;
		inWord = true;
		i++;
	}
	endSegment();
	if (opened.length > 0) fail("an unclosed here-document");
	return reason ? { segments, understood: false, reason } : { segments, understood: true };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

export interface Unwrapped {
	commands: string[][];
	/** Wrappers that matter by themselves, such as sudo. */
	privileged: boolean;
	understood: boolean;
}

/**
 * Peels wrappers off a command so the real program is checked: `sudo`, `env VAR=x`, `exec`,
 * `nohup`, `time`, `nice`, `timeout`, `xargs`, and `bash -c '...'` or `eval '...'`, whose string is
 * parsed again. Stops after four levels (prior-art 4.3, after Kimi Code's dangerous-command check).
 */
export function unwrap(argv: string[], depth = 0): Unwrapped {
	if (depth > 4) return { commands: [argv], privileged: false, understood: false };
	let args = [...argv];
	while (args.length > 0 && ASSIGNMENT.test(args[0] as string)) args = args.slice(1);
	const name = basename(args[0] ?? "");
	const rest = args.slice(1);

	const skipOptions = (list: string[], withValue: Set<string> = new Set()) => {
		let k = 0;
		while (k < list.length && (list[k] as string).startsWith("-")) {
			if (withValue.has(list[k] as string)) k++;
			k++;
		}
		return list.slice(k);
	};

	if (name === "sudo" || name === "doas") {
		const inner = unwrap(
			skipOptions(rest, new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t"])),
			depth + 1,
		);
		return { ...inner, privileged: true };
	}
	if (name === "env") {
		let inner = skipOptions(rest, new Set(["-u", "-C", "-S"]));
		while (inner.length > 0 && ASSIGNMENT.test(inner[0] as string)) inner = inner.slice(1);
		return inner.length
			? unwrap(inner, depth + 1)
			: { commands: [args], privileged: false, understood: true };
	}
	if (
		name === "exec" ||
		name === "command" ||
		name === "nohup" ||
		name === "time" ||
		name === "builtin"
	) {
		return rest.length
			? unwrap(skipOptions(rest), depth + 1)
			: { commands: [args], privileged: false, understood: true };
	}
	if (name === "nice") return unwrap(skipOptions(rest, new Set(["-n"])), depth + 1);
	if (name === "timeout") {
		const inner = skipOptions(rest, new Set(["-s", "-k", "--signal", "--kill-after"]));
		return unwrap(inner.slice(1), depth + 1);
	}
	if (name === "xargs") {
		const inner = skipOptions(rest, new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E"]));
		return inner.length
			? unwrap(inner, depth + 1)
			: { commands: [["echo"]], privileged: false, understood: true };
	}
	if (SHELLS.has(name) && !rest.includes("-c") && rest.every((arg) => arg.startsWith("-"))) {
		// A shell with no script named reads its commands from its input (a pipe, a here-document):
		// commands Yew has not read.
		return { commands: [args], privileged: false, understood: false };
	}
	if ((SHELLS.has(name) && rest.includes("-c")) || name === "eval") {
		const script = name === "eval" ? rest.join(" ") : rest[rest.indexOf("-c") + 1];
		if (script === undefined) return { commands: [args], privileged: false, understood: false };
		const parsed = parseShell(script);
		const commands: string[][] = [];
		let privileged = false;
		let understood = parsed.understood;
		for (const segment of parsed.segments) {
			if (segment.dynamic) understood = false;
			const inner = unwrap(segment.argv, depth + 1);
			commands.push(...inner.commands);
			privileged ||= inner.privileged;
			understood &&= inner.understood;
		}
		return { commands, privileged, understood };
	}
	return { commands: [args], privileged: false, understood: true };
}
