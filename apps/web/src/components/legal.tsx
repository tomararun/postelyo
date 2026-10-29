import Link from 'next/link';
import { Logo } from '@/components/icons';
import { Notice } from '@/components/ui';

/** Placeholder wording (Phase 3); mirrors apps/api routes/legal.ts. Replace after legal review. */
export const PRIVACY = [
  'Postelyo stores the content you schedule, the results of publishing it, the social accounts you connect (access tokens encrypted at rest) and the Notion integration token you provide, in order to publish on your behalf and report back.',
  'We do not sell data. Tokens are decrypted only inside the background worker at publish time and never shown in the interface or logs.',
  'Deleting a workspace removes its content, connections and tokens; anonymised audit records are retained for security purposes.',
  'Contact: privacy@postelyo.example (placeholder).',
];

export const TERMS = [
  'Postelyo publishes content to third-party platforms on your instruction. You are responsible for the content and for complying with each platform’s terms (LinkedIn, X, Meta).',
  'The service is provided as is during the pilot. Availability targets and support terms will be published with paid plans.',
  'Plan limits are enforced as described on the Billing page; downgrades take effect after the current period or a grace period after failed payment.',
  'Contact: legal@postelyo.example (placeholder).',
];

export function LegalPage({ title, paragraphs }: { title: string; paragraphs: string[] }) {
  return (
    <div className="mx-auto max-w-2xl space-y-5 px-6 py-12">
      <Link href="/" className="flex items-center gap-2.5">
        <Logo />
        <span className="text-lg font-semibold tracking-tight">Postelyo</span>
      </Link>
      <h1 className="pt-6 text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
      <Notice kind="info">Placeholder text pending legal review.</Notice>
      {paragraphs.map((p) => (
        <p key={p} className="text-[15px] leading-7 text-slate-700">
          {p}
        </p>
      ))}
    </div>
  );
}
