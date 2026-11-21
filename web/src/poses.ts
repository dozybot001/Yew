/**
 * The mascot's poses. Each is `web/public/mascot/<pose>.webp`, all on the
 * same 373 by 400 canvas, so changing the pose in a place never makes it jump. A new pose joins
 * this list.
 */
export const MASCOT_POSES = [
	"greeting",
	"thinking",
	"happy",
	"sleepy",
	"writing",
	"shush",
	"sorry",
	"waking",
	"gift",
	"lost",
	"stamp",
	"pointing",
	"letter-run",
	"reading",
	"typing",
	"clipboard",
	"magnifier",
	"alarm",
	"phone",
	"giftbox",
	"bow",
	"jump",
	"tea",
	"stretch",
	"peek",
	"nap",
	"paper-plane",
	"books",
	"branch",
	"mini",
	"pajamas",
	"halt",
	"surprised",
	"pout",
	"proud",
	"teary",
	"fired-up",
	"dozing",
	"permission",
	"on-duty",
] as const;

export type MascotPose = (typeof MASCOT_POSES)[number];
