import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

// Sign-in is required everywhere by default — including `npm run dev`.
// For UI work without an account you can opt in to a bypass in dev only:
//   VITE_BYPASS_AUTH=true npm run dev
// Production builds (vite build) always enforce a real session.
// (Previously the bypass was ON by default in dev, so anyone who could reach
// the dev server saw the signed-in pages.)
export const BYPASS_AUTH =
  import.meta.env.DEV && import.meta.env.VITE_BYPASS_AUTH === "true";

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
