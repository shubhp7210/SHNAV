import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, Lock, ArrowRight, Eye, EyeOff, User, Hash, ChevronLeft } from "lucide-react";
import Logo from "@/components/Logo";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

type Screen = "login" | "signup-1" | "signup-2" | "reset" | "reset-sent";

export default function Auth() {
  const [screen, setScreen] = useState<Screen>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [aircraftId, setAircraftId] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unconfirmedEmail, setUnconfirmedEmail] = useState("");
  const { session } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (session) navigate("/dashboard", { replace: true });
  }, [session, navigate]);

  // ── Sign in ────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      if (err.message?.toLowerCase().includes("email not confirmed") || err.code === "email_not_confirmed") {
        setUnconfirmedEmail(email);
      } else {
        toast({ title: "Sign in failed", description: err.message, variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Step 1 → Step 2 (validate credentials exist) ──────────────
  const handleSignupStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast({ title: "Password too short", description: "Use at least 6 characters.", variant: "destructive" });
      return;
    }
    setScreen("signup-2");
  };

  // ── Step 2 → Create account ────────────────────────────────────
  const handleSignupStep2 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!operatorName.trim()) {
      toast({ title: "Operator name required", variant: "destructive" });
      return;
    }
    if (!aircraftId.trim()) {
      toast({ title: "Aircraft ID required", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
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
      setScreen("login");
    } catch (err: any) {
      toast({ title: "Sign up failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // ── Password reset ─────────────────────────────────────────────
  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback`,
      });
      if (error) throw error;
      setScreen("reset-sent");
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const resendConfirmation = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email: unconfirmedEmail });
      if (error) throw error;
      toast({ title: "Email sent", description: "Confirmation email resent." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/dashboard` },
      });
      if (error) throw error;
      // page will redirect to Google — no need to setLoading(false)
    } catch (err: any) {
      toast({ title: "Google sign-in failed", description: err.message, variant: "destructive" });
      setLoading(false);
    }
  };

  // ── Layout wrapper ─────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 -z-10 grid-pattern opacity-30 pointer-events-none" />
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[80%] h-[40vh] -z-10 pointer-events-none"
        style={{ background: "radial-gradient(ellipse at top center, hsl(5 72% 50% / 0.06), transparent 70%)" }}
      />

      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-10"
      >
        <Logo size={40} showWordmark />
      </motion.div>

      <AnimatePresence mode="wait">

        {/* ── Sign In ── */}
        {screen === "login" && (
          <motion.div
            key="login"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.22 }}
            className="w-full max-w-sm"
          >
            {unconfirmedEmail && (
              <div className="mb-4 p-4 rounded-xl border border-amber-500/30 bg-amber-500/8 space-y-2">
                <p className="text-sm font-medium text-amber-400">Email not confirmed</p>
                <p className="text-xs text-muted-foreground">
                  Confirm <span className="font-mono text-foreground">{unconfirmedEmail}</span> to sign in.
                </p>
                <div className="flex gap-3 pt-0.5">
                  <button onClick={resendConfirmation} disabled={loading} className="text-xs text-amber-400 hover:underline disabled:opacity-50">
                    {loading ? "Sending…" : "Resend email"}
                  </button>
                  <span className="text-muted-foreground text-xs">·</span>
                  <button onClick={() => setUnconfirmedEmail("")} className="text-xs text-muted-foreground hover:text-foreground">
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            <div className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
              <p className="text-sm text-muted-foreground mt-1">Sign in to your SHNAV operator account.</p>
            </div>

            <form onSubmit={handleLogin} className="glass-card rounded-2xl p-6 space-y-4">
              <div>
                <label className="text-[11px] font-mono text-muted-foreground mb-1.5 block tracking-widest uppercase">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="pilot@shnav.air"
                    className="w-full bg-secondary border border-border rounded-lg pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[11px] font-mono text-muted-foreground tracking-widest uppercase">Password</label>
                  <button
                    type="button"
                    onClick={() => { setScreen("reset"); }}
                    className="text-[11px] text-muted-foreground hover:text-primary transition-colors"
                  >
                    Forgot?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="••••••••"
                    minLength={6}
                    className="w-full bg-secondary border border-border rounded-lg pl-9 pr-10 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button type="button" onClick={() => setShowPw((p) => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-lg py-2.5 font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 mt-1"
              >
                {loading ? "Signing in…" : <><span>Sign In</span><ArrowRight className="w-4 h-4" /></>}
              </button>
            </form>

            <div className="flex items-center gap-3 my-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs font-mono text-muted-foreground">or</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <button
              onClick={handleGoogle}
              disabled={loading}
              className="w-full flex items-center justify-center gap-3 bg-secondary border border-border rounded-xl py-2.5 text-sm font-medium hover:bg-secondary/70 transition-colors disabled:opacity-50"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </button>

            <p className="text-center text-xs text-muted-foreground mt-5">
              New operator?{" "}
              <button onClick={() => { setScreen("signup-1"); setShowPw(false); }} className="text-primary hover:underline font-medium">
                Create account
              </button>
            </p>
          </motion.div>
        )}

        {/* ── Sign Up Step 1: Credentials ── */}
        {screen === "signup-1" && (
          <motion.div
            key="signup-1"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.22 }}
            className="w-full max-w-sm"
          >
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex gap-1.5">
                  <span className="w-6 h-1.5 rounded-full bg-primary" />
                  <span className="w-6 h-1.5 rounded-full bg-border" />
                </div>
                <span className="text-[11px] font-mono text-muted-foreground uppercase tracking-widest">Step 1 of 2</span>
              </div>
              <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
              <p className="text-sm text-muted-foreground mt-1">Start with your login credentials.</p>
            </div>

            <form onSubmit={handleSignupStep1} className="glass-card rounded-2xl p-6 space-y-4">
              <div>
                <label className="text-[11px] font-mono text-muted-foreground mb-1.5 block tracking-widest uppercase">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="pilot@shnav.air"
                    className="w-full bg-secondary border border-border rounded-lg pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-mono text-muted-foreground mb-1.5 block tracking-widest uppercase">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type={showPw ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="Min. 6 characters"
                    minLength={6}
                    className="w-full bg-secondary border border-border rounded-lg pl-9 pr-10 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button type="button" onClick={() => setShowPw((p) => !p)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-lg py-2.5 font-semibold text-sm hover:bg-primary/90 transition-colors mt-1"
              >
                Continue <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <p className="text-center text-xs text-muted-foreground mt-5">
              Already have an account?{" "}
              <button onClick={() => setScreen("login")} className="text-primary hover:underline font-medium">
                Sign in
              </button>
            </p>
          </motion.div>
        )}

        {/* ── Sign Up Step 2: Operator details ── */}
        {screen === "signup-2" && (
          <motion.div
            key="signup-2"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.22 }}
            className="w-full max-w-sm"
          >
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <div className="flex gap-1.5">
                  <span className="w-6 h-1.5 rounded-full bg-primary" />
                  <span className="w-6 h-1.5 rounded-full bg-primary" />
                </div>
                <span className="text-[11px] font-mono text-muted-foreground uppercase tracking-widest">Step 2 of 2</span>
              </div>
              <h1 className="text-xl font-semibold tracking-tight">Operator profile</h1>
              <p className="text-sm text-muted-foreground mt-1">Tell us about your operation.</p>
            </div>

            <form onSubmit={handleSignupStep2} className="glass-card rounded-2xl p-6 space-y-4">
              <div>
                <label className="text-[11px] font-mono text-muted-foreground mb-1.5 block tracking-widest uppercase">Operator Name</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={operatorName}
                    onChange={(e) => setOperatorName(e.target.value)}
                    placeholder="e.g. SkyLink Operations"
                    className="w-full bg-secondary border border-border rounded-lg pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-mono text-muted-foreground mb-1.5 block tracking-widest uppercase">Aircraft Registration ID</label>
                <div className="relative">
                  <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={aircraftId}
                    onChange={(e) => setAircraftId(e.target.value)}
                    placeholder="e.g. N-VTOL-4827"
                    className="w-full bg-secondary border border-border rounded-lg pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-lg py-2.5 font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 mt-1"
              >
                {loading ? "Creating account…" : <><span>Create Account</span><ArrowRight className="w-4 h-4" /></>}
              </button>
            </form>

            <button
              onClick={() => setScreen("signup-1")}
              className="flex items-center gap-1.5 mx-auto mt-5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Back
            </button>
          </motion.div>
        )}

        {/* ── Password Reset ── */}
        {screen === "reset" && (
          <motion.div
            key="reset"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.22 }}
            className="w-full max-w-sm"
          >
            <div className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight">Reset password</h1>
              <p className="text-sm text-muted-foreground mt-1">We'll send a reset link to your email.</p>
            </div>

            <form onSubmit={handleReset} className="glass-card rounded-2xl p-6 space-y-4">
              <div>
                <label className="text-[11px] font-mono text-muted-foreground mb-1.5 block tracking-widest uppercase">Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="pilot@shnav.air"
                    className="w-full bg-secondary border border-border rounded-lg pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-lg py-2.5 font-semibold text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? "Sending…" : <><span>Send Reset Link</span><ArrowRight className="w-4 h-4" /></>}
              </button>
            </form>

            <button
              onClick={() => setScreen("login")}
              className="flex items-center gap-1.5 mx-auto mt-5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Back to sign in
            </button>
          </motion.div>
        )}

        {/* ── Reset Sent ── */}
        {screen === "reset-sent" && (
          <motion.div
            key="reset-sent"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="w-full max-w-sm"
          >
            <div className="glass-card rounded-2xl p-8 text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center mx-auto">
                <Mail className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold">Check your inbox</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Reset link sent to <span className="font-mono text-foreground">{email}</span>.
                </p>
              </div>
              <button
                onClick={() => { setScreen("login"); }}
                className="text-primary text-xs hover:underline font-mono"
              >
                Back to sign in
              </button>
            </div>
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}
