import { basename } from "node:path";
import type { ConfirmReason } from "../../shared/types.ts";
import { parseShell, unwrap } from "./shell-parse.ts";

// What a command does, as far as permissions go: what must be put to the person every time
// (mustConfirmReason), what only reads, and the prefix "always allow" remembers.

function gitSubcommand(args: string[]): { sub: string | undefined; rest: string[] } {
	let k = 0;
	while (k < args.length && (args[k] as string).startsWith("-")) {
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[k] as string)) k++;
		k++;
	}
	return { sub: args[k], rest: args.slice(k + 1) };
}

/**
 * Whether a `gh api` call only reads. gh sends GET until a field or a body is given, and POST from
 * then on; `--method` overrides both. Anything unclear counts as a call that changes something.
 */
function ghApiReads(args: string[]): boolean {
	let method: string | null = null;
	let sends = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--method" || arg === "-X") method = args[++i] ?? "";
		else if (arg.startsWith("--method=")) method = arg.slice("--method=".length);
		else if (/^-X./.test(arg)) method = arg.slice(2);
		else if (/^--(field|raw-field|input)(=|$)/.test(arg)) sends = true;
		// Short flags written together, such as -iX, or with their value attached, such as -fname=1.
		else if (/^-[^-]/.test(arg) && /[XfF]/.test(arg)) sends = true;
	}
	return method === null ? !sends : method.toUpperCase() === "GET";
}

/** Why an operation must be confirmed every time, or null. Checked on unwrapped commands. */
export function mustConfirmReason(argv: string[]): ConfirmReason | null {
	const name = basename(argv[0] ?? "");
	const args = argv.slice(1);
	const has = (...flags: string[]) => args.some((arg) => flags.includes(arg));
	const hasPrefix = (...prefixes: string[]) =>
		args.some((arg) => prefixes.some((prefix) => arg.startsWith(prefix)));

	if (["rm", "rmdir", "unlink", "shred", "srm", "trash"].includes(name)) return "delete-files";
	// Yew's own command line sends letters and manages keys and the service; sessions use their tools.
	if (name === "yew" || name === "yew") {
		const informational =
			has("--help", "-h") || args.every((arg) => ["--version", "-v", "--json"].includes(arg));
		if (!informational) return "yew-cli";
	}
	if (name === "find" && has("-delete")) return "delete-files";
	if (name === "rsync" && hasPrefix("--delete", "--remove-source-files")) return "delete-files";
	if (name === "git") {
		const { sub, rest } = gitSubcommand(args);
		const restHas = (...flags: string[]) => rest.some((arg) => flags.includes(arg));
		if (sub === "push") return "push";
		if (sub === "init" || sub === "clone") return "git-setup";
		if (
			sub === "remote" &&
			rest.length > 0 &&
			!rest.every((arg) => arg === "-v" || arg === "--verbose" || arg === "show")
		) {
			return "git-setup";
		}
		if (
			sub === "config" &&
			!restHas(
				"--get",
				"--get-all",
				"--get-regexp",
				"--list",
				"-l",
				"--show-origin",
				"--show-scope",
			)
		) {
			return "git-setup";
		}
		if (sub === "reset" && restHas("--hard", "--merge", "--keep")) return "discard-changes";
		if (sub === "clean") return "delete-untracked";
		if (sub === "branch" && restHas("-d", "-D", "--delete")) return "delete-branch";
		if (sub === "tag" && restHas("-d", "--delete")) return "delete-tag";
		if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return "delete-stash";
		if (sub === "checkout" && (restHas("--", ".") || restHas("-f", "--force")))
			return "discard-changes";
		if (sub === "restore" && !restHas("--staged", "-S")) return "discard-changes";
		if (sub === "filter-branch" || sub === "filter-repo") return "rewrite-history";
		if (sub === "update-ref" && restHas("-d")) return "delete-ref";
		if (sub === "worktree" && rest[0] === "remove") return "delete-worktree";
	}
	if (["npm", "pnpm", "yarn", "bun"].includes(name) && args[0] === "publish")
		return "publish-package";
	if (name === "npm" && (args[0] === "unpublish" || args[0] === "deprecate"))
		return "change-package";
	if (["cargo", "poetry", "flit", "hatch"].includes(name) && args[0] === "publish")
		return "publish-package";
	if (name === "gem" && args[0] === "push") return "publish-package";
	if (name === "twine" && args[0] === "upload") return "publish-package";
	if (name === "docker" && (args[0] === "push" || (args[0] === "image" && args[1] === "push"))) {
		return "publish-image";
	}
	if (name === "gh") {
		const action = `${args[0] ?? ""} ${args[1] ?? ""}`;
		if (
			/^(release (create|delete|upload|edit)|repo (delete|create|edit|rename|archive)|pr (merge|close|create)|issue (create|close|delete|comment)|secret (set|delete)|workflow run) /.test(
				`${action} `,
			)
		) {
			return "github";
		}
		if (args[0] === "api" && !ghApiReads(args.slice(1))) return "github";
	}
	if (["ssh", "scp", "sftp", "mosh", "telnet", "ftp", "sshpass"].includes(name)) {
		return "remote-machine";
	}
	if (name === "rsync" && args.some((arg) => /^[^/]*:/.test(arg) && !arg.startsWith("-"))) {
		return "remote-copy";
	}
	if (name === "curl") {
		const sends = args.some(
			(arg, index) =>
				["-d", "-F", "-T", "--form", "--upload-file", "--json"].includes(arg) ||
				arg.startsWith("--data") ||
				arg.startsWith("--form") ||
				(/^-[a-zA-Z]*[dFT]/.test(arg) && !arg.startsWith("--")) ||
				((arg === "-X" || arg === "--request") &&
					/^(POST|PUT|PATCH|DELETE)$/i.test(args[index + 1] ?? "")),
		);
		if (sends) return "send-data";
	}
	if (
		name === "wget" &&
		hasPrefix("--post-data", "--post-file", "--method", "--body-data", "--body-file")
	) {
		return "send-data";
	}
	if (["dd", "mkfs", "fdisk", "parted", "diskutil"].includes(name) || name.startsWith("mkfs.")) {
		return "write-disk";
	}
	if (
		name === "kubectl" &&
		["apply", "delete", "create", "replace", "patch", "scale", "drain", "rollout"].includes(
			args[0] ?? "",
		)
	) {
		return "cluster";
	}
	if (name === "terraform" && ["apply", "destroy", "import"].includes(args[0] ?? "")) {
		return "infrastructure";
	}
	if (["launchctl", "systemctl", "crontab", "shutdown", "reboot", "halt"].includes(name)) {
		return "system-services";
	}
	if (name === "open" && has("-a", "--application")) {
		return "launch-app";
	}
	return null;
}

