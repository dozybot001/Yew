import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Expands `~` and resolves against the working folder. Returns null for a relative path without one. */
export function resolvePath(input: string, cwd: string | null): string | null {
	const expanded =
		input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
	if (isAbsolute(expanded)) return canonical(resolve(expanded));
	if (!cwd) return null;
	return canonical(resolve(cwd, expanded));
}

/** Resolves symlinks in the longest existing part of the path, so a link cannot lead out of a folder unnoticed. */
export function canonical(path: string): string {
	let existing = path;
	const missing: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return path;
		missing.unshift(basename(existing));
		existing = parent;
	}
	try {
		return join(realpathSync(existing), ...missing);
	} catch {
		return path;
	}
}

export function isInside(path: string, folder: string): boolean {
	if (path === folder) return true;
	const rel = relative(folder, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Places that hold credentials. Sessions never read or write them through file tools. */
export function secretLocations(yewHome: string): string[] {
	const home = homedir();
	return [
		yewHome,
		join(home, ".ssh"),
		join(home, ".gnupg"),
		join(home, ".aws"),
		join(home, ".azure"),
		join(home, ".kube"),
		join(home, ".docker"),
		join(home, ".config", "gcloud"),
		join(home, ".config", "gh"),
		join(home, ".netrc"),
		join(home, ".npmrc"),
		join(home, ".pypirc"),
		join(home, ".git-credentials"),
		join(home, "Library", "Keychains"),
	].map(canonical);
}

export function isSecretPath(path: string, secrets: string[]): boolean {
	return secrets.some((secret) => isInside(path, secret));
}

/** Converts a path glob (`*`, `**`, `?`) to a regular expression over absolute paths. */
export function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] as string;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				const slash = glob[i + 2] === "/";
				pattern += slash ? "(?:.*/)?" : ".*";
				i += slash ? 2 : 1;
			} else {
				pattern += "[^/]*";
			}
		} else if (c === "?") {
			pattern += "[^/]";
		} else {
			pattern += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
}

/** Matches a rule's path pattern; relative patterns are relative to the working folder. */
export function pathMatches(path: string, pattern: string, cwd: string | null): boolean {
	const absolute = resolvePath(pattern, cwd);
	if (!absolute) return false;
	if (!/[*?]/.test(pattern)) return isInside(path, absolute);
	const base = pattern.startsWith("~") || isAbsolute(pattern) ? absolute : join(cwd ?? "", pattern);
	return globToRegExp(base.split(sep).join("/")).test(path.split(sep).join("/"));
}
