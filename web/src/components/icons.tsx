import {
	Activity,
	Archive,
	ArrowUp,
	Ban,
	BookOpen,
	ChartColumn,
	Check,
	CheckCheck,
	ChevronLeft,
	ChevronRight,
	Circle,
	CircleCheck,
	CircleDashed,
	CircleDot,
	Clock,
	Code,
	Copy,
	Database,
	Download,
	Ellipsis,
	FileText,
	Folder,
	FolderPlus,
	Inbox,
	Info,
	KeyRound,
	Languages,
	ListCollapse,
	ListTodo,
	LogIn,
	LogOut,
	Mail,
	Menu,
	MessageCircle,
	MessageCircleQuestion,
	MessagesSquare,
	Minimize2,
	Network,
	PanelLeftClose,
	PanelLeftOpen,
	Paperclip,
	PencilLine,
	Pin,
	Play,
	Plug,
	Plus,
	Power,
	RefreshCw,
	RotateCcw,
	ScrollText,
	Search,
	Send,
	Settings,
	ShieldAlert,
	SlidersHorizontal,
	Smartphone,
	Smile,
	Split,
	Square,
	SquarePen,
	Stamp,
	SunMoon,
	Trash2,
	Undo2,
	UserRoundPlus,
	Users,
	X,
} from "lucide-react";

/**
 * Yew's icons come from one set, Lucide (ISC licence): rounded line icons drawn on the same grid, so
 * every screen looks alike. 16 px with a 1.75 stroke; decorative, since the buttons carry the names.
 */
const props = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

/** Attach files or images to a message. */
export const AttachIcon = () => <Paperclip {...props} />;
export const PlusIcon = () => <Plus {...props} />;
/** MCP servers: tools plugged into Yew. */
export const ToolsIcon = () => <Plug {...props} />;
/** Skills: written instructions a session reads. */
export const SkillsIcon = () => <BookOpen {...props} />;
/** Starting Yew at login and from the launcher icon. */
export const PowerIcon = () => <Power {...props} />;
export const FolderIcon = () => <Folder {...props} />;
export const GearIcon = () => <Settings {...props} />;
export const MenuIcon = () => <Menu {...props} />;
export const CodeIcon = () => <Code {...props} />;
export const NotesIcon = () => <FileText {...props} />;
export const ChatIcon = () => <MessageCircle {...props} />;
export const ArrowUpIcon = () => <ArrowUp {...props} strokeWidth={2} />;
export const StopIcon = () => <Square {...props} fill="currentColor" />;
export const SearchIcon = () => <Search {...props} />;
export const ChevronIcon = () => <ChevronRight {...props} size={14} className="chevron" />;
/** Back to the list, where a narrow window shows one level at a time. */
export const BackIcon = () => <ChevronLeft {...props} />;
/** Marks a menu item that opens a submenu. */
export const SubmenuIcon = () => <ChevronRight {...props} size={14} className="menu-arrow" />;
export const PinIcon = () => <Pin {...props} size={13} className="pin-icon" />;
/** Make the context smaller. */
export const CompactIcon = () => <Minimize2 {...props} />;
/** Start a fresh context window while keeping history above. */
export const RenewIcon = () => <RefreshCw {...props} />;
export const PlayIcon = () => <Play {...props} />;
export const InfoIcon = () => <Info {...props} />;
export const CloseIcon = () => <X {...props} />;
export const ComposeIcon = () => <SquarePen {...props} />;
export const KeyIcon = () => <KeyRound {...props} />;
export const ShieldIcon = () => <ShieldAlert {...props} />;
export const QuestionIcon = () => <MessageCircleQuestion {...props} />;
export const SlidersIcon = () => <SlidersHorizontal {...props} />;
export const PhoneIcon = () => <Smartphone {...props} />;
export const MailIcon = () => <Mail {...props} />;
/** The approval center: everything waiting for the person. */
export const CenterIcon = () => <Inbox {...props} />;
/** Scheduled tasks: letters Yew sends at set times. */
export const ScheduleIcon = () => <Clock {...props} />;
/** What sessions saved for the person to look at. */
export const ArtifactIcon = () => <FileText {...props} />;
/** What sessions cost, day by day. */
export const UsageIcon = () => <ChartColumn {...props} />;
/** The sessions map: who opened whom and who writes to whom. */
export const MapIcon = () => <Network {...props} />;
/** The main conversation, where the person usually works. */
export const MainIcon = () => <MessagesSquare {...props} />;
/** A team in the person's organization. */
export const TeamIcon = () => <Users {...props} />;
/** The sessions in no team, listed after the teams. */
export const NoTeamIcon = () => <CircleDashed {...props} />;
/** The sidebar entry that holds the pages opened less often. */
export const MoreIcon = () => <Ellipsis {...props} />;
/** New team, new workspace and new session look different where they stand side by side (the rail). */
export const NewTeamIcon = () => <UserRoundPlus {...props} />;
export const NewWorkspaceIcon = () => <FolderPlus {...props} />;
/** Actions on cards: send an answer or decision, allow, allow always, refuse. */
export const SendIcon = () => <Send {...props} />;
export const CheckIcon = () => <Check {...props} />;
export const CheckAllIcon = () => <CheckCheck {...props} />;
export const RefuseIcon = () => <Ban {...props} />;
export const ThemeIcon = () => <SunMoon {...props} />;
export const LanguageIcon = () => <Languages {...props} />;
/** Yew in the interface (floating, the opening and the rest), shown or hidden in the settings. */
export const MascotIcon = () => <Smile {...props} />;
/** Yew's data on this computer. */
export const DataIcon = () => <Database {...props} />;
/** The session menu: pin, rename, copy, export, archive. */
export const MenuPinIcon = () => <Pin {...props} />;
export const RenameIcon = () => <PencilLine {...props} />;
export const CopyIcon = () => <Copy {...props} />;
export const ExportIcon = () => <Download {...props} />;
export const ArchiveIcon = () => <Archive {...props} />;
/** A decision the person made. */
export const DecisionIcon = () => <Stamp {...props} />;
export const CollapseIcon = () => <PanelLeftClose {...props} />;
export const ExpandIcon = () => <PanelLeftOpen {...props} />;
export const TodoIcon = () => <ListTodo {...props} />;
/** Task states in the task list: to do, under way, done. */
export const TodoPendingIcon = () => <Circle {...props} size={14} />;
export const TodoActiveIcon = () => <CircleDot {...props} size={14} />;
export const TodoDoneIcon = () => <CircleCheck {...props} size={14} />;

