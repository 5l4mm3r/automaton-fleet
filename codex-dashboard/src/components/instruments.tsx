import type { Agent } from '@/lib/fleet';

export function Operative({ agent, large = false }: { agent: Agent; large?: boolean }) {
  return <svg className={`operative ${agent.colour} ${large ? 'large' : ''}`} viewBox="0 0 32 44" shapeRendering="crispEdges" aria-label={`${agent.name}, pixel operative`} role="img">
    <path fill="#071018" d="M8 4h16v3h3v14h-3v4h4v12h-5v7h-8v-5h-2v5H5v-9H3V25h5z" />
    <path fill="currentColor" d="M9 5h14v3h3v10h-3V9H9v9H6V8h3zM7 24h18v10H7zM4 26h3v8H4zM25 26h3v8h-3z" />
    <path fill="#8babae" d="M10 17h12v6H10zM9 35h5v6H9zM18 35h5v6h-5z" />
    <path fill="#dce9de" d="M10 10h12v6H10z" />
    <path fill="#102c35" d="M9 11h14v4H9zM10 25h12v6H10z" />
    <path fill="#a9fbda" d="M11 12h4v1h-4zM19 12h3v1h-3zM12 26h3v2h-3z" />
    <path fill="#42626a" d="M7 32h18v3H7zM6 41h9v3H6zM18 41h9v3h-9z" />
    <path fill="#f7bb5d" d="M20 27h2v3h-2z" />
  </svg>;
}

export function Trend({ values }: { values: number[] }) {
  const min = Math.min(...values) * .94, max = Math.max(...values) * 1.03;
  const points = values.map((v,i) => `${20+i*660/Math.max(1,values.length-1)},${160-(v-min)/(max-min||1)*130}`).join(' ');
  return <svg className="trend" viewBox="0 0 700 190" role="img" aria-label="Simulated Treasury balance history">
    {[30,70,110,150].map(y => <line key={y} x1="20" x2="680" y1={y} y2={y} className="grid-line" />)}
    <polygon points={`20,170 ${points} 680,170`} fill="#23d5b516" />
    <polyline points={points} fill="none" stroke="#54dec7" strokeWidth="3" />
    <text x="20" y="188">EARLIER</text><text x="638" y="188">LATEST</text>
  </svg>;
}

export function Gauge({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = Math.max(0,Math.min(100,value/max*100));
  return <div className="gauge"><svg viewBox="0 0 180 105" role="img" aria-label={`${label}: ${Math.round(percent)} percent`}>
    <path d="M20 90 A70 70 0 0 1 160 90" fill="none" stroke="#23343b" strokeWidth="12" />
    <path d="M20 90 A70 70 0 0 1 160 90" fill="none" stroke="#54dec7" strokeWidth="12" pathLength="100" strokeDasharray={`${percent} 100`} />
    <text x="90" y="82" textAnchor="middle">{Math.round(percent)}%</text>
  </svg><span>{label}</span></div>;
}
