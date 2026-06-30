import { cn } from "@/lib/utils";
import logo from "@/assets/shnav-logo.png";

interface LogoProps {
  className?: string;
  size?: number;
  showWordmark?: boolean;
  compact?: boolean;
}

export default function Logo({ className, size = 28, showWordmark = true, compact = false }: LogoProps) {
  return (
    <div className={cn("flex items-center gap-2.5 select-none", className)}>
      <img
        src={logo}
        alt="SHNAV"
        width={size}
        height={size}
        className="object-contain"
        style={{
          mixBlendMode: "screen",
          filter: "drop-shadow(0 0 12px hsl(0 0% 100% / 0.18))",
        }}
      />
      {showWordmark && (
        <span
          className={cn(
            "font-semibold tracking-[0.22em] text-foreground/95",
            compact ? "text-xs" : "text-sm"
          )}
        >
          SHNAV
        </span>
      )}
    </div>
  );
}