/**
 * Yew's mark (blueprint, section 12): a yew berry, red with its dark green seed, and one leaf. The
 * berry and the seed keep their colours; the leaf is the theme's mark ink.
 */
export function YewMark({ className, size }: { className?: string; size: number }) {
	return (
		<svg className={className} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
			<path
				className="mark-leaf"
				d="M35.4 50.2C36.6 37.6 42.6 22.6 60 12.6C58.6 24.4 55.2 32.4 49.4 38.6C45 43.3 39.4 46.4 35.4 50.2Z"
			/>
			<ellipse cx="19.8" cy="35.4" rx="15.9" ry="15.4" fill="#C8323F" />
			<ellipse
				cx="25.8"
				cy="22.6"
				rx="4.6"
				ry="3.1"
				transform="rotate(12 25.8 22.6)"
				fill="#1F3A2E"
			/>
		</svg>
	);
}

/** Yew's wordmark: "Yew" outlined from Young Serif (SIL OFL 1.1), one em high, in the mark ink. */
const WORDMARK =
	"M769 -750Q784 -750 784 -735V-705Q784 -690 769 -690Q736 -690 704.5 -667Q673 -644 644 -594L490 -333Q485 -326 485 -314V-155Q485 -115 499.5 -87.5Q514 -60 552 -60H559Q574 -60 574 -45V-15Q574 0 559 0H251Q236 0 236 -15V-45Q236 -60 251 -60H257Q295 -60 310 -87.5Q325 -115 325 -155V-309Q325 -318 319 -327L139 -594Q105 -644 81 -667Q57 -690 25 -690Q10 -690 10 -705V-735Q10 -750 25 -750H372Q387 -750 387 -735V-705Q387 -690 372 -690Q345 -690 323.5 -679.5Q302 -669 302 -643Q302 -622 319 -594L436 -407L544 -594Q566 -634 566 -657Q566 -690 520 -690Q505 -690 505 -705V-735Q505 -750 520 -750ZM829 -179Q846 -137 883.5 -104Q921 -71 979 -71Q1011 -71 1046 -89Q1081 -107 1107 -145Q1110 -150 1115 -150Q1120 -150 1125.5 -147Q1131 -144 1155 -130Q1159 -127 1159 -122Q1159 -115 1153 -105Q1125 -53 1077 -20Q1029 13 952 13Q869 13 809 -24Q749 -61 716.5 -122Q684 -183 684 -255Q684 -324 704.5 -373.5Q725 -423 759 -453.5Q793 -484 835.5 -498.5Q878 -513 922 -513Q972 -513 1010 -493.5Q1048 -474 1074.5 -444Q1101 -414 1114.5 -380.5Q1128 -347 1128 -318Q1128 -310 1119 -306ZM978 -322Q978 -370 955 -401Q932 -432 897 -432Q856 -432 832 -399.5Q808 -367 808 -318Q808 -303 809.5 -281Q811 -259 817 -241ZM2070 -500Q2085 -500 2085 -485V-455Q2085 -440 2070 -440H2055Q2039 -440 2026.5 -428Q2014 -416 1997 -378L1838 -11Q1834 0 1823 0H1766Q1755 0 1750 -11L1618 -317L1486 -11Q1482 0 1470 0H1414Q1403 0 1398 -11L1240 -377Q1224 -415 1213 -427.5Q1202 -440 1182 -440H1180Q1165 -440 1165 -455V-485Q1165 -500 1180 -500H1411Q1426 -500 1426 -485V-455Q1426 -440 1411 -440H1409Q1390 -440 1382.5 -432.5Q1375 -425 1375 -411Q1375 -398 1381.5 -381Q1388 -364 1396 -345L1476 -158L1562 -371Q1575 -401 1575 -419Q1575 -440 1554 -440H1532Q1519 -440 1519 -455V-485Q1519 -500 1533 -500H1773Q1788 -500 1788 -485V-455Q1788 -440 1773 -440H1761Q1742 -440 1734.5 -432.5Q1727 -425 1727 -411Q1727 -398 1733 -381Q1739 -364 1747 -345L1828 -158L1914 -371Q1927 -401 1927 -419Q1927 -440 1906 -440H1886Q1871 -440 1871 -455V-485Q1871 -500 1886 -500Z";

