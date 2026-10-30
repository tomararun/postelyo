import { ImageResponse } from 'next/og';

export const alt = 'Postelyo · Plan in Notion, publish everywhere';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Social share preview generated at build time; shown when a Postelyo link is posted. */
export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 45%, #5b21b6 100%)',
        color: 'white',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 18,
            background: 'linear-gradient(135deg, #6366f1, #7c3aed)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 34,
            fontWeight: 700,
          }}
        >
          P
        </div>
        <div style={{ fontSize: 36, fontWeight: 600 }}>Postelyo</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>Plan in Notion.</div>
        <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05, color: '#c7d2fe' }}>
          Publish everywhere.
        </div>
        <div style={{ marginTop: 28, fontSize: 30, color: '#c7d2fe' }}>
          LinkedIn · X · Facebook · Instagram, scheduled from your Notion database
        </div>
      </div>
    </div>,
    size,
  );
}
