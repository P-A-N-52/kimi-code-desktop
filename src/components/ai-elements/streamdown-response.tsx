"use client";

import type { ComponentProps } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import {
  escapeHtmlOutsideCodeBlocks,
  safeRehypePlugins,
  safeRemarkPlugins,
  streamdownComponents,
  streamdownRootClass,
} from "./streamdown";

export type StreamdownResponseProps = ComponentProps<typeof Streamdown>;

export const StreamdownResponse = memo(
  ({ className, children, ...props }: StreamdownResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        streamdownRootClass,
        className,
      )}
      components={streamdownComponents}
      data-kimi-i18n-skip
      rehypePlugins={safeRehypePlugins}
      remarkPlugins={safeRemarkPlugins}
      {...props}
    >
      {typeof children === "string"
        ? escapeHtmlOutsideCodeBlocks(children)
        : children}
    </Streamdown>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

StreamdownResponse.displayName = "StreamdownResponse";
