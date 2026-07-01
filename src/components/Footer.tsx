import { Link } from "react-router-dom";
import Logo from "@/components/Logo";

const Footer = () => {
  return (
    <footer className="relative border-t border-white/5 mt-0">
      <div className="container py-12 flex flex-col md:flex-row items-center justify-between gap-6">
        <Logo size={22} compact />
        <p className="text-[11px] font-mono tracking-[0.2em] uppercase text-foreground/35">
          Urban air traffic management
        </p>
        <div className="flex items-center gap-4 text-[11px] font-mono text-foreground/35">
          <Link to="/plan" className="hover:text-primary transition-colors">Plan</Link>
          <Link to="/dashboard" className="hover:text-primary transition-colors">Ops</Link>
          <span>© {new Date().getFullYear()} SHNAV</span>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
