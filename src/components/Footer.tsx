import { Link } from "react-router-dom";
import Logo from "@/components/Logo";

const Footer = () => {
  return (
    <footer className="relative border-t border-border bg-background">
      <div className="container px-5 sm:px-8 py-10 flex flex-col md:flex-row items-center justify-between gap-6 pb-[calc(2.5rem+env(safe-area-inset-bottom,0px))]">
        <div className="flex items-center gap-4">
          <Logo size={24} compact />
          <span className="hidden sm:inline label-caps">Urban air traffic management</span>
        </div>
        <nav className="flex items-center gap-5 text-xs text-foreground/50" aria-label="Footer">
          <Link to="/plan" className="hover:text-foreground transition-colors">Plan</Link>
          <Link to="/dashboard" className="hover:text-foreground transition-colors">Operations</Link>
          <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
          <span className="font-mono text-foreground/35">© {new Date().getFullYear()} SHNAV</span>
        </nav>
      </div>
    </footer>
  );
};

export default Footer;
