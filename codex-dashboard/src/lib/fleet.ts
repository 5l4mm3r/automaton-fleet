export type Agent = { id: string; name: string; role: string; status: 'active' | 'held' | 'dead'; cash: number; burn: number; colour: string; venture: string; events: string[] };
export type Notice = { id: string; title: string; level: 'RED' | 'AMBER' | 'INFO'; acknowledged: boolean; time: string };
export type Fleet = {
  treasury: number; contributed: number; revenue: number; spend: number; tick: number;
  agents: Agent[]; notices: Notice[];
  ledger: { id: string; label: string; amount: number; balance: number; time: string }[];
  history: number[];
  missions: { id: string; agentId: string; kind: string; brief: string; status: string; history: string[] }[];
  births: { id: string; name: string; role: string; funding: number; status: string }[];
  estates: { id: string; name: string; owner: string; size: number; assigned: string }[];
  documents: { id: string; name: string; status: string }[];
  consents: { id: string; purpose: string; active: boolean }[];
  passkeys: { id: string; name: string; active: boolean }[];
  sessions: { id: string; name: string; active: boolean }[];
  audit: string[];
  policy: { threshold: number; autoBirth: boolean; maxAgents: number; dailyHour: number; email: string; riskLimit: number; missionLimit: number };
  processed: string[];
};
export type Command = { id: string; op: string; args: Record<string, string> };
export const roles = ['Research', 'Marketing', 'Opportunity hunt', 'Operations', 'Communications'];
export const money = (minor: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100);
export function pence(input: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(input.trim())) throw new Error('Enter a positive amount with at most two decimal places.');
  const [whole, fraction = ''] = input.trim().split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10000000000) throw new Error('Amount must be between £0.01 and £100,000,000.');
  return value;
}
export function initialFleet(): Fleet {
  return {
    treasury: 1248200, contributed: 1000000, revenue: 432800, spend: 184600, tick: 0,
    agents: [
      { id: 'A-001', name: 'Atlas', role: 'Research', status: 'active', cash: 148200, burn: 4200, colour: 'cyan', venture: 'Signal intelligence', events: ['Research brief compiled', 'Browser: public market research', 'Evidence sources indexed'] },
      { id: 'A-002', name: 'Vega', role: 'Marketing', status: 'active', cash: 73200, burn: 3100, colour: 'violet', venture: 'Neon Studio', events: ['Campaign draft prepared', 'Business mailbox reviewed', 'Audience research completed'] },
      { id: 'A-003', name: 'Rook', role: 'Operations', status: 'active', cash: 9650, burn: 2200, colour: 'amber', venture: 'Relay Services', events: ['Runway below seven days', 'Supplier browser session completed', 'Service checklist updated'] },
      { id: 'A-004', name: 'Nova', role: 'Opportunity hunt', status: 'held', cash: 42900, burn: 1800, colour: 'green', venture: 'Frontier Labs', events: ['Owner placed agent on hold', 'Opportunity dossier saved'] },
    ],
    notices: [
      { id: 'N-1', title: 'Rook has fewer than 7 days of runway', level: 'AMBER', acknowledged: false, time: '14:32' },
      { id: 'N-2', title: 'New opportunity dossier from Nova', level: 'INFO', acknowledged: false, time: '14:18' },
    ],
    ledger: [{ id: 'L-0', label: 'Opening simulated Treasury', amount: 1248200, balance: 1248200, time: '09:00' }],
    history: [1000000, 1034200, 1018900, 1086000, 1121000, 1102300, 1184200, 1214000, 1198000, 1248200],
    missions: [{ id: 'M-001', agentId: 'A-001', kind: 'Research', brief: 'Map the demand for independent research services.', status: 'active', history: ['Assigned to Atlas', 'Initial evidence collected'] }],
    births: [],
    estates: [{ id: 'E-001', name: 'Echo research archive', owner: 'Echo (retired demo agent)', size: 128, assigned: '' }],
    documents: [{ id: 'D-001', name: 'Fictional identity card', status: 'available' }],
    consents: [{ id: 'C-001', purpose: 'Fictional provider onboarding', active: true }],
    passkeys: [{ id: 'K-001', name: 'Demo desktop authenticator', active: true }, { id: 'K-002', name: 'Demo recovery key', active: true }],
    sessions: [{ id: 'S-001', name: 'This demo browser', active: true }, { id: 'S-002', name: 'Demo tablet', active: true }],
    audit: ['14:00 · Simulated session opened'],
    policy: { threshold: 1600000, autoBirth: false, maxAgents: 12, dailyHour: 8, email: 'owner@example.invalid', riskLimit: 7, missionLimit: 3 }, processed: [],
  };
}
export function evolve(current: Fleet, command: Command): Fleet {
  if (current.processed.includes(command.id)) return current;
  const s = structuredClone(current), a = command.args;
  const now = `T+${String(s.tick + 1).padStart(3, '0')}`;
  const uid = (prefix: string) => `${prefix}-${s.tick + 100}`;
  const required = (key: string) => { const value = a[key]?.trim(); if (!value) throw new Error(`${key} is required.`); return value; };
  const agent = (key = 'agentId') => { const value = s.agents.find(x => x.id === a[key]); if (!value) throw new Error('Agent not found.'); return value; };
  const living = (key = 'agentId') => { const value = agent(key); if (value.status === 'dead') throw new Error('This agent is retired.'); return value; };
  const positive = () => pence(required('amount'));
  const charge = (amount: number) => { if (amount > s.treasury) throw new Error('Insufficient Treasury balance.'); s.treasury -= amount; };
  const entry = (label: string, amount: number) => s.ledger.unshift({ id: uid('L'), label, amount, balance: s.treasury, time: now });
  const note = (title: string, level: Notice['level'] = 'INFO') => s.notices.unshift({ id: uid('N'), title, level, acknowledged: false, time: now });
  let label = '';
  switch (command.op) {
    case 'topup': { const amount = positive(); s.treasury += amount; s.contributed += amount; label = 'Treasury top-up'; entry(label, amount); break; }
    case 'withdraw': { required('reason'); const amount = positive(); charge(amount); label = 'Owner withdrawal'; entry(label, -amount); break; }
    case 'fund': { const target = living(); required('reason'); const amount = positive(); charge(amount); target.cash += amount; label = `Funded ${target.name}`; target.events.unshift(`${now} · Received ${money(amount)} from Treasury`); entry(label, -amount); break; }
    case 'transfer': { const source = living(); required('reason'); const amount = positive(); if (amount > source.cash) throw new Error('Insufficient agent balance.'); if (a.target === source.id) throw new Error('Choose a different destination.'); if (a.target === 'treasury') { s.treasury += amount; entry(`${source.name} → Treasury`, amount); } else { const target = living('target'); target.cash += amount; target.events.unshift(`${now} · Received ${money(amount)} from ${source.name}`); } source.cash -= amount; label = `${source.name} transferred ${money(amount)}`; source.events.unshift(`${now} · ${label}`); break; }
    case 'hold': { const target = living(); target.status = target.status === 'held' ? 'active' : 'held'; label = `${target.name} ${target.status === 'held' ? 'held' : 'resumed'}`; target.events.unshift(`${now} · ${label}`); break; }
    case 'role': { const target = living(); if (!roles.includes(a.role)) throw new Error('Choose a supported demo role.'); target.role = a.role; label = `${target.name} assigned ${a.role}`; target.events.unshift(`${now} · ${label}`); break; }
    case 'kill': { const target = living(); required('reason'); s.treasury += target.cash; entry(`${target.name} estate cash recovered`, target.cash); target.cash = 0; target.status = 'dead'; s.estates.push({ id: uid('E'), name: `${target.name} operational archive`, owner: target.name, size: 96, assigned: '' }); s.missions.filter(m => m.agentId === target.id && m.status === 'active').forEach(m => { m.status = 'ended'; m.history.push('Closed on agent retirement'); }); label = `${target.name} retired; estate created`; target.events.unshift(`${now} · ${label}`); break; }
    case 'mission': { const target = living(); if (s.missions.filter(m => m.agentId === target.id && m.status === 'active').length >= s.policy.missionLimit) throw new Error('Demo mission limit reached.'); const brief = required('brief'); if (!roles.includes(a.role)) throw new Error('Choose a mission kind.'); s.missions.unshift({ id: uid('M'), agentId: target.id, kind: a.role, brief, status: 'active', history: [`${now} · Assigned to ${target.name}`] }); target.events.unshift(`${now} · Mission: ${brief}`); label = `Mission assigned to ${target.name}`; break; }
    case 'mission_end': { const m = s.missions.find(x => x.id === a.missionId); if (!m || m.status !== 'active') throw new Error('Mission is no longer active.'); m.status = 'completed'; m.history.push(`${now} · ${required('outcome')}`); label = 'Mission completed'; break; }
    case 'birth': case 'reseed': { const funding = positive(); if (s.agents.filter(x => x.status !== 'dead').length + s.births.filter(x => x.status === 'queued').length >= s.policy.maxAgents) throw new Error('Demo population limit reached.'); if (!roles.includes(a.role)) throw new Error('Choose a role.'); if (command.op === 'reseed' && agent().status !== 'dead') throw new Error('Reseeding requires a retired agent.'); charge(funding); const name = required('name'); s.births.push({ id: uid('B'), name, role: a.role, funding, status: 'queued' }); label = `${name} birth queued; funds reserved`; entry(label, -funding); break; }
    case 'provision': { const birth = s.births.find(x => x.id === a.birthId); if (!birth || birth.status !== 'queued') throw new Error('Order already provisioned or missing.'); birth.status = 'provisioned'; s.agents.push({ id: uid('A'), name: birth.name, role: birth.role, status: 'active', cash: birth.funding, burn: 1500, colour: ['cyan','violet','amber','green'][s.agents.length % 4], venture: 'New venture', events: [`${now} · Simulated provisioning completed`] }); label = `${birth.name} provisioned in simulation`; break; }
    case 'estate': { const item = s.estates.find(x => x.id === a.itemId); if (!item) throw new Error('Estate item missing.'); if (a.target !== 'unassigned') living('target'); item.assigned = a.target === 'unassigned' ? '' : a.target; label = `Estate ${item.assigned ? 'assigned' : 'released'}`; break; }
    case 'ack': { const n = s.notices.find(x => x.id === a.noticeId); if (!n) throw new Error('Alert missing.'); n.acknowledged = true; label = 'Notification acknowledged'; break; }
    case 'ack_all': s.notices.forEach(n => n.acknowledged = true); label = 'All notifications acknowledged'; break;
    case 'scenario': { label = a.kind === 'RED' ? 'Simulated security incident: unrecognised sign-in refused' : a.kind === 'AMBER' ? 'Simulated spending alert: review operating costs' : 'Simulated opportunity: new qualified lead'; note(label, a.kind === 'RED' ? 'RED' : a.kind === 'AMBER' ? 'AMBER' : 'INFO'); break; }
    case 'tick': { const revenue = 12600, costs = s.agents.filter(x => x.status === 'active').reduce((sum,x) => sum+x.burn,0); charge(costs); s.treasury += revenue; s.revenue += revenue; s.spend += costs; entry('Simulated trading day: revenue less costs', revenue-costs); s.agents.filter(x => x.status === 'active').forEach(x => x.events.unshift(`${now} · ${x.role} cycle completed`)); label = 'Advanced one simulated trading day'; break; }
    case 'policy': { const threshold = pence(required('amount')); const count = Number(a.maxAgents); if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Population limit must be 1–100.'); s.policy.threshold = threshold; s.policy.maxAgents = count; s.policy.autoBirth = a.autoBirth === 'true'; label = 'Replication policy updated'; break; }
    case 'limits': { const risk = Number(a.riskLimit), missions = Number(a.missionLimit); if (!Number.isInteger(risk) || risk < 1 || risk > 365 || !Number.isInteger(missions) || missions < 1 || missions > 20) throw new Error('Runway must be 1–365 days and mission limit 1–20.'); s.policy.riskLimit = risk; s.policy.missionLimit = missions; label = 'Risk and mission policy updated'; break; }
    case 'delivery': { const hour = Number(a.hour); if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Hour must be 0–23 UTC.'); s.policy.dailyHour = hour; s.policy.email = 'owner@example.invalid'; label = 'Demo delivery schedule updated'; break; }
    case 'genesis': s.contributed = positive(); label = 'Demo net contributed capital changed (no cash movement)'; break;
    case 'document': s.documents.push({ id: uid('D'), name: a.name === 'proof' ? 'Fictional proof of address' : 'Fictional identity card', status: 'available' }); label = 'Bundled fictional document uploaded'; break;
    case 'document_status': { const d = s.documents.find(x => x.id === a.documentId); if (!d) throw new Error('Document missing.'); d.status = d.status === 'available' ? 'revoked' : 'available'; label = `Document ${d.status}`; break; }
    case 'consent': s.consents.push({ id: uid('C'), purpose: required('purpose'), active: true }); label = 'Demo standing consent added'; break;
    case 'consent_revoke': { const c = s.consents.find(x => x.id === a.consentId); if (!c || !c.active) throw new Error('Consent already inactive.'); c.active = false; label = 'Demo consent revoked'; break; }
    case 'passkey': s.passkeys.push({ id: uid('K'), name: required('name'), active: true }); label = 'Demo passkey enrolled'; break;
    case 'passkey_revoke': { const k = s.passkeys.find(x => x.id === a.keyId); if (!k || !k.active) throw new Error('Passkey already inactive.'); if (s.passkeys.filter(x => x.active).length <= 1) throw new Error('Keep one demo passkey for recovery.'); k.active = false; label = 'Demo passkey revoked'; break; }
    case 'sessions': s.sessions.filter(x => x.id !== 'S-001').forEach(x => x.active = false); label = 'Other demo sessions revoked'; break;
    case 'totp': label = 'Demo TOTP reset completed'; break;
    case 'reveal': label = `Fictional ${a.kind === 'document' ? 'document' : 'credential'} reveal opened`; break;
    case 'login': s.sessions[0].active = true; label = 'Demo passkey + TOTP sign-in completed'; break;
    case 'logout': s.sessions[0].active = false; label = 'Demo session ended'; break;
    default: throw new Error('Unsupported simulation operation.');
  }
  s.tick += 1;
  s.processed.push(command.id);
  s.audit.unshift(`${now} · ${label}`);
  if (s.treasury !== current.treasury) s.history.push(s.treasury);
  if (!['ack','ack_all','scenario','reveal','login','logout'].includes(command.op)) note(label);
  return s;
}

export interface FleetAdapter { readonly mode: 'simulation' | 'live'; snapshot(): Promise<Fleet>; execute(command: Command): Promise<Fleet>; }
export class SimulationAdapter implements FleetAdapter {
  readonly mode = 'simulation' as const;
  private state = initialFleet();
  snapshot() { return Promise.resolve(structuredClone(this.state)); }
  async execute(command: Command) { this.state = evolve(this.state, command); return this.snapshot(); }
  reset() { this.state = initialFleet(); return this.snapshot(); }
}

// No production mutations are enabled until backend source and security contracts
// have been verified. This adapter fails closed rather than inventing mappings.
export class ProductionAdapter implements FleetAdapter {
  readonly mode = 'live' as const;
  async snapshot(): Promise<Fleet> { throw new Error('Live integration pending: verified response schemas and authentication required.'); }
  async execute(): Promise<Fleet> { throw new Error('Live mutations are not configured.'); }
}
