import { cn } from "@/lib/utils";
import logo from "@/assets/altos-logo.png";

interface LogoProps {
  className?: string;
  size?: number;
  showWordmark?: boolean;
  compact?: boolean;
}

/**
 * ALTOS brand mark.
 * Renders the winged "A" logo (white on transparent thanks to mix-blend-mode) and an
 * optional clean wordmark. Designed to live on dark surfaces only.
 */
export default function Logo({ className, size = 28, showWordmark = true, compact = false }: LogoProps) {
  return (
    <div className={cn("flex items-center gap-2.5 select-none", className)}>
      <img
        src={logo}
        alt="Altos"
        width={size}
        height={size}
        className="object-contain"
        style={{
          // Logo asset has black background — use screen blend so only the white mark shows
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
          ALTOS
        </span>
      )}
    </div>
  );
}
