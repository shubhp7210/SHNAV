import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Optional custom fallback UI. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

// Top-level error boundary. Catches uncaught render errors in any descendant
// component and presents a recovery screen instead of a blank page. Without
// this, a single crash anywhere in the tree wipes the whole UI.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console so the developer/devtools can inspect.
    // In production this is the only signal we have — replace with a
    // remote logger (Sentry, Logtail, etc.) when one is wired up.
    console.error("[ErrorBoundary] uncaught render error", error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.handleReset);

    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border rounded-xl p-6 space-y-5 shadow-xl">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-full bg-red-500/10 border border-red-500/30">
              <AlertTriangle className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h1 className="text-base font-bold text-foreground">Something went wrong</h1>
              <p className="text-xs text-muted-foreground mt-0.5">An unexpected error broke this view.</p>
            </div>
          </div>
          <div className="rounded-md bg-secondary/50 border border-border/40 p-3 max-h-32 overflow-auto">
            <code className="text-[11px] font-mono text-muted-foreground break-words">
              {error.message || "Unknown error"}
            </code>
          </div>
          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <RotateCw className="w-4 h-4" />
              Try again
            </button>
            <button
              onClick={this.handleReload}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-secondary text-foreground text-sm font-medium border border-border hover:bg-secondary/80 transition-colors"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
