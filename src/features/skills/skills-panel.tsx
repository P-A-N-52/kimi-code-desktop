import { BookOpenIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useSkillsStore } from "./skills-store";
import { SkillCard } from "./skill-card";

interface SkillsPanelProps {
  className?: string;
  onClose?: () => void;
}

export function SkillsPanel({ className, onClose }: SkillsPanelProps) {
  const skills = useSkillsStore((s) => s.skills);
  const searchQuery = useSkillsStore((s) => s.searchQuery);
  const selectedSkillId = useSkillsStore((s) => s.selectedSkillId);
  const setSearchQuery = useSkillsStore((s) => s.setSearchQuery);
  const selectSkill = useSkillsStore((s) => s.selectSkill);

  const filteredSkills = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const grouped = filteredSkills.reduce<Record<string, typeof skills>>((acc, skill) => {
    const key = skill.scope;
    if (!acc[key]) acc[key] = [];
    acc[key].push(skill);
    return acc;
  }, {});

  const scopes = Object.keys(grouped).sort(
    (a, b) =>
      ["Built-in", "Project", "User"].indexOf(a) -
      ["Built-in", "Project", "User"].indexOf(b),
  );

  const selectedSkill = skills.find((s) => s.id === selectedSkillId);

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 flex-col bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/85",
        className,
      )}
    >
      <div className="border-b px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <BookOpenIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold">Skills Library</h2>
          </div>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label="Collapse skills panel"
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="relative mt-3">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search skills..."
            className="h-8 pl-8 text-xs"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {filteredSkills.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center text-muted-foreground">
              <SearchIcon className="size-6 opacity-50" />
              <p className="text-sm font-medium">No skills found</p>
              <p className="max-w-48 text-xs">
                Try adjusting your search query.
              </p>
            </div>
          ) : (
            scopes.map((scope) => (
              <div key={scope}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {scope}
                </h3>
                <div className="grid grid-cols-1 gap-2">
                  {grouped[scope].map((skill) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      isSelected={skill.id === selectedSkillId}
                      onSelect={(s) =>
                        selectSkill(s.id === selectedSkillId ? null : s.id)
                      }
                    />
                  ))}
                </div>
                <Separator className="mt-4" />
              </div>
            ))
          )}

          {selectedSkill ? (
            <div className="rounded-lg border bg-card/60 p-3">
              <h4 className="text-sm font-semibold">{selectedSkill.name}</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedSkill.description}
              </p>
              {selectedSkill.path ? (
                <p className="mt-2 text-[10px] font-mono text-muted-foreground">
                  {selectedSkill.path}
                </p>
              ) : null}
              <Button
                type="button"
                variant="default"
                size="sm"
                className="mt-3 w-full text-xs"
                onClick={() => console.log(`/skill:${selectedSkill.name}`)}
              >
                Invoke /skill:{selectedSkill.name}
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}
