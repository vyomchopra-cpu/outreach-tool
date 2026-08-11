/**
 * Minimal RFC4180-ish CSV parser — handles quoted fields, embedded commas,
 * and doubled-quote escaping, since company/title fields routinely contain
 * commas ("Acme, Inc."). No external dependency available inside Apps Script.
 */
function parseCsv_(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  if (rows.length === 0) return [];
  const headers = rows[0].map(function (h) { return h.trim(); });
  return rows.slice(1)
    .filter(function (r) { return r.some(function (v) { return v.trim() !== ''; }); })
    .map(function (r) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = (r[i] || '').trim(); });
      return obj;
    });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail_(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}
