import type { MascotPose } from "../poses.ts";
import { useAppState } from "../state.ts";

/**
 * Yew herself: the red-haired girl with a yew-berry hair ornament, in the
 * poses listed in `poses.ts`. She only decorates: screen readers skip her and she never covers a
 * control. With 「界面里的 Yew」 off in the settings she is left out everywhere this draws her.
 */
const WIDTH = 373;
const HEIGHT = 400;

export function Mascot({
	pose,
	height,
	className,
}: {
	pose: MascotPose;
	height: number;
	className?: string;
}) {
	// Before the settings arrive (signing in, a failed start) she shows, as by default.
	const hidden = useAppState((state) => state.settings?.mascot === false);
	if (hidden) return null;
	return (
		<img
			className={`mascot${className ? ` ${className}` : ""}`}
			src={`/mascot/${pose}.webp`}
			width={Math.round((height * WIDTH) / HEIGHT)}
			height={height}
			alt=""
			draggable={false}
		/>
	);
}
