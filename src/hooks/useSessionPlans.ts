import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionPlan } from "@/lib/git-workspace";
import { getSessionPlan, listSessionPlans } from "@/lib/tauri-api";

export function useSessionPlans(sessionId: string) {
  const [plans, setPlans] = useState<SessionPlan[]>([]);
  const [selected, setSelected] = useState<SessionPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const contentCacheRef = useRef(new Map<string, SessionPlan>());

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await listSessionPlans(sessionId);
      if (request === requestRef.current) setPlans(next);
    } catch (err) {
      if (request === requestRef.current) {
        setPlans([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setPlans([]);
    setSelected(null);
    setError(null);
    contentCacheRef.current.clear();
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  const open = useCallback(
    async (planId: string) => {
      const cached = contentCacheRef.current.get(planId);
      if (cached) {
        setSelected(cached);
        return cached;
      }
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const plan = await getSessionPlan(sessionId, planId);
        if (request !== requestRef.current) return null;
        contentCacheRef.current.set(planId, plan);
        setSelected(plan);
        return plan;
      } catch (err) {
        if (request === requestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
        return null;
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [sessionId],
  );

  return { plans, selected, loading, error, refresh, open, close: () => setSelected(null) };
}
