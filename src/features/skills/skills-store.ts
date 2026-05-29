import { create } from "zustand";

export type SkillScope = "Built-in" | "Project" | "User";

export interface Skill {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  path?: string;
}

const STATIC_SKILLS: Skill[] = [
  {
    id: "codex-worker",
    name: "codex-worker",
    description: "Spawn and manage multiple Codex CLI agents via tmux",
    scope: "Project",
    path: ".agents/skills/codex-worker",
  },
  {
    id: "feature-smoke-test",
    name: "feature-smoke-test",
    description: "端到端冒烟测试",
    scope: "Project",
    path: ".agents/skills/feature-smoke-test",
  },
  {
    id: "gen-changelog",
    name: "gen-changelog",
    description: "Generate changelog entries",
    scope: "Project",
    path: ".agents/skills/gen-changelog",
  },
  {
    id: "gen-docs",
    name: "gen-docs",
    description: "Update Kimi Code CLI user documentation",
    scope: "Project",
    path: ".agents/skills/gen-docs",
  },
  {
    id: "pull-request",
    name: "pull-request",
    description: "Create and submit a GitHub Pull Request",
    scope: "Project",
    path: ".agents/skills/pull-request",
  },
  {
    id: "release",
    name: "release",
    description: "Execute the release workflow",
    scope: "Project",
    path: ".agents/skills/release",
  },
  {
    id: "translate-docs",
    name: "translate-docs",
    description: "Translate and sync bilingual documentation",
    scope: "Project",
    path: ".agents/skills/translate-docs",
  },
  {
    id: "worktree-status",
    name: "worktree-status",
    description: "Audit all git worktrees",
    scope: "Project",
    path: ".agents/skills/worktree-status",
  },
];

type SkillsStore = {
  skills: Skill[];
  selectedSkillId: string | null;
  searchQuery: string;
  selectSkill: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
};

export const useSkillsStore = create<SkillsStore>((set) => ({
  skills: STATIC_SKILLS,
  selectedSkillId: null,
  searchQuery: "",
  selectSkill: (id) => set({ selectedSkillId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}));
