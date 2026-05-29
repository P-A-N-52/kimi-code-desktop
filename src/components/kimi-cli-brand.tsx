import { useEffect, useState, type MouseEvent } from "react";
import {
  KIMI_CODE_URL,
  openKimiCodeWebsite,
  shouldInterceptKimiCodeLink,
} from "@/lib/kimi-code-link";
import { kimiCliVersion, resolveKimiCliVersion } from "@/lib/version";
import { cn } from "@/lib/utils";

type KimiCliBrandProps = {
  className?: string;
  size?: "sm" | "md";
  showVersion?: boolean;
};

export function KimiCliBrand({
  className,
  size = "md",
  showVersion = true,
}: KimiCliBrandProps) {
  const [version, setVersion] = useState(kimiCliVersion);
  const textSizeClass = size === "sm" ? "text-base" : "text-lg";
  const versionPadding = size === "sm" ? "text-xs" : "text-sm";
  const logoSize = size === "sm" ? "size-6" : "size-7";
  const logoPx = size === "sm" ? 24 : 28;

  useEffect(() => {
    if (!showVersion) {
      return;
    }

    let isMounted = true;
    resolveKimiCliVersion().then((resolvedVersion) => {
      if (isMounted) {
        setVersion(resolvedVersion);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [showVersion]);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldInterceptKimiCodeLink()) {
      return;
    }

    event.preventDefault();
    openKimiCodeWebsite();
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <a
        href={KIMI_CODE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        onClick={handleClick}
      >
        <img
          src="/logo.png"
          alt="Kimi"
          width={logoPx}
          height={logoPx}
          className={logoSize}
        />
        <span className={cn(textSizeClass, "font-semibold text-foreground")}>
          Kimi Code
        </span>
      </a>
      {showVersion && (
        <span
          className={cn("text-muted-foreground font-medium", versionPadding)}
        >
          v{version}
        </span>
      )}
    </div>
  );
}
