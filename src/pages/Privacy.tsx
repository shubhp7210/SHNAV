import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import Logo from "@/components/Logo";

/*
 * OWNER TODO — replace the bracketed placeholders below before publishing. These
 * are the only items this draft could not verify from the codebase and must NOT
 * be guessed:
 *   • [OPERATOR LEGAL ENTITY]   — the legal entity that operates SHNAV
 *   • [CONTACT EMAIL]           — a monitored privacy/support contact address
 *   • [DATA RETENTION PERIOD]   — how long flight/account data is kept
 *   • [JURISDICTION]            — governing jurisdiction, if you choose to state one
 *   • [ACCOUNT DELETION PATH]   — the actual self-serve or request-based deletion flow
 * This policy describes the data flows present in the code as of the date below.
 * It intentionally makes no claim of compliance with any specific law (e.g. GDPR,
 * CCPA) — add such statements only after verifying the applicable requirements.
 */

const LAST_UPDATED = "19 October 2026";

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-3">
    <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
    <div className="space-y-3 text-sm leading-relaxed text-foreground/70">{children}</div>
  </section>
);

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-3xl py-10">
        <div className="flex items-center justify-between mb-10">
          <Logo size={26} showWordmark />
          <Link
            to="/"
            className="flex items-center gap-1.5 text-xs font-mono text-foreground/50 hover:text-primary transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Home
          </Link>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="text-xs font-mono text-foreground/40 mt-2 mb-10">
          Last updated: {LAST_UPDATED}
        </p>

        <div className="space-y-10">
          <Section title="Who we are">
            <p>
              SHNAV is an urban air traffic management platform for planning and monitoring
              low-altitude eVTOL and rotorcraft operations. The service is operated by{" "}
              <span className="text-foreground">[OPERATOR LEGAL ENTITY]</span>. This policy explains
              what information the service collects, how it is used, where it is stored, and who it
              is shared with.
            </p>
          </Section>

          <Section title="Information we collect">
            <p>We collect only what you provide and what the service needs to function:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <span className="text-foreground">Account details</span> — your email address and a
                password. Passwords are handled and stored by our authentication provider
                (Supabase Auth); we never see or store your raw password.
              </li>
              <li>
                <span className="text-foreground">Operator profile</span> — the operator name and
                aircraft registration ID you enter at sign-up.
              </li>
              <li>
                <span className="text-foreground">Flight operations data</span> — the flight plans
                you create and their results: origin and destination, altitude band, departure
                windows, computed routes, trajectory positions (latitude/longitude), scheduling and
                decision outputs, detected anomalies, and flight outcomes.
              </li>
              <li>
                <span className="text-foreground">Derived performance data</span> — aggregate
                patterns and an operator error/confidence profile computed from your own flight
                history to improve recommendations for your account.
              </li>
            </ul>
            <p>
              We do <span className="text-foreground">not</span> use third-party advertising or
              analytics trackers, and the service sets no tracking cookies.
            </p>
          </Section>

          <Section title="How your information is used">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>To authenticate you and maintain your session.</li>
              <li>To plan, optimize, schedule, and monitor the flights you submit.</li>
              <li>
                To generate weather, routing, and decision recommendations for your operations.
              </li>
              <li>
                To improve the quality of recommendations for your own account based on your flight
                history.
              </li>
            </ul>
          </Section>

          <Section title="Where your data is stored">
            <p>
              Your account and flight data are stored in a managed{" "}
              <span className="text-foreground">Supabase</span> project (PostgreSQL database, with
              authentication and serverless edge functions). Access is restricted per account
              through database row-level security, so operators can access only their own records.
            </p>
          </Section>

          <Section title="Third-party services and data sharing">
            <p>
              We do not sell your data. Data is shared with the following service providers only to
              the extent needed to operate the service:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <span className="text-foreground">Supabase</span> — hosting of the database,
                authentication, and backend functions. Stores all account and flight data described
                above.
              </li>
              <li>
                <span className="text-foreground">Open-Meteo</span> — weather forecasting. Receives
                only geographic coordinates (latitude/longitude) for the areas relevant to a flight;
                it receives no account or identity information.
              </li>
              <li>
                <span className="text-foreground">OpenStreetMap / Nominatim</span> — geocoding of
                place names. Receives the location text you type when it cannot be resolved locally.
              </li>
              <li>
                <span className="text-foreground">OpenFreeMap</span> — map tiles used to render maps
                in your browser.
              </li>
              <li>
                <span className="text-foreground">Google</span> — only if you choose "Continue with
                Google" to sign in; Google then provides us your basic account identifier and email
                for authentication.
              </li>
            </ul>
          </Section>

          <Section title="Data retention and deletion">
            <p>
              We retain your account and flight data for as long as your account is active, and for{" "}
              <span className="text-foreground">[DATA RETENTION PERIOD]</span> thereafter, unless a
              longer period is required for legitimate operational or legal reasons.
            </p>
            <p>
              You can request access to, correction of, or deletion of your data, and deletion of
              your account, via <span className="text-foreground">[ACCOUNT DELETION PATH]</span>. On
              account deletion we remove your account and the personal data associated with it,
              subject to any data we are required to retain.
            </p>
          </Section>

          <Section title="How we protect your data">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>All traffic between your browser, our backend, and third-party APIs is encrypted in transit (HTTPS).</li>
              <li>Access to flight records is enforced per account through database row-level security.</li>
              <li>Backend functions require a valid authentication token for every request.</li>
              <li>Your session token is held in your browser's session storage and cleared when the tab closes.</li>
            </ul>
            <p>
              No system can be guaranteed perfectly secure, but we work to protect your data using
              the measures above.
            </p>
          </Section>

          <Section title="Children's privacy">
            <p>SHNAV is a professional operations tool and is not directed to children.</p>
          </Section>

          <Section title="Changes to this policy">
            <p>
              We may update this policy from time to time. Material changes will be reflected by the
              "last updated" date above.
            </p>
          </Section>

          <Section title="Contact us">
            <p>
              Questions about this policy or your data? Contact{" "}
              <span className="text-foreground">[OPERATOR LEGAL ENTITY]</span> at{" "}
              <a href="mailto:[CONTACT EMAIL]" className="text-primary hover:underline">
                [CONTACT EMAIL]
              </a>
              .
            </p>
          </Section>
        </div>

        <div className="mt-14 pt-6 border-t border-white/5">
          <Link to="/" className="text-xs font-mono text-foreground/40 hover:text-primary transition-colors">
            ← Back to SHNAV
          </Link>
        </div>
      </div>
    </div>
  );
}
