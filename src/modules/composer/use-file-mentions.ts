import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  applyMentionSelection,
  detectMention,
  entriesToMentionOptions,
  filterMentionOptions,
  mentionListPath,
  type FileMentionEntry,
  type FileMentionOption,
  type MentionRange,
} from "./file-mentions";

const DIRECTORY_DEBOUNCE_MS = 120;

type UseFileMentionsArgs = {
  text: string;
  setText: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  sessionId: string;
  listDirectory?: (sessionId: string, path?: string) => Promise<FileMentionEntry[]>;
  /** When true, ignore @ detection (e.g. slash menu owns the draft). */
  disabled?: boolean;
};

export function useFileMentions({
  text,
  setText,
  textareaRef,
  sessionId,
  listDirectory,
  disabled = false,
}: UseFileMentionsArgs) {
  const [range, setRange] = useState<MentionRange | null>(null);
  const [options, setOptions] = useState<FileMentionOption[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const cacheRef = useRef(new Map<string, FileMentionOption[]>());

  const syncRangeFromCaret = useCallback(
    (caret: number | null) => {
      if (disabled) {
        setRange(null);
        return;
      }
      setRange(detectMention(text, caret));
    },
    [disabled, text],
  );

  useEffect(() => {
    if (disabled) {
      setRange(null);
      return;
    }
    const node = textareaRef.current;
    const caret =
      node && typeof document !== "undefined" && document.activeElement === node
        ? node.selectionStart
        : text.length;
    setRange(detectMention(text, caret));
  }, [text, disabled, textareaRef]);

  useEffect(() => {
    cacheRef.current.clear();
    setOptions([]);
    setStatus("idle");
    setError(null);
    requestIdRef.current += 1;
  }, [sessionId]);

  useEffect(() => {
    if (!range || disabled || !listDirectory) {
      return;
    }
    const listPath = mentionListPath(range.query);
    const cacheKey = listPath ?? ".";
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setOptions(filterMentionOptions(cached, range.query));
      setStatus("ready");
      setError(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    setStatus("loading");
    setError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const entries = await listDirectory(
            sessionId,
            listPath === undefined ? undefined : listPath,
          );
          if (requestIdRef.current !== requestId) return;
          const mapped = entriesToMentionOptions(entries, listPath);
          cacheRef.current.set(cacheKey, mapped);
          setOptions(filterMentionOptions(mapped, range.query));
          setStatus("ready");
        } catch (err) {
          if (requestIdRef.current !== requestId) return;
          setOptions([]);
          setStatus("error");
          setError(err instanceof Error ? err.message : "加载工作区文件失败");
        }
      })();
    }, DIRECTORY_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [range, disabled, listDirectory, sessionId]);

  useEffect(() => {
    setActiveIndex(0);
  }, [range?.query, options.length]);

  const closeMenu = useCallback(() => setRange(null), []);

  const selectOption = useCallback(
    (option?: FileMentionOption) => {
      if (!range) return;
      const target = option ?? options[activeIndex];
      if (!target) return;
      const applied = applyMentionSelection({ text, range, option: target });
      setText(applied.nextText);
      if (applied.keepOpen) {
        setRange({
          start: range.start,
          end: applied.nextCaret,
          query: applied.nextQuery,
        });
      } else {
        setRange(null);
      }
      setActiveIndex(0);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(applied.nextCaret, applied.nextCaret);
      });
    },
    [range, options, activeIndex, text, setText, textareaRef],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!range) return false;
      if (event.key === "ArrowDown") {
        if (options.length === 0) return true;
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        if (options.length === 0) return true;
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + options.length) % options.length);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        if (options.length === 0) return false;
        event.preventDefault();
        selectOption();
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return true;
      }
      return false;
    },
    [range, options, selectOption, closeMenu],
  );

  return {
    isOpen: Boolean(range) && !disabled,
    query: range?.query ?? "",
    options,
    activeIndex,
    setActiveIndex,
    status,
    error,
    selectOption,
    closeMenu,
    handleKeyDown,
    syncRangeFromCaret,
  };
}
