/**
 * Lightweight Markdown editing helpers for the message composer: list continuation on Shift+Enter,
 * list indentation on Tab / Shift+Tab, and detection for showing the inline Markdown preview toggle.
 */

export interface TextEdit {
	value: string;
	caret: number;
}

const TASK_LIST = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/;
const BULLET_LIST = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_LIST = /^(\s*)(\d+)([.)])\s+(.*)$/;

/**
 * When the cursor sits at the end of (or inside) a Markdown list item and the person presses
 * Shift+Enter, continues the list on the next line (incrementing numbered items). Pressing
 * Shift+Enter on an empty list item clears the marker instead.
 */
export function continueMarkdownList(value: string, start: number, end: number): TextEdit | null {
	if (start !== end) return null;
	const lineStart = value.lastIndexOf("\n", start - 1) + 1;
	const beforeCaret = value.slice(lineStart, start);
	const afterCaret = value.slice(start);

	const task = TASK_LIST.exec(beforeCaret);
	if (task) {
		const [, indent = "", bullet = "-", , rest = ""] = task;
		if (!rest.trim() && (afterCaret === "" || afterCaret.startsWith("\n"))) {
			return { value: value.slice(0, lineStart) + afterCaret, caret: lineStart };
		}
		const insert = `\n${indent}${bullet} [ ] `;
		return {
			value: value.slice(0, start) + insert + afterCaret,
			caret: start + insert.length,
		};
	}

	const ordered = ORDERED_LIST.exec(beforeCaret);
	if (ordered) {
		const [, indent = "", digits = "1", punct = ".", rest = ""] = ordered;
		if (!rest.trim() && (afterCaret === "" || afterCaret.startsWith("\n"))) {
			return { value: value.slice(0, lineStart) + afterCaret, caret: lineStart };
		}
		const next = Number.parseInt(digits, 10) + 1;
		const insert = `\n${indent}${next}${punct} `;
		return {
			value: value.slice(0, start) + insert + afterCaret,
			caret: start + insert.length,
		};
	}

	const bullet = BULLET_LIST.exec(beforeCaret);
	if (bullet) {
		const [, indent = "", mark = "-", rest = ""] = bullet;
		if (!rest.trim() && (afterCaret === "" || afterCaret.startsWith("\n"))) {
			return { value: value.slice(0, lineStart) + afterCaret, caret: lineStart };
		}
		const insert = `\n${indent}${mark} `;
		return {
			value: value.slice(0, start) + insert + afterCaret,
			caret: start + insert.length,
		};
	}

	return null;
}

/** Indents or outdents the current Markdown list line by two spaces when pressing Tab / Shift+Tab. */
export function indentMarkdownList(
	value: string,
	start: number,
	end: number,
	outdent: boolean,
): TextEdit | null {
	if (start !== end) return null;
	const lineStart = value.lastIndexOf("\n", start - 1) + 1;
	const lineEnd = value.indexOf("\n", start);
	const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
	if (!TASK_LIST.test(line) && !ORDERED_LIST.test(line) && !BULLET_LIST.test(line)) {
		return null;
	}
	if (outdent) {
		const match = /^( {1,2}|\t)/.exec(line);
		if (!match) return null;
		const removed = match[0].length;
		return {
			value: value.slice(0, lineStart) + value.slice(lineStart + removed),
			caret: Math.max(lineStart, start - removed),
		};
	}
	return {
		value: `${value.slice(0, lineStart)}  ${value.slice(lineStart)}`,
		caret: start + 2,
	};
}
