/** Test fixtures (v97): a ZIP written by hand, and the live proof product's layout. */
import zlib from "zlib";

/** A ZIP written by hand: each member stored (method 0) or deflated (method 8); `claim` overrides the declared size. */
export function zip(members: Array<{ name: string; data: Buffer; deflate?: boolean; claim?: number }>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const m of members) {
    const name = Buffer.from(m.name, "utf8");
    const body = m.deflate ? zlib.deflateRawSync(m.data) : m.data;
    const crc = zlib.crc32(m.data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(m.deflate ? 8 : 0, 8); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(body.length, 18); l.writeUInt32LE(m.claim ?? m.data.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(m.deflate ? 8 : 0, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(m.claim ?? m.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, name, body); central.push(c, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(members.length, 8); e.writeUInt16LE(members.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

/** The live proof product's layout (2026-10-19): a README and two CSV sheets whose example row holds quoted formulas. */
export const PROPERTIES_CSV = `Property,Tenant,Tenancy start,Gas safety last,Gas safety due,EICR last,EICR due,EPC expiry,Deposit protected (Y/N),Deposit scheme ref,Alarms checked,Gas status,EICR status,EPC status
"12 Example St","A. Tenant",2025-05-01,2025-09-01,"=IF(D2="""","""",EDATE(D2,12))",2023-06-01,"=IF(F2="""","""",EDATE(F2,60))",2031-01-01,Y,,2026-05-01,"=IF(E2="""","""",IF(E2<TODAY(),""OVERDUE"",IF(E2-TODAY()<=60,""DUE SOON"",""OK"")))","=IF(G2="""","""",IF(G2<TODAY(),""OVERDUE"",""OK""))","=IF(H2="""","""",""OK"")"
`;
export const RENT_CSV = `Property,Current rent,Last increase date,Earliest next increase,Notice served date,New rent,Effective date,Notes
"12 Example St",1200,2025-05-01,"=IF(C2="""","""",EDATE(C2,12))",,,,"Check the gov.uk guidance on notice and form requirements"
`;
export const README = `UK Landlord Compliance Tracker (England)
Import both CSVs into Google Sheets or Excel; the formulas calculate due dates and status flags.
This is an organising tool, not legal advice.
`;
export const trackerZip = () => zip([{ name: "README.txt", data: Buffer.from(README) }, { name: "properties.csv", data: Buffer.from(PROPERTIES_CSV) },
  { name: "rent_log.csv", data: Buffer.from(RENT_CSV), deflate: true }]);
