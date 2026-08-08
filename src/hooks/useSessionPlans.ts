import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionPlan } from "@/lib/git-workspace";
import { getSessionPlan, listSessionPlans } from "@/lib/tauri-api";

type CachedPlan = {
  plan: SessionPlan;
  modifiedMs: number;
  size: number;
};

export function useSessionPlans(sessionId: string) {
  const [plans, setPlans] = useState<SessionPlan[]>([]);
  const [selected, setSelected] = useState<SessionPlan | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const listRequestRef = useRef(0);
  const contentRequestRef = useRef(0);
  const plansRef = useRef<SessionPlan[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const contentCacheRef = useRef(new Map<string, CachedPlan>());
  const contentPendingRef = useRef<{
    request: number;
    planId: string;
    modifiedMs: number;
    size: number;
  } | null>(null);

  const loadContent = useCallback(
    async (planId: string, metadata?: SessionPlan) => {
      const request = ++contentRequestRef.current;
      contentPendingRef.current = {
        request,
        planId,
        modifiedMs: metadata?.modifiedMs ?? -1,
        size: metadata?.size ?? -1,
      };
      setContentLoading(true);
      setContentError(null);
      try {
        const content = await getSessionPlan(sessionId, planId);
        if (request !== contentRequestRef.current) return null;
        const currentMetadata =
          metadata ?? plansRef.current.find((candidate) => candidate.id === planId);
        const plan = currentMetadata
          ? { ...currentMetadata, content: content.content ?? "" }
          : content;
        contentCacheRef.current.set(planId, {
          plan,
          modifiedMs: currentMetadata?.modifiedMs ?? plan.modifiedMs,
          size: currentMetadata?.size ?? plan.size,
        });
        if (selectedIdRef.current === planId) setSelected(plan);
        return plan;
      } catch (err) {
        if (request === contentRequestRef.current) {
          setContentError(err instanceof Error ? err.message : String(err));
        }
        return null;
      } finally {
        if (request === contentRequestRef.current) {
          contentPendingRef.current = null;
          setContentLoading(false);
        }
      }
    },
    [sessionId],
  );

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const request = ++listRequestRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const next = await listSessionPlans(sessionId);
      if (request !== listRequestRef.current) return;
      plansRef.current = next;
      setPlans(next);
      const metadataById = new Map(next.map((plan) => [plan.id, plan]));
      for (const [planId, cached] of contentCacheRef.current) {
        const metadata = metadataById.get(planId);
        if (
          !metadata ||
          metadata.modifiedMs !== cached.modifiedMs ||
          metadata.size !== cached.size
        ) {
          contentCacheRef.current.delete(planId);
        }
      }
      const selectedId = selectedIdRef.current;
      if (selectedId) {
        const metadata = metadataById.get(selectedId);
        if (!metadata) {
          selectedIdRef.current = null;
          contentRequestRef.current += 1;
          contentPendingRef.current = null;
          setContentLoading(false);
          setSelected(null);
        } else {
          const cached = contentCacheRef.current.get(selectedId);
          if (cached) setSelected(cached.plan);
          else {
            const pending = contentPendingRef.current;
            if (
              !pending ||
              pending.planId !== selectedId ||
              pending.modifiedMs !== metadata.modifiedMs ||
              pending.size !== metadata.size
            ) {
              void loadContent(selectedId, metadata);
            }
          }
        }
      }
    } catch (err) {
      if (request === listRequestRef.current) {
        plansRef.current = [];
        setPlans([]);
        setListError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (request === listRequestRef.current) setListLoading(false);
    }
  }, [loadContent, sessionId]);

  useEffect(() => {
    setPlans([]);
    plansRef.current = [];
    setSelected(null);
    selectedIdRef.current = null;
    setListError(null);
    setContentError(null);
    listRequestRef.current += 1;
    contentRequestRef.current += 1;
    contentPendingRef.current = null;
    contentCacheRef.current.clear();
    void refresh();
    return () => {
      listRequestRef.current += 1;
      contentRequestRef.current += 1;
      contentPendingRef.current = null;
    };
  }, [refresh]);

  const open = useCallback(
    async (planId: string) => {
      selectedIdRef.current = planId;
      const metadata = plansRef.current.find((plan) => plan.id === planId);
      const cached = contentCacheRef.current.get(planId);
      if (
        cached &&
        (!metadata ||
          (cached.modifiedMs === metadata.modifiedMs && cached.size === metadata.size))
      ) {
        contentRequestRef.current += 1;
        contentPendingRef.current = null;
        setContentLoading(false);
        setSelected(cached.plan);
        return cached.plan;
      }
      return loadContent(planId, metadata);
    },
    [loadContent],
  );

  const close = () => {
    selectedIdRef.current = null;
    contentRequestRef.current += 1;
    contentPendingRef.current = null;
    setContentLoading(false);
    setSelected(null);
  };

  return {
    plans,
    selected,
    listLoading,
    contentLoading,
    loading: listLoading || contentLoading,
    listError,
    contentError,
    error: listError || contentError,
    refresh,
    open,
    close,
  };
}
