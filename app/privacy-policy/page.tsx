import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — FocusOS",
  description: "How FocusOS collects, uses, and protects your information."
};

// Update this whenever the content below changes materially.
const LAST_UPDATED = "September 19, 2026";

// TODO: replace with a real, monitored contact address before this page goes live for real users.
const CONTACT_EMAIL = "privacy@focusos.app";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="mb-3 text-xl font-semibold text-ink-950 dark:text-ink-50">{title}</h2>
      <div className="space-y-3 text-sm leading-6 text-ink-600 dark:text-ink-300">{children}</div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-ink-50 px-4 py-10 dark:bg-ink-950">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-moss-600 text-base font-bold text-white">F</div>
          <div>
            <p className="text-sm font-semibold text-ink-950 dark:text-ink-50">FocusOS</p>
            <Link href="/dashboard" className="text-xs text-moss-700 hover:underline dark:text-moss-400">
              Back to the app
            </Link>
          </div>
        </div>

        <div className="rounded-lg border border-ink-200 bg-white p-6 shadow-soft dark:border-ink-800 dark:bg-ink-900 sm:p-10">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-950 dark:text-ink-50">Privacy Policy</h1>
          <p className="mt-2 text-sm text-ink-500">Last updated: {LAST_UPDATED}</p>
          <p className="mt-4 text-sm leading-6 text-ink-600 dark:text-ink-300">
            FocusOS is a planning tool for coursework, papers, and focused work. This page explains what information the app collects, why,
            and the choices you have. It describes what the product actually does, not a generic template — if a feature below doesn&apos;t
            sound familiar, it&apos;s because you haven&apos;t turned it on yet (most data categories here are tied to optional modules).
          </p>

          <nav className="my-8 rounded-md bg-ink-50 p-4 text-sm dark:bg-ink-800">
            <p className="mb-2 font-medium text-ink-700 dark:text-ink-200">On this page</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {[
                ["information-we-collect", "Information we collect"],
                ["how-we-use-it", "How we use it"],
                ["ai-features", "AI features"],
                ["google-calendar", "Google Calendar"],
                ["third-parties", "Third parties we rely on"],
                ["storage-and-security", "Storage and security"],
                ["retention", "Retention"],
                ["your-choices", "Your choices"],
                ["childrens-privacy", "Children's privacy"],
                ["changes", "Changes to this policy"],
                ["contact", "Contact"]
              ].map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`} className="text-moss-700 hover:underline dark:text-moss-400">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="space-y-10">
            <Section id="information-we-collect" title="Information we collect">
              <p>
                <strong className="text-ink-800 dark:text-ink-100">Account information.</strong> When you sign in, we receive what your
                sign-in method provides: an email address and display name (Google sign-in or email/password), or nothing beyond a random
                identifier (guest/anonymous sign-in). We don&apos;t ask for anything beyond what&apos;s needed to identify your account.
              </p>
              <p>
                <strong className="text-ink-800 dark:text-ink-100">Content you create.</strong> Everything you enter to use the app —
                tasks, courses, class sessions, assessments, papers and notes, goals, recurring commitments, your daily/weekly schedule,
                focus-session history, and settings — is stored so the app can show it back to you. This is the core of what FocusOS
                stores, and it&apos;s yours: see &ldquo;Your choices&rdquo; below for exporting or removing it.
              </p>
              <p>
                <strong className="text-ink-800 dark:text-ink-100">Uploaded files.</strong> If you attach a PDF to a paper, the file
                itself is stored with our hosting provider&apos;s file storage (Vercel Blob), separate from the rest of your data.
              </p>
              <p>
                <strong className="text-ink-800 dark:text-ink-100">Google Calendar data</strong> — only if you connect it (Settings →
                Google Calendar). See the dedicated section below; nothing calendar-related is collected unless you take that step.
              </p>
              <p>
                <strong className="text-ink-800 dark:text-ink-100">Usage data.</strong> We keep lightweight counters of app usage (for
                example, how much of your monthly AI usage allowance you&apos;ve used) so plan limits can be enforced. This is operational
                bookkeeping, not behavioral tracking — FocusOS does not use third-party analytics, advertising, or tracking scripts of any
                kind.
              </p>
            </Section>

            <Section id="how-we-use-it" title="How we use it">
              <p>We use your information to:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Operate the app — save and display your tasks, courses, papers, schedule, and everything else you create.</li>
                <li>Run the features you use — generate a recurring task, compute your daily workload, build a revision queue.</li>
                <li>Run AI features you trigger — described in detail below, since this is the one place your content leaves our own systems.</li>
                <li>Enforce the usage limits of your account&apos;s plan.</li>
                <li>Keep the app secure — detect misuse, debug errors, and maintain reliable service.</li>
              </ul>
              <p>We do not sell your information, and we do not use it for advertising.</p>
            </Section>

            <Section id="ai-features" title="AI features">
              <p>
                Several features are optional and AI-assisted — for example, drafting a checkpoint prep plan, summarizing a paper, or
                extracting highlights from an uploaded PDF. When you use one of these, the relevant content (the text of the prompt, or
                the paper you&apos;re asking about) is sent to a third-party AI provider to generate the response. Depending on
                configuration, that provider is Anthropic (Claude), Google (Gemini), or — if the app owner has configured one — a
                self-hosted model that never leaves their own infrastructure. A paper you ask the AI to analyze may be uploaded to
                Anthropic&apos;s file storage for that request.
              </p>
              <p>
                AI features run only when you trigger them (there&apos;s no background AI processing of your content without you asking
                for it), and each provider processes what&apos;s sent under its own terms and privacy policy, not ours. If an AI provider
                isn&apos;t configured or a usage budget has been reached, the app falls back to a deterministic, non-AI version of the
                same feature rather than silently failing.
              </p>
            </Section>

            <Section id="google-calendar" title="Google Calendar (optional)">
              <p>
                If you connect Google Calendar from Settings, FocusOS requests permission to: create and manage one calendar it makes for
                itself in your Google account (used to push your class times, assessment due dates, and timed recurring commitments —
                your other calendars are never written to), read events on your existing calendars (so those can eventually be reflected
                on your day timeline), and see the list of your calendars, plus your Google account&apos;s email address to show you which
                account is connected.
              </p>
              <p>
                The access token this grants is stored on our servers, never sent to your browser, and used only to run the sync you
                asked for. You can disconnect at any time from Settings, which revokes that access; the calendar FocusOS created in your
                Google account is left in place so you keep anything already on it, and you&apos;re free to delete it yourself from
                Google Calendar if you&apos;d rather not keep it.
              </p>
            </Section>

            <Section id="third-parties" title="Third parties we rely on">
              <p>FocusOS is built on a small number of infrastructure providers, each handling a specific job:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li><strong className="text-ink-800 dark:text-ink-100">Firebase (Google)</strong> — sign-in and the database that stores your account data.</li>
                <li><strong className="text-ink-800 dark:text-ink-100">Vercel</strong> — hosts the app and, if you upload a paper PDF, its file storage.</li>
                <li><strong className="text-ink-800 dark:text-ink-100">Anthropic</strong> — powers AI features you trigger (Claude), including paper analysis.</li>
                <li><strong className="text-ink-800 dark:text-ink-100">Google Gemini</strong> — an alternate AI provider some features can fall back to.</li>
                <li><strong className="text-ink-800 dark:text-ink-100">Google Calendar API</strong> — only if you connect Google Calendar, as described above.</li>
              </ul>
              <p>
                Each of these providers has its own privacy policy governing how it handles data on our behalf. We choose providers that
                are reputable and use industry-standard security practices, but we encourage you to review their policies if you want the
                full picture.
              </p>
            </Section>

            <Section id="storage-and-security" title="Storage and security">
              <p>
                Your data is stored in a Firestore database scoped to your account — the app is built so your data is only ever read and
                written under your own signed-in identity, and administrative access is limited to what&apos;s needed to operate the
                service. All traffic between your browser and our servers is encrypted (HTTPS). No method of storage or transmission is
                perfectly secure, and we can&apos;t guarantee absolute security, but we take reasonable, industry-standard steps to
                protect your information.
              </p>
            </Section>

            <Section id="retention" title="Data retention">
              <p>
                We keep your data for as long as your account exists, so the app can keep working the way you left it. If you ask us to
                delete your account (see &ldquo;Your choices&rdquo;), your data is removed from our active systems; residual copies may
                persist briefly in backups before they age out.
              </p>
            </Section>

            <Section id="your-choices" title="Your choices">
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong className="text-ink-800 dark:text-ink-100">Export your data.</strong> Settings → Export data lets you download
                  everything as a single JSON file, or your focus-session history as a CSV, at any time.
                </li>
                <li>
                  <strong className="text-ink-800 dark:text-ink-100">Turn off features.</strong> Settings → Features lets you disable
                  optional modules (Courses, Papers, Revise, Goals, and others) you don&apos;t want to use.
                </li>
                <li>
                  <strong className="text-ink-800 dark:text-ink-100">Disconnect Google Calendar</strong> at any time from Settings.
                </li>
                <li>
                  <strong className="text-ink-800 dark:text-ink-100">Delete your account.</strong> Account deletion is currently handled
                  by request rather than a self-service button — contact us (below) and we&apos;ll remove your account and its data.
                </li>
              </ul>
            </Section>

            <Section id="childrens-privacy" title="Children's privacy">
              <p>
                FocusOS is intended for students and researchers and is not directed at children under 13. We don&apos;t knowingly
                collect personal information from children under 13; if you believe a child has provided us information, contact us and
                we&apos;ll remove it.
              </p>
            </Section>

            <Section id="changes" title="Changes to this policy">
              <p>
                If this policy changes in a material way, we&apos;ll update the date at the top of this page. Continuing to use FocusOS
                after a change means you accept the updated policy.
              </p>
            </Section>

            <Section id="contact" title="Contact">
              <p>
                Questions about this policy, or a request to export or delete your data — reach us at{" "}
                <a className="text-moss-700 hover:underline dark:text-moss-400" href={`mailto:${CONTACT_EMAIL}`}>
                  {CONTACT_EMAIL}
                </a>
                .
              </p>
            </Section>
          </div>
        </div>
      </div>
    </main>
  );
}
