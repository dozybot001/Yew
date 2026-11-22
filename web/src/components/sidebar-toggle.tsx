import { t, useLang } from "../i18n.ts";
import { setState } from "../state.ts";
import { MenuIcon } from "./icons.tsx";
import { Button } from "./ui.tsx";

/** On narrow screens the sidebar is a drawer; this opens it. */
export function SidebarToggle({ className = "" }: { className?: string }) {
	useLang();
	return (
		<Button
			variant="icon"
			className={`only-narrow ${className}`.trim()}
			aria-label={t("openSidebar")}
			onClick={() => setState({ drawerOpen: true })}
		>
			<MenuIcon />
		</Button>
	);
}
