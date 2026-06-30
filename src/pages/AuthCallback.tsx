import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Plane } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export default function AuthCallback() {
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const exchange = async () => {
      // The URL contains ?code=... from Supabase after Google OAuth
      const { error } = await supabase.auth.exchangeCodeForSession(window.location.href);
      if (error) {
        console.error("OAuth callback error:", error.message);
        navigate("/auth", { replace: true });
      } else {
        navigate("/dashboard", { replace: true });
      }
    };

    exchange();
  }, [navigate]);

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
      <motion.div
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ repeat: Infinity, duration: 1.4 }}
      >
        <Plane className="w-6 h-6 text-primary" />
      </motion.div>
      <p className="text-sm font-mono text-muted-foreground">Signing you in...</p>
    </div>
  );
}