export function YewWordmark({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 -840 2091 1000" aria-hidden="true">
			<path d={WORDMARK} />
		</svg>
	);
}

/**
 * The product's name where the lockup shows it (blueprint, section 12): the "Yew" wordmark with a
 * smaller "Harness" after it on the same baseline. Single "Yew" is the red-haired girl's name.
 */
export function ProductName({ className }: { className?: string }) {
	return (
		<span className={`product-name${className ? ` ${className}` : ""}`} aria-hidden="true">
			<YewWordmark className="wordmark" />
			<span className="product-harness">Harness</span>
		</span>
	);
}
/** Delete or remove for good. */
export const TrashIcon = () => <Trash2 {...props} />;
/** Test a connection: is it alive, and how fast. */
export const PulseIcon = () => <Activity {...props} />;
/** Try again, or put back the original value. */
export const RetryIcon = () => <RotateCcw {...props} />;
/** Fork: a new session that goes on from one reply. */
export const ForkIcon = () => <Split {...props} />;
/** Take the conversation back to a point. */
export const RewindIcon = () => <Undo2 {...props} />;
/** Sign in to a service in the browser, and sign out of it. */
export const SignInIcon = () => <LogIn {...props} />;
export const SignOutIcon = () => <LogOut {...props} />;
/** Concise vs detailed conversation timeline toggle. */
export const CompactViewIcon = () => <ListCollapse {...props} />;
export const DetailedViewIcon = () => <ScrollText {...props} />;