const SSH_VALUE_FLAGS = new Set([
	"-b",
	"-c",
	"-D",
	"-E",
	"-e",
	"-F",
	"-I",
	"-i",
	"-J",
	"-L",
	"-l",
	"-m",
	"-O",
	"-o",
	"-p",
	"-Q",
	"-R",
	"-S",
	"-W",
	"-w",
]);

/**
 * Extracts a structured target host + remote command summary for SSH/SCP/remote-rsync approval cards
 * so the person immediately sees which remote machine is touched and what command runs there.
 */
export function sshPreview(command: string): string | null {
	const parsed = parseShell(command);
	const lines: string[] = [];
	for (const segment of parsed.segments) {
		const inner = unwrap(segment.argv);
		for (const argv of inner.commands) {
			const name = basename(argv[0] ?? "");
			const args = argv.slice(1);
			if (name === "ssh") {
				let port: string | null = null;
				let user: string | null = null;
				let index = 0;
				while (index < args.length && (args[index] as string).startsWith("-")) {
					const flag = args[index] as string;
					if (flag === "--") {
						index++;
						break;
					}
					if (flag === "-p") port = args[index + 1] ?? null;
					if (flag === "-l") user = args[index + 1] ?? null;
					if (SSH_VALUE_FLAGS.has(flag)) index += 2;
					else index += 1;
				}
				const target = args[index];
				if (!target) continue;
				const fullTarget = user && !target.includes("@") ? `${user}@${target}` : target;
				const remote = args
					.slice(index + 1)
					.join(" ")
					.trim();
				const head = port ? `SSH → ${fullTarget} (port ${port})` : `SSH → ${fullTarget}`;
				lines.push(remote ? `${head}\nRemote command: ${remote}` : head);
			} else if (
				name === "scp" ||
				(name === "rsync" && args.some((a) => /^[^/]*:/.test(a) && !a.startsWith("-")))
			) {
				const endpoints = args.filter((arg) => !arg.startsWith("-"));
				if (endpoints.length >= 2) {
					const dst = endpoints[endpoints.length - 1];
					const src = endpoints.slice(0, -1).join(", ");
					lines.push(`${name.toUpperCase()} → ${src} ⇒ ${dst}`);
				}
			}
		}
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

const READ_ONLY = new Set([
	"ls",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"stat",
	"du",
	"which",
	"whoami",
	"uname",
	"date",
	"echo",
	"printf",
	"realpath",
	"dirname",
	"basename",
	"diff",
	"cmp",
	"jq",
	"rg",
	"grep",
	"egrep",
	"fgrep",
	"cut",
	"tr",
	"sort",
	"tree",
	"find",
	"true",
	"false",
]);

const GIT_READ_ONLY = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"ls-files",
	"blame",
	"describe",
	"shortlog",
	"grep",
	"branch",
	"tag",
	"remote",
]);

