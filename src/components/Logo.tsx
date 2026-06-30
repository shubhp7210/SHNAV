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
    <div className={cn("flex items-center gap-2 select-none", className)}>
      {/* Logo PNG lives on a white bg — wrap it in a tight icon container */}
      <div
        className="rounded-lg overflow-hidden bg-white flex-shrink-0 flex items-center justify-center"
        style={{ width: size, height: size }}
      >
        <img
          src={logo}
          alt="SHNAV"
          width={size}
          height={size}
          className="object-contain"
        />
      </div>
      {showWordmark && (
        <span
          className={cn(
            "font-bold tracking-[0.18em] text-primary",
            compact ? "text-[11px]" : "text-sm"
          )}
        >
          SHNAV
        </span>
      )}
    </div>
  );
}
