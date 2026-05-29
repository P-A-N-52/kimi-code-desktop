import { ZapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Skill, SkillScope } from "./skills-store";

function getScopeVariant(scope: SkillScope) {
  switch (scope) {
    case "Built-in":
      return "default";
    case "Project":
      return "secondary";
    case "User":
      return "outline";
  }
}

interface SkillCardProps {
  skill: Skill;
  isSelected?: boolean;
  onSelect?: (skill: Skill) => void;
}

export function SkillCard({ skill, isSelected, onSelect }: SkillCardProps) {
  return (
    <Card
      className={cn(
        "cursor-pointer transition-shadow hover:shadow-md",
        isSelected && "ring-2 ring-primary",
      )}
      onClick={() => onSelect?.(skill)}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{skill.name}</CardTitle>
          <Badge variant={getScopeVariant(skill.scope)} className="text-[10px]">
            {skill.scope}
          </Badge>
        </div>
        <CardDescription className="line-clamp-2 text-xs">
          {skill.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-2">
        {skill.path ? (
          <p className="truncate text-[10px] text-muted-foreground" title={skill.path}>
            {skill.path}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="pt-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-xs"
          onClick={(e) => {
            e.stopPropagation();
            console.log(`/skill:${skill.name}`);
          }}
        >
          <ZapIcon className="mr-1 size-3" />
          Invoke
        </Button>
      </CardFooter>
    </Card>
  );
}
