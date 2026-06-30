import Logo from "@/components/Logo";

const Footer = () => {
  return (
    <footer className="relative border-t border-white/5 mt-24">
      <div className="container py-10 flex flex-col md:flex-row items-center justify-between gap-6">
        <Logo size={20} compact />
        <p className="text-[11px] font-mono tracking-widest uppercase text-foreground/40">
          Advanced Low Altitude Traffic Operation System
        </p>
        <p className="text-[11px] font-mono text-foreground/40">
          © {new Date().getFullYear()} ALTOS
        </p>
      </div>
    </footer>
  );
};

export default Footer;
