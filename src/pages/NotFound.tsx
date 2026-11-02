import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Home } from "lucide-react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background grid-pattern px-5">
      <div className="text-center space-y-4">
        <p className="label-caps text-primary/90">Error 404 · Off route</p>
        <h1 className="text-5xl sm:text-6xl font-semibold">Page not found</h1>
        <p className="text-muted-foreground">This route doesn't exist in the airspace.</p>
        <p className="font-mono text-xs text-muted-foreground/70 break-all">{location.pathname}</p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 mt-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:brightness-110 transition"
        >
          <Home className="w-4 h-4" />
          Back to home
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
