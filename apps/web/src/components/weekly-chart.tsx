/**
 * Weekly line chart, hand-written SVG (no chart library). Follows the dataviz
 * method: one y axis, fixed categorical slots per platform, 2px lines, 8px
 * markers with a 2px surface ring, recessive grid, a legend for two or more
 * series and a direct label at the last point of each series. The values are
 * also exposed as a table by the page (relief rule for the low-contrast slots).
 */

export interface Series {
  id: string;
  label: string;
  /** Categorical slot, fixed per platform. */
  slot: 1 | 2 | 3 | 4;
  points: { x: string; y: number | null }[];
}

const SLOT_COLOR: Record<1 | 2 | 3 | 4, string> = {
  1: '#2a78d6',
  2: '#eb6834',
  3: '#1baf7a',
  4: '#eda100',
};

const W = 720;
const H = 260;
const PAD = { top: 16, right: 96, bottom: 32, left: 56 };

function niceMax(v: number): number {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * p;
}

export function WeeklyChart({ series, unit }: { series: Series[]; unit: string }) {
  const xs = series[0]?.points.map((p) => p.x) ?? [];
  if (xs.length === 0 || series.length === 0) {
    return <p className="text-sm text-[var(--muted)]">Nothing to chart yet.</p>;
  }
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.y ?? 0))));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xAt = (i: number) =>
    PAD.left + (xs.length === 1 ? innerW / 2 : (i / (xs.length - 1)) * innerW);
  const yAt = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const fmtTick = (v: number) =>
    v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v));
  const labelEvery = Math.max(1, Math.ceil(xs.length / 8));

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${unit} per week by platform`}
        className="h-auto w-full"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yAt(t)}
              y2={yAt(t)}
              stroke="#e5e7eb"
              strokeWidth="1"
            />
            <text x={PAD.left - 8} y={yAt(t) + 4} textAnchor="end" fontSize="11" fill="#6b7280">
              {fmtTick(t)}
            </text>
          </g>
        ))}
        {xs.map((x, i) =>
          i % labelEvery === 0 || i === xs.length - 1 ? (
            <text
              key={x}
              x={xAt(i)}
              y={H - PAD.bottom + 18}
              textAnchor="middle"
              fontSize="11"
              fill="#6b7280"
            >
              {x.slice(5)}
            </text>
          ) : null,
        )}
        {series.map((s) => {
          const color = SLOT_COLOR[s.slot];
          const segs: string[] = [];
          let d = '';
          s.points.forEach((p, i) => {
            if (p.y === null) {
              if (d) segs.push(d);
              d = '';
              return;
            }
            d += `${d ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(p.y).toFixed(1)} `;
          });
          if (d) segs.push(d);
          const last = [...s.points].reverse().find((p) => p.y !== null);
          const lastIdx = last ? s.points.lastIndexOf(last) : -1;
          return (
            <g key={s.id}>
              {segs.map((seg, i) => (
                <path
                  key={i}
                  d={seg}
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              ))}
              {s.points.map((p, i) =>
                p.y === null ? null : (
                  <circle
                    key={i}
                    cx={xAt(i)}
                    cy={yAt(p.y)}
                    r="4"
                    fill={color}
                    stroke="#ffffff"
                    strokeWidth="2"
                  >
                    <title>{`${s.label} · week of ${p.x}: ${p.y.toLocaleString('en-US')} ${unit.toLowerCase()}`}</title>
                  </circle>
                ),
              )}
              {last && last.y !== null && (
                <text x={xAt(lastIdx) + 8} y={yAt(last.y) + 4} fontSize="11" fill="#171717">
                  {s.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {series.length >= 2 && (
        <figcaption className="mt-1 flex flex-wrap gap-4 text-xs text-[var(--muted)]">
          {series.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: SLOT_COLOR[s.slot] }}
              />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
