import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { UnsentTexts } from "./unsent.ts";

const unsent = new UnsentTexts({
	read: async (place) => (await api<{ text: string }>("GET", `/api/unsent/${place}`)).text,
	write: (place, text, leaving) =>
		api("PUT", `/api/unsent/${place}`, { text }, { keepalive: leaving }),
});

window.addEventListener("pagehide", () => unsent.flushAll(true));

/**
 * A message box's text, kept by Yew while it is not sent, so it is still there when the page comes
 * back. `place` is a session's id, or "home" for the box on the home page.
 */
export function useUnsent(place: string): [string, (text: string) => void] {
	const [text, setText] = useState(() => unsent.known(place));
	useEffect(() => {
		let gone = false;
		setText(unsent.known(place));
		void unsent.load(place).then((saved) => {
			if (!gone && saved !== null) setText(saved);
		});
		return () => {
			gone = true;
			unsent.flush(place);
		};
	}, [place]);
	const change = useCallback(
		(next: string) => {
			setText(next);
			unsent.keep(place, next);
		},
		[place],
	);
	return [text, change];
}
