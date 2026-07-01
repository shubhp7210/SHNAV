import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Home } from "lucide-react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <p className="text-[11px] font-mono text-muted-foreground tracking-widest uppercase">Error 404</p>
        <h1 className="text-5xl font-bold">Page not found</h1>
        <p className="text-muted-foreground">This route doesn't exist in the airspace.</p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 mt-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          <Home className="w-4 h-4" />
          Back to home
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
