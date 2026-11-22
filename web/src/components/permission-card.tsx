import { type ReactNode, useState } from "react";
import {
	type Approval,
	type ChangeStep,
	normalizePermissionMode,
	type PermissionMode,
	type PermissionRequest,
} from "../../../src/shared/types.ts";
import { answerApproval } from "../actions.ts";
import { formatCost, formatWaited, hasMessage, type MessageKey, t } from "../i18n.ts";
import { isImeEvent } from "../ime.ts";
import { Capped, Diff, ScrollBlock } from "./content.tsx";
import { CheckAllIcon, CheckIcon, RefuseIcon, ShieldIcon } from "./icons.tsx";
import { Button, CardHead, describeRule, ErrorBox, useAction, useNow } from "./ui.tsx";

/**
 * What a permission request does, in the person's words: why a must-confirm operation asks every time,
 * or the kind of action the tool takes. The command, file or address follows below it.
 */
function permissionHeadline(request: PermissionRequest): string {
	if (request.reasons && request.reasons.length > 0) {
		return request.reasons
			.map((reason) => t(`confirm_${reason}` satisfies MessageKey))
			.join(t("listSeparator"));
	}
	if (request.reason) return request.reason;
	// manage_yew: organizing, or changing settings; widening shows its reasons above.
	const scope = request.rememberRules?.[0]?.pattern;
	if (request.tool === "manage_yew" && (scope === "organize" || scope === "configure")) {
		return t(`manage_${scope}`);
	}
	// A task session is named in the line itself; there is no command or file to show under it.
	if (request.tool === "open_session") {
		return t("ask_open_session_named", { name: t("quoted", { s: request.summary }) });
	}
	const key = `ask_${request.tool}`;
	return hasMessage(key) ? t(key) : request.tool;
}

const clip = (text: string, max = 80) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return [...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat;
};

