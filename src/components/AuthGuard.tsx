import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

// Auth bypass is dev-only. In production builds (vite build) this resolves
// to `false`, so the guard always enforces a real session. To opt out in dev,
// run with `VITE_BYPASS_AUTH=false npm run dev`.
export const BYPASS_AUTH =
  import.meta.env.DEV && import.meta.env.VITE_BYPASS_AUTH !== "false";

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (BYPASS_AUTH) return;
    if (!loading && !session) navigate("/auth", { replace: true });
  }, [session, loading, navigate]);

  if (BYPASS_AUTH) return <>{children}</>;

  if (loading) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <span className="font-mono text-muted-foreground text-sm animate-pulse">Loading...</span>
    </div>
  );

  if (!session) return null;

  return <>{children}</>;
}
