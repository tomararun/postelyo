import { Shell } from '@/components/shell';
import { Badge, Card, Notice, Table } from '@/components/ui';
import { api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';
import { WeeklyChart, type Series } from '@/components/weekly-chart';

interface WeeklyRow {
  week: string;
  weekStart: string;
  platform: string;
  posts: number;
  impressions: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
  engagementRate: number | null;
}
interface TopPost {
  publicationId: string;
  title: string;
  platform: string;
  accountName: string | null;
  url: string | null;
  publishedAt: string;
  metrics: {
    impressions: number | null;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
    clicks: number | null;
  };
  engagement: number;
}
interface Summary {
  weeks: WeeklyRow[];
  topPosts: TopPost[];
  hashtags: {
    hashtag: string;
    posts: number;
    avgEngagement: number;
    avgImpressions: number | null;
  }[];
  bestTimes: {
    timeZone: string;
    basis: 'history' | 'defaults';
    minimumPosts: number;
    slots: { weekday: number; hour: number; posts: number; avgEngagementRate: number | null }[];
  };
  generatedAt: string;
}

/** Fixed categorical order (dataviz method): identity never changes with the filter. */
const PLATFORMS: { id: string; label: string; slot: 1 | 2 | 3 | 4 }[] = [
  { id: 'linkedin', label: 'LinkedIn', slot: 1 },
  { id: 'x', label: 'X', slot: 2 },
  { id: 'facebook', label: 'Facebook', slot: 3 },
  { id: 'instagram', label: 'Instagram', slot: 4 },
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const n = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'));
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ weeks?: string; metric?: string }>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const weeks = [4, 8, 12, 26].includes(Number(q.weeks)) ? Number(q.weeks) : 8;
  const metric = (['impressions', 'engagement', 'clicks'] as const).includes(
    q.metric as 'impressions',
  )
    ? (q.metric as 'impressions' | 'engagement' | 'clicks')
    : 'impressions';
  const { me, membership } = await loadWorkspace(workspaceId, `/w/${workspaceId}/analytics`);
  const s = await api<Summary>(`/v1/workspaces/${workspaceId}/analytics?weeks=${weeks}`);

  const weekKeys = [...new Set(s.weeks.map((w) => w.weekStart))].sort();
  const valueOf = (r: WeeklyRow | undefined): number | null => {
    if (!r) return null;
    if (metric === 'impressions') return r.impressions;
    if (metric === 'clicks') return r.clicks;
    return r.reactions === null && r.comments === null && r.shares === null
      ? null
      : (r.reactions ?? 0) + (r.comments ?? 0) + (r.shares ?? 0);
  };
  const present = PLATFORMS.filter((p) => s.weeks.some((w) => w.platform === p.id && w.posts > 0));
  const series: Series[] = present.map((p) => ({
    id: p.id,
    label: p.label,
    slot: p.slot,
    points: weekKeys.map((k) => ({
      x: k,
      y: valueOf(s.weeks.find((w) => w.weekStart === k && w.platform === p.id)),
    })),
  }));
  const allRows = weekKeys.map((k) =>
    s.weeks.find((w) => w.weekStart === k && w.platform === 'all'),
  );
  const totalPosts = allRows.reduce((acc, r) => acc + (r?.posts ?? 0), 0);
  const metricLabel = { impressions: 'Impressions', engagement: 'Engagements', clicks: 'Clicks' }[
    metric
  ];
  const link = (w: number, m: string) => `/w/${workspaceId}/analytics?weeks=${w}&metric=${m}`;

  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-[var(--muted)]">Range</span>
        {[4, 8, 12, 26].map((w) => (
          <a
            key={w}
            href={link(w, metric)}
            className={w === weeks ? 'font-semibold underline' : 'text-[var(--muted)]'}
          >
            {w} weeks
          </a>
        ))}
        <span className="ml-4 text-[var(--muted)]">Metric</span>
        {(['impressions', 'engagement', 'clicks'] as const).map((m) => (
          <a
            key={m}
            href={link(weeks, m)}
            className={m === metric ? 'font-semibold underline' : 'text-[var(--muted)]'}
          >
            {m}
          </a>
        ))}
        <span className="ml-auto text-[var(--muted)]">Updated {fmt(s.generatedAt)}</span>
      </div>

      {totalPosts === 0 ? (
        <Notice kind="info">
          No metrics yet. Numbers appear about an hour after a post is published and are refreshed
          at 6 hours, 24 hours, 7 days and 30 days.
        </Notice>
      ) : (
        <Card title={`${metricLabel} per week by platform`}>
          <WeeklyChart series={series} unit={metricLabel} />
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-[var(--muted)]">Table view</summary>
            <Table
              head={[
                'Week',
                'Platform',
                'Posts',
                'Impressions',
                'Reach',
                'Reactions',
                'Comments',
                'Shares',
                'Clicks',
                'Engagement',
              ]}
            >
              {s.weeks
                .filter((w) => w.posts > 0)
                .map((w) => (
                  <tr key={`${w.weekStart}:${w.platform}`}>
                    <td className="py-1 pr-3">{w.week}</td>
                    <td className="py-1 pr-3">
                      {w.platform === 'all'
                        ? 'All'
                        : (PLATFORMS.find((p) => p.id === w.platform)?.label ?? w.platform)}
                    </td>
                    <td className="py-1 pr-3">{w.posts}</td>
                    <td className="py-1 pr-3">{n(w.impressions)}</td>
                    <td className="py-1 pr-3">{n(w.reach)}</td>
                    <td className="py-1 pr-3">{n(w.reactions)}</td>
                    <td className="py-1 pr-3">{n(w.comments)}</td>
                    <td className="py-1 pr-3">{n(w.shares)}</td>
                    <td className="py-1 pr-3">{n(w.clicks)}</td>
                    <td className="py-1">{pct(w.engagementRate)}</td>
                  </tr>
                ))}
            </Table>
          </details>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Top posts">
          {s.topPosts.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              Nothing published with metrics in this range.
            </p>
          ) : (
            <Table head={['Post', 'Engagements', 'Impressions']}>
              {s.topPosts.map((t) => (
                <tr key={t.publicationId}>
                  <td className="py-2 pr-3">
                    <a
                      href={`/w/${workspaceId}/publications/${t.publicationId}`}
                      className="font-medium hover:underline"
                    >
                      {t.title}
                    </a>
                    <div className="text-xs text-[var(--muted)]">
                      {PLATFORMS.find((p) => p.id === t.platform)?.label ?? t.platform}
                      {t.accountName ? ` · ${t.accountName}` : ''} · {fmt(t.publishedAt)}
                      {t.url && (
                        <>
                          {' '}
                          <a href={t.url} rel="noopener" className="underline">
                            view
                          </a>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3">{t.engagement}</td>
                  <td className="py-2">{n(t.metrics.impressions)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Best times to publish">
          <p className="mb-2 text-sm text-[var(--muted)]">
            {s.bestTimes.basis === 'history'
              ? `From your history in ${s.bestTimes.timeZone}. Suggestions only.`
              : `Platform defaults until at least ${s.bestTimes.minimumPosts} posts land in one weekday and hour (${s.bestTimes.timeZone}).`}
          </p>
          <ul className="space-y-1 text-sm">
            {s.bestTimes.slots.map((b) => (
              <li key={`${b.weekday}:${b.hour}`} className="flex items-center gap-2">
                <Badge tone={s.bestTimes.basis === 'history' ? 'success' : 'neutral'}>
                  {WEEKDAYS[b.weekday - 1]} {String(b.hour).padStart(2, '0')}:00
                </Badge>
                {b.avgEngagementRate !== null && (
                  <span className="text-[var(--muted)]">
                    {pct(b.avgEngagementRate)} engagement over {b.posts} posts
                  </span>
                )}
              </li>
            ))}
          </ul>
          <h3 className="mt-5 mb-2 text-sm font-semibold">Hashtags</h3>
          {s.hashtags.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              A hashtag needs two posts with metrics before it shows here.
            </p>
          ) : (
            <Table head={['Hashtag', 'Posts', 'Avg engagements', 'Avg impressions']}>
              {s.hashtags.slice(0, 10).map((h) => (
                <tr key={h.hashtag}>
                  <td className="py-1 pr-3">#{h.hashtag}</td>
                  <td className="py-1 pr-3">{h.posts}</td>
                  <td className="py-1 pr-3">{h.avgEngagement.toFixed(1)}</td>
                  <td className="py-1">
                    {h.avgImpressions === null
                      ? '—'
                      : Math.round(h.avgImpressions).toLocaleString('en-US')}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </Shell>
  );
}