/** One change manage_yew makes, in the person's language, for permission cards and the trace notice. */
export function changeText(step: ChangeStep): string {
	const quoted = (name: string) => t("quoted", { s: name });
	const folder = (path: string | null) => (path === null ? t("change_no_folder") : path);
	switch (step.action) {
		case "create_team":
			return t("change_create_team", { name: quoted(step.name) });
		case "rename_team":
			return t("change_rename_team", { from: quoted(step.from), to: quoted(step.to) });
		case "create_session": {
			const details = [
				t("change_detail_model", { model: step.model }),
				t("change_detail_folder", { folder: folder(step.folder) }),
				...(step.team ? [t("change_detail_team", { team: quoted(step.team) })] : []),
				...(step.role ? [t("change_detail_role", { role: clip(step.role) })] : []),
			].join(t("listSeparator"));
			return t("change_create_session", { name: quoted(step.name), details });
		}
		case "rename_session":
			return t("change_rename_session", { from: quoted(step.from), to: quoted(step.to) });
		case "move_to_team": {
			const sessions = step.sessions.map(quoted).join(t("enumSeparator"));
			return step.team === null
				? t("change_leave_team", { sessions })
				: t("change_move_to_team", { sessions, team: quoted(step.team) });
		}
		case "set_role":
			return t("change_set_role", { session: quoted(step.session), role: clip(step.role) });
		case "set_model":
			return t("change_set_model", { session: quoted(step.session), from: step.from, to: step.to });
		case "set_folder":
			return t("change_set_folder", {
				session: quoted(step.session),
				from: folder(step.from),
				to: folder(step.to),
			});
		case "set_permission":
			return t("change_set_permission", {
				session: quoted(step.session),
				// Changes saved before 1.7 name the earlier modes, which read as default now.
				from: t(`perm_${normalizePermissionMode(step.from) ?? "default"}`),
				to: t(`perm_${normalizePermissionMode(step.to) ?? "default"}`),
			});
		case "set_receive":
			return t("change_set_receive", {
				session: quoted(step.session),
				from: t(`receive_${step.from}`),
				to: t(`receive_${step.to}`),
			});
		case "set_letter_quota":
			return t("change_set_letter_quota", {
				session: quoted(step.session),
				from: step.from,
				to: step.to,
			});
		case "set_daily_budget": {
			const amount = (value: number | null) =>
				value === null ? t("budgetNone") : t("cost", { n: formatCost(value) });
			return step.session === null
				? t("change_set_daily_budget_all", { from: amount(step.from), to: amount(step.to) })
				: t("change_set_daily_budget", {
						session: quoted(step.session),
						from: amount(step.from),
						to: amount(step.to),
					});
		}
		case "set_right":
			return t(step.on ? "change_right_on" : "change_right_off", {
				session: quoted(step.session),
				right: t(`right_${step.right}`),
			});
		case "pin":
			return t(step.on ? "change_pin_on" : "change_pin_off", { session: quoted(step.session) });
		case "archive":
			return t(step.on ? "change_archive_on" : "change_archive_off", {
				session: quoted(step.session),
			});
		case "set_main":
			if (step.to === null) return t("change_clear_main", { from: quoted(step.from ?? "") });
			return step.from === null
				? t("change_set_main_first", { to: quoted(step.to) })
				: t("change_set_main", { from: quoted(step.from), to: quoted(step.to) });
		case "set_default_model":
			return t("change_set_default_model", { from: step.from, to: step.to });
		case "set_decision_log":
			return step.to === null
				? t("change_clear_decision_log")
				: t("change_set_decision_log", { to: step.to });
		case "add_workspace":
			return t("change_add_workspace", { folder: step.folder });
		case "remove_workspace":
			return t("change_remove_workspace", { folder: step.folder });
		case "set_theme":
			return t("change_set_theme", { to: t(`theme_${step.to}`) });
		case "set_language":
			return t("change_set_language", {
				to: step.to === "system" ? t("language_system") : step.to === "zh" ? "中文" : "English",
			});
		case "create_schedule": {
			const details = [
				t("change_detail_cron", { cron: step.cron }),
				t("change_detail_to", { session: quoted(step.session) }),
				...(step.permission
					? [t("change_detail_run_mode", { mode: t(`perm_${step.permission}`) })]
					: []),
				t("change_detail_letter", { message: clip(step.message) }),
			].join(t("listSeparator"));
			return t("change_create_schedule", { name: quoted(step.name), details });
		}
		case "change_schedule": {
			const runMode = (mode: PermissionMode | null) =>
				mode ? t(`perm_${mode}`) : t("scheduleModeSession");
			const details = [
				...(step.name !== undefined
					? [t("change_detail_rename", { name: quoted(step.name) })]
					: []),
				...(step.cron !== undefined ? [t("change_detail_cron", { cron: step.cron })] : []),
				...(step.session !== undefined
					? [t("change_detail_to", { session: quoted(step.session) })]
					: []),
				...(step.permission !== undefined
					? [t("change_detail_run_mode_change", { mode: runMode(step.permission) })]
					: []),
				...(step.message !== undefined
					? [t("change_detail_letter", { message: clip(step.message) })]
					: []),
				...(step.catchUp !== undefined
					? [t(step.catchUp ? "change_detail_catch_up_on" : "change_detail_catch_up_off")]
					: []),
				...(step.enabled !== undefined
					? [t(step.enabled ? "change_detail_on" : "change_detail_off")]
					: []),
			].join(t("listSeparator"));
			return t("change_change_schedule", { name: quoted(step.schedule), details });
		}
		case "set_extra_dirs":
			return t("change_set_extra_dirs", {
				session: quoted(step.session),
				dirs:
					step.dirs.length > 0
						? step.dirs
								.map((d) => `${d.path} (${t(`access_${d.access}`)})`)
								.join(t("listSeparator"))
						: t("change_no_folder"),
			});
		case "set_allowed_domains":
			return step.session === null
				? t("change_set_allowed_domains_all", {
						domains:
							step.domains.length > 0 ? step.domains.join(t("listSeparator")) : t("noneLabel"),
					})
				: t("change_set_allowed_domains", {
						session: quoted(step.session),
						domains:
							step.domains.length > 0 ? step.domains.join(t("listSeparator")) : t("noneLabel"),
					});
	}
}

/**
 * A permission request. In the approval center it names the session and how long it has been waiting;
 * in the session itself it says that it needs the person's permission.
 */
