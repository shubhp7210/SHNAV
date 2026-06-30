import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X, ArrowUpRight } from "lucide-react";
import Logo from "@/components/Logo";
import { useAuth } from "@/contexts/AuthContext";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/plan", label: "Plan" },
  { to: "/dashboard", label: "Operations" },
];

export default function TopDock() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (pathname.startsWith("/auth")) return null;

  return (
    <>
      <motion.header
        initial={{ y: -24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="fixed top-3 inset-x-0 z-50 flex justify-center px-3 pointer-events-none"
      >
        <div
          className={`pointer-events-auto flex items-center gap-1 rounded-full px-2 py-2 transition-all duration-300 ${
            scrolled
              ? "bg-background/75 border border-white/10 backdrop-blur-xl shadow-[0_8px_32px_-12px_rgba(0,0,0,0.7)]"
              : "bg-background/25 border border-white/6 backdrop-blur-md"
          }`}
        >
          <Link to="/" className="flex items-center pl-2 pr-3 py-0.5">
            <Logo size={22} compact />
          </Link>

          <div className="hidden md:flex items-center gap-0.5">
            {NAV.map((item) => {
              const active = pathname === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`relative px-3.5 py-1.5 text-[12px] font-medium tracking-wide rounded-full transition-colors ${
                    active ? "text-foreground" : "text-foreground/50 hover:text-foreground"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="dock-pill"
                      className="absolute inset-0 rounded-full bg-white/7 border border-white/10"
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    />
                  )}
                  <span className="relative">{item.label}</span>
                </Link>
              );
            })}
          </div>

          <button
            onClick={() => navigate(session ? "/dashboard" : "/auth")}
            className="hidden md:inline-flex items-center gap-1 ml-1 pl-3.5 pr-3 py-1.5 rounded-full bg-primary text-primary-foreground text-[12px] font-semibold hover:bg-primary/88 transition-colors"
          >
            {session ? "Open" : "Launch"}
            <ArrowUpRight className="w-3 h-3" strokeWidth={2.5} />
          </button>

          <button
            onClick={() => setOpen(true)}
            className="md:hidden p-2 text-foreground/70"
            aria-label="Open menu"
          >
            <Menu className="w-4 h-4" />
          </button>
        </div>
      </motion.header>

      {/* Mobile sheet */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] md:hidden bg-background/96 backdrop-blur-xl flex flex-col"
          >
            <div className="flex items-center justify-between p-4">
              <Logo size={24} compact />
              <button onClick={() => setOpen(false)} className="p-2 text-foreground/60 hover:text-foreground transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 flex flex-col items-center justify-center gap-1 -mt-12">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setOpen(false)}
                  className="text-[2.5rem] font-semibold tracking-tight text-foreground/75 hover:text-foreground py-2 transition-colors"
                >
                  {item.label}
                </Link>
              ))}
              <button
                onClick={() => { setOpen(false); navigate(session ? "/dashboard" : "/auth"); }}
                className="mt-10 px-7 py-3 rounded-full bg-primary text-primary-foreground font-semibold text-base hover:bg-primary/90 transition-colors"
              >
                {session ? "Open app" : "Launch app"}
              </button>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
