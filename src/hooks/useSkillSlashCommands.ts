import { useEffect, useState } from "react";
import { type AvailableSkill, listAvailableSkills } from "@/lib/tauri-api";
import type { SlashCommandDef } from "@/lib/slash-command-catalog";

function toSlashCommand(skill: AvailableSkill): SlashCommandDef {
	return {
		name: `skill:${skill.name}`,
		description: skill.description || `Invoke the ${skill.name} skill`,
		aliases: [],
		inputHint: null,
		source: skill.source.startsWith("plugin:")
			? `disk:skill:${skill.source}`
			: `disk:skill:${skill.source || "unknown"}`,
	};
}

/**
 * Disk-discovered skills exposed as `skill:<name>` slash commands. The runtime
 * also advertises skills over ACP once a session connects; merge these with
 * `mergeSlashCommands` so ACP entries keep priority and disk entries backfill
 * the new-session composer (and anything the runtime missed).
 */
export function useSkillSlashCommands(): SlashCommandDef[] {
	const [commands, setCommands] = useState<SlashCommandDef[]>([]);
	useEffect(() => {
		let cancelled = false;
		listAvailableSkills()
			.then((skills) => {
				if (!cancelled) setCommands(skills.map(toSlashCommand));
			})
			.catch((error) => {
				// Skill discovery is best-effort; the menu just shows fewer entries.
				console.warn("[skills] list_available_skills failed", error);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	return commands;
}