export function PermissionCard({ approval, session }: { approval: Approval; session?: ReactNode }) {
	const request = approval.request as PermissionRequest;
	const [reason, setReason] = useState("");
	const [denying, setDenying] = useState(false);
	const now = useNow();
	const action = useAction((decision: "allow_once" | "allow_always" | "deny") =>
		answerApproval(
			approval.id,
			decision === "deny" && reason.trim() ? { decision, reason: reason.trim() } : { decision },
		),
	);
	if (approval.status !== "pending") {
		const decision = approval.response?.decision;
		return (
			<p className="hint">
				{approval.status === "cancelled"
					? t("cancelled")
					: decision && approval.response?.reason
						? t("decidedWithReason", {
								decision: t(`decided_${decision}`),
								reason: approval.response.reason,
							})
						: decision
							? t(`decided_${decision}`)
							: ""}
			</p>
		);
	}
	// "Always allow" names what it remembers the way the session settings list it.
	const rules = request.rememberRules?.map(describeRule).join(t("listSeparator"));
	const headline = permissionHeadline(request);
	return (
		<section className="card request-card" aria-label={headline}>
			<CardHead
				icon={<ShieldIcon />}
				parts={session ? [session, formatWaited(approval.createdAt, now)] : [t("approvalTitle")]}
				tags={
					request.matter ? (
						<span className="tag" title={t("matterTagHint")}>
							{t("matterTag")}
						</span>
					) : request.mustConfirm ? (
						<span className="tag" title={t("confirmEachTimeHint")}>
							{t("confirmEachTime")}
						</span>
					) : null
				}
			/>
			{/* The automatic mode's check looked at it first and left it to the person. */}
			{request.review !== undefined && (
				<p className="hint">
					{request.review
						? t("reviewDeclined", { reason: request.review })
						: t("reviewDeclinedPlain")}
				</p>
			)}
			<p className="request-title">{headline}</p>
			{request.description && (
				<Capped className="request-description" label={headline}>
					{request.description}
				</Capped>
			)}
			{request.tool === "open_session" ? null : request.changes ? (
				<ul className="request-list">
					{request.changes.map((step, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the changes are fixed and in order
						<li key={index}>{changeText(step)}</li>
					))}
				</ul>
			) : (
				<ScrollBlock className="code request-code" label={headline}>
					{request.summary}
				</ScrollBlock>
			)}
			{/* A site asked about while other things ran in the sandbox: what ran, and a yes is for once. */}
			{request.running && request.running.length > 0 && (
				<>
					<p className="hint">{t("siteRunning")}</p>
					<ul className="request-list">
						{request.running.map((item, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed and in order
							<li key={index}>{t(`siteRunning_${item.kind}`, { text: item.text })}</li>
						))}
					</ul>
					<p className="hint request-warning">{t("siteOnce")}</p>
				</>
			)}
			{request.diff && <Diff patch={request.diff} />}
			{denying && (
				<input
					className="input"
					placeholder={t("denyReason")}
					aria-label={t("denyReason")}
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					onKeyDown={(event) =>
						event.key === "Enter" && !isImeEvent(event) && void action.run("deny")
					}
				/>
			)}
			{/* What "always allow" covers for a tool that acts with the person's sign-ins. */}
			{rules && request.warning === "acts-as-you" && (
				<p className="hint request-warning">{t("alwaysActsAsYou")}</p>
			)}
			{/* Allow, always allow (the rule is in the label), decline. */}
			<div className="request-actions">
				<Button variant="primary" busy={action.busy} onClick={() => void action.run("allow_once")}>
					<CheckIcon />
					{t("approve")}
				</Button>
				{rules && (
					<Button
						className="request-always"
						busy={action.busy}
						onClick={() => void action.run("allow_always")}
						title={t("rememberAs", { rules })}
					>
						<CheckAllIcon />
						{t("approveAlways", { rules })}
					</Button>
				)}
				<Button
					variant="danger"
					busy={action.busy}
					onClick={() => (denying ? void action.run("deny") : setDenying(true))}
				>
					<RefuseIcon />
					{denying ? t("confirmDeny") : t("deny")}
				</Button>
			</div>
			<ErrorBox error={action.error} />
		</section>
	);
}
