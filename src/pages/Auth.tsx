import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Lock, ArrowRight, Eye, EyeOff, User, Hash } from "lucide-react";
import Logo from "@/components/Logo";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

export default function Auth() {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [aircraftId, setAircraftId] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [unconfirmedEmail, setUnconfirmedEmail] = useState("");
  const { session } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (session) navigate("/dashboard", { replace: true });
  }, [session, navigate]);

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate("/dashboard", { replace: true });
      } else {
        if (!operatorName.trim()) throw new Error("Operator name is required.");
        if (!aircraftId.trim()) throw new Error("Aircraft registration ID is required.");
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              operator_name: operatorName.trim(),
              aircraft_id: aircraftId.trim().toUpperCase(),
            },
          },
        });
        if (error) throw error;
        toast({ title: "Account created", description: "Check your email to confirm, then sign in." });
        setMode("login");
      }
    } catch (err: any) {
      if (err.message?.toLowerCase().includes("email not confirmed") || err.code === "email_not_confirmed") {
        setUnconfirmedEmail(email);
      } else {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  };

  const resendConfirmation = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email: unconfirmedEmail });
      if (error) throw error;
      toast({ title: "Email sent", description: "Confirmation email resent. Check your inbox." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    try {
      const { lovable } = await import("@/integrations/lovable/index");
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        toast({ title: "Google sign-in failed", description: (result.error as Error).message, variant: "destructive" });
        setLoading(false);
        return;
      }
      if (result.redirected) return; // browser will navigate
      // Tokens received, session set — go to dashboard
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      toast({ title: "Google sign-in failed", description: err.message, variant: "destructive" });
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth`,
      });
      if (error) throw error;
      setResetSent(true);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      {/* Logo */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-10"
      >
        <Logo size={42} showWordmark />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="w-full max-w-sm"
      >
        {/* Email not confirmed banner */}
        {unconfirmedEmail && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 space-y-2"
          >
            <p className="text-sm font-medium text-amber-400">Email not confirmed</p>
            <p className="text-xs text-muted-foreground">
              Please confirm <span className="font-mono text-foreground">{unconfirmedEmail}</span> before signing in.
            </p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={resendConfirmation}
                disabled={loading}
                className="text-xs text-amber-400 hover:underline disabled:opacity-50"
              >
                {loading ? "Sending…" : "Resend confirmation email"}
              </button>
              <span className="text-muted-foreground text-xs">·</span>
              <button
                onClick={() => setUnconfirmedEmail("")}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        )}

        {/* Mode tabs — hidden on reset screen */}
        {mode !== "reset" && (
          <div className="flex mb-6 border border-border rounded-lg overflow-hidden">
            {(["login", "signup"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 py-2.5 text-sm font-mono transition-colors ${
                  mode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                }`}
              >
                {m === "login" ? "Sign In" : "Sign Up"}
              </button>
            ))}
          </div>
        )}

        {/* ── Reset password form ── */}
        <AnimatePresence mode="wait">
          {mode === "reset" && (
            <motion.div
              key="reset"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.2 }}
            >
              {resetSent ? (
                <div className="glass-card rounded-xl p-6 text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center mx-auto">
                    <Mail className="w-5 h-5 text-primary" />
                  </div>
                  <p className="font-semibold text-sm">Check your inbox</p>
                  <p className="text-xs text-muted-foreground">
                    We sent a password reset link to <span className="text-foreground font-mono">{email}</span>.
                    Follow the link to set a new password.
                  </p>
                  <button
                    onClick={() => { setMode("login"); setResetSent(false); }}
                    className="text-primary text-xs hover:underline font-mono mt-2 block mx-auto"
                  >
                    ← Back to sign in
                  </button>
                </div>
              ) : (
                <>
                  <div className="mb-5">
                    <h2 className="font-semibold text-base">Reset your password</h2>
                    <p className="text-xs text-muted-foreground mt-1">
                      Enter your email and we'll send you a reset link.
                    </p>
                  </div>
                  <form onSubmit={handleReset} className="glass-card rounded-xl p-6 space-y-4">
                    <div>
                      <label className="text-xs font-mono text-muted-foreground mb-1.5 block">EMAIL</label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          placeholder="pilot@altos.air"
                          className="w-full bg-secondary border border-border rounded-md pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-md py-2.5 font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {loading ? (
                        <span className="text-sm font-mono">Sending...</span>
                      ) : (
                        <>
                          <span className="text-sm">Send Reset Link</span>
                          <ArrowRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </form>
                  <button
                    onClick={() => setMode("login")}
                    className="text-center text-xs text-muted-foreground hover:text-foreground mt-4 block w-full"
                  >
                    ← Back to sign in
                  </button>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <form onSubmit={handle} className={`glass-card rounded-xl p-6 space-y-4 ${mode === "reset" ? "hidden" : ""}`}>
          {/* Sign-up extra fields */}
          <AnimatePresence initial={false}>
            {mode === "signup" && (
              <motion.div
                key="signup-fields"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
                className="space-y-4 overflow-hidden"
              >
                <div>
                  <label className="text-xs font-mono text-muted-foreground mb-1.5 block">OPERATOR NAME</label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={operatorName}
                      onChange={(e) => setOperatorName(e.target.value)}
                      placeholder="e.g. SkyLink Operations"
                      className="w-full bg-secondary border border-border rounded-md pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-mono text-muted-foreground mb-1.5 block">AIRCRAFT REGISTRATION ID</label>
                  <div className="relative">
                    <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={aircraftId}
                      onChange={(e) => setAircraftId(e.target.value)}
                      placeholder="e.g. N-VTOL-4827"
                      className="w-full bg-secondary border border-border rounded-md pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div>
            <label className="text-xs font-mono text-muted-foreground mb-1.5 block">EMAIL</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="pilot@altos.air"
                className="w-full bg-secondary border border-border rounded-md pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-mono text-muted-foreground mb-1.5 block">PASSWORD</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                minLength={6}
                className="w-full bg-secondary border border-border rounded-md pl-9 pr-10 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => setShowPw((p) => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {mode === "login" && (
            <div className="flex justify-end -mt-1">
              <button
                type="button"
                onClick={() => { setMode("reset"); setResetSent(false); }}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                Forgot password?
              </button>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-md py-2.5 font-medium hover:opacity-90 transition-opacity disabled:opacity-50 mt-2"
          >
            {loading ? (
              <span className="text-sm font-mono">Processing...</span>
            ) : (
              <>
                <span className="text-sm">{mode === "login" ? "Sign In" : "Create Account"}</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Divider + Google — hidden on reset screen */}
        {mode !== "reset" && <>
        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs font-mono text-muted-foreground">or</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* Google OAuth */}
        <button
          onClick={handleGoogle}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 bg-secondary border border-border rounded-xl py-2.5 text-sm font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>

        <p className="text-center text-xs text-muted-foreground mt-4">
          {mode === "login" ? "No account? " : "Already registered? "}
          <button
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
            className="text-primary hover:underline"
          >
            {mode === "login" ? "Sign up" : "Sign in"}
          </button>
        </p>
        </>}
      </motion.div>
    </div>
  );
}