/**
 * True when a command only reads. The lists follow Gemini CLI's read-only check (prior-art 4.3) and
 * exclude the options that execute other programs or write files. Paths are checked by the caller.
 */
export function isReadOnly(argv: string[]): boolean {
	const name = argv[0] ?? "";
	const args = argv.slice(1);
	if (name.includes("/")) return false;
	if (args.length === 1 && args[0] === "--version") return true;
	if (!READ_ONLY.has(name) && name !== "git") return false;
	if (name === "find") {
		const writes = [
			"-exec",
			"-execdir",
			"-ok",
			"-okdir",
			"-delete",
			"-fprint",
			"-fprint0",
			"-fprintf",
			"-fls",
		];
		return !args.some((arg) => writes.includes(arg));
	}
	if (name === "rg") return !args.some((arg) => arg.startsWith("--pre"));
	if (name === "sort") return !args.some((arg) => arg === "-o" || arg.startsWith("--output"));
	if (name === "tree") return !args.some((arg) => arg === "-o");
	if (name === "git") {
		if (
			args.some(
				(arg) =>
					arg === "-c" ||
					arg.startsWith("--config") ||
					arg === "-C" ||
					arg.startsWith("--exec-path") ||
					arg.startsWith("--output") ||
					arg.startsWith("--ext-diff"),
			)
		) {
			return false;
		}
		const { sub, rest } = gitSubcommand(args);
		if (!sub || !GIT_READ_ONLY.has(sub)) return false;
		if (sub === "branch")
			return rest.every((arg) =>
				["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"].includes(arg),
			);
		if (sub === "tag") return rest.every((arg) => ["-l", "--list"].includes(arg));
		if (sub === "remote") return rest.every((arg) => arg === "-v");
		return true;
	}
	return true;
}

/** Arguments that look like paths, which the caller keeps inside the working folder. */
export function pathArguments(argv: string[]): string[] {
	return argv
		.slice(1)
		.filter(
			(arg) =>
				!arg.startsWith("-") &&
				(arg.includes("/") || arg.startsWith("~") || arg === ".." || arg.startsWith(".")),
		);
}

const MULTI_WORD = new Set([
	"git",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"cargo",
	"go",
	"docker",
	"kubectl",
	"gh",
	"brew",
	"pip",
	"pip3",
	"uv",
	"poetry",
	"make",
	"just",
	"dotnet",
	"mvn",
	"gradle",
	"swift",
	"deno",
]);
const THIRD_WORD: Record<string, string[]> = {
	npm: ["run", "exec", "x"],
	pnpm: ["run", "exec", "dlx"],
	yarn: ["run", "dlx"],
	bun: ["run", "x"],
	uv: ["run", "pip"],
	poetry: ["run"],
	go: ["run", "test"],
	deno: ["run", "task"],
};
const INTERPRETERS = new Set([
	"node",
	"python",
	"python3",
	"ruby",
	"perl",
	"php",
	"bash",
	"sh",
	"zsh",
	"osascript",
	"tsx",
	"ts-node",
]);

/**
 * The prefix "allow and remember" stores, after OpenCode's arity table (prior-art 4.3): `git status`,
 * `npm run build`. Interpreters store the whole command, since their first word allows anything.
 */
export function rememberPrefix(argv: string[]): string {
	const name = argv[0] ?? "";
	if (INTERPRETERS.has(name)) return argv.join(" ");
	if (!MULTI_WORD.has(name)) return name;
	const second = argv.slice(1).find((arg) => !arg.startsWith("-"));
	if (!second) return name;
	const index = argv.indexOf(second);
	const third = argv.slice(index + 1).find((arg) => !arg.startsWith("-"));
	if (third && THIRD_WORD[name]?.includes(second)) return `${name} ${second} ${third}`;
	return `${name} ${second}`;
}

/** Word-wise prefix match: the rule `npm run build` matches `npm run build --watch`, not `npm run builder`. */
export function matchesPrefix(argv: string[], pattern: string): boolean {
	const words = pattern
		.trim()
		.replace(/\s+\*$/, "")
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) return true;
	return words.every((word, index) => argv[index] === word);
}
