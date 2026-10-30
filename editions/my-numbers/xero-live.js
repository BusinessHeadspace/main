/* Live Xero add-on for the Pricing & Profit Calculator (private "My numbers" edition).
   Runs only inside a claude.ai artifact: it reads Xero through the viewer's own
   Xero connector (mcp capability) and keeps the viewer's settings in their private
   artifact storage (db + user capabilities). The calculator itself is unchanged and
   is reached through window.PPC. */
(function () {
  "use strict";

  const SERVER = "Xero";
  const OWNER_PAY = /shareholder'?s? salar|owner'?s? (salary|wages|pay)|director'?s? (fees|salary)|drawings|proprietor/i;
  const NOT_FEES = /affiliate|reimburs|travel|music|interest|other revenue/i;
  const COURSES = /course|programme|program|membership|product/i;
  const SOFTWARE = /subs|subscription|commission|software|licen/i;
  const SOFTWARE_COSTS = /subs|subscription|software|licen|xero|myob|reckon|quickbooks|commission/i;
  const SVC_LABEL = { coaching: "Coaching", consulting: "Consulting", bookkeeping: "Bookkeeping", software: "Software", course: "Courses", other: "Other" };

  const $ = (id) => document.getElementById(id);
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const money = (v, d) => window.PPC.money(v, d);
  const fmtDate = (t) => new Date(t).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

  // Saved per viewer: the calculator state plus this add-on's settings and last Xero pull
  let store = null;        // db document ref
  let saved = { sync: { months: 3, feeCodes: null, ownerAccounts: null, softwareCosts: null, hidden: [] }, xero: null };
  let mcp = null;
  let busy = false;
  let writeTimer = null;

  // ---------- UI ----------
  const style = document.createElement("style");
  style.textContent = `
    .xero-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
    .xero-bar .who { font-weight: 600; color: var(--navy); }
    .xero-bar .when { font-size: .85rem; color: var(--muted); }
    .xero-msg { margin: 10px 0 0; font-size: .9rem; }
    .xero-msg.err { color: var(--red); }
    .xero-settings { margin-top: 14px; }
    .xero-settings summary { cursor: pointer; font-weight: 600; color: var(--blue); font-size: .9rem; }
    .xero-settings .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; margin-top: 12px; }
    .xero-settings .cols > div { min-width: 0; }
    .xero-settings h3 { font-size: .9rem; margin-bottom: 6px; }
    .xero-settings label.chk { display: flex; gap: 8px; align-items: center; font-size: .85rem; padding: 3px 0; cursor: pointer; }
    .ytd-pace { display: grid; gap: 6px; margin: 4px 0 16px; }
    .ytd-pace .bar { position: relative; }
    .ytd-pace .marker { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--navy); }
  `;
  document.head.appendChild(style);

  const card = document.createElement("section");
  card.className = "card no-print";
  card.id = "xeroCard";
  card.innerHTML = `
    <div class="xero-bar">
      <div><div class="who" id="xeroWho">Xero</div><div class="when" id="xeroWhen">Connecting…</div></div>
      <div class="toolbar"><button class="btn btn-teal" id="xeroRefresh" type="button" disabled>Refresh from Xero</button></div>
    </div>
    <p class="xero-msg" id="xeroMsg" role="status" hidden></p>
    <details class="xero-settings" id="xeroSettings">
      <summary>What comes in from Xero</summary>
      <div class="cols">
        <div>
          <h3>Client fees</h3>
          <label class="field" style="max-width:240px;">Average over the last
            <select id="xeroMonths"><option value="3">3 full months</option><option value="6">6 full months</option><option value="12">12 full months</option></select>
          </label>
          <p class="table-note">Income accounts that count as client fees:</p>
          <div id="xeroFeeCodes" class="muted" style="font-size:.85rem;">Refresh to see your accounts.</div>
          <h3 style="margin-top:14px;">Software costs</h3>
          <p class="table-note" style="margin-top:0;">Cost of sales accounts for software subscriptions. Shared across your Software &amp; commissions clients by fee, as their other direct costs.</p>
          <div id="xeroSoftCos" class="muted" style="font-size:.85rem;">Refresh to see your accounts.</div>
        </div>
        <div>
          <h3>Your own pay</h3>
          <p class="table-note" style="margin-top:0;">Expense accounts that are your pay. They're left out of overheads.</p>
          <div id="xeroOwner" class="muted" style="font-size:.85rem;">Refresh to see your accounts.</div>
          <h3 style="margin-top:14px;">Hidden clients</h3>
          <div id="xeroHidden" class="muted" style="font-size:.85rem;">None. Removing a Xero client from the table hides it from future refreshes.</div>
        </div>
      </div>
    </details>`;
  const fileMsg = $("fileMsg");
  fileMsg.parentNode.insertBefore(card, fileMsg.nextSibling);

  const ytdCard = document.createElement("section");
  ytdCard.className = "card";
  ytdCard.innerHTML = `<h2>This year so far</h2><div id="ytdBody"><p class="muted">Refresh from Xero to see how this financial year is tracking.</p></div>`;
  const compareCard = $("ptCompare").closest(".card");
  compareCard.parentNode.insertBefore(ytdCard, compareCard);

  function say(text, isError) {
    const el = $("xeroMsg");
    el.textContent = text;
    el.className = "xero-msg" + (isError ? " err" : "");
    el.hidden = !text;
  }

  function errorText(err) {
    switch (err && err.code) {
      case "needs_reauth": return "Your Xero connection has expired. Reconnect Xero in claude.ai Settings → Connectors, then refresh.";
      case "server_not_connected": return "Xero isn't connected to your Claude account. Add it in claude.ai Settings → Connectors, then refresh.";
      case "selection_required": return "You have more than one Xero connector. Choose which one this page should use when claude.ai asks, then refresh.";
      case "not_in_manifest":
      case "approval_required":
      case "consent_required": return "This page needs your permission to read Xero. Click Refresh from Xero and choose Allow.";
      case "blocked_by_policy": return "Your organisation's settings don't allow this page to use Xero.";
      case "server_unavailable":
      case "rate_limited": return "Xero didn't respond. Wait a minute and refresh again.";
      case "tool_error": return "Xero returned an error: " + (err.message || "unknown error") + ".";
      case "not_granted":
      case "capability_disabled":
      case "capability_removed": return "The Xero connection isn't available in this view. Open this page in claude.ai.";
      default: return "Something went wrong reading Xero" + (err && err.message ? ": " + err.message : "") + ". Try refreshing again.";
    }
  }

  // ---------- Saving ----------
  function persist() {
    if (!store) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
      try {
        await store.set({ state: window.PPC.getState(), sync: saved.sync, xero: saved.xero, savedAt: Date.now() });
      } catch (e) {
        say("Your changes couldn't be saved to your account just now. They're still kept in this browser.", true);
      }
    }, 1200);
  }

  window.PPC.onChange = () => { persist(); renderYtd(); };
  window.PPC.onClientChange = (c, field) => {
    if (field === "freq" && c && c.source === "xero" && saved.xero) { applyXero(); persist(); }
  };
  window.PPC.onRestoreClient = (c) => {
    if (c && c.xeroContactId) {
      const keys = [c.xeroKey, c.xeroContactId];
      saved.sync.hidden = (saved.sync.hidden || []).filter((h) => !keys.includes(h.id));
      renderSettings();
    }
  };
  window.PPC.onRemoveClient = (c) => {
    if (!Array.isArray(saved.sync.hidden)) saved.sync.hidden = [];
    const key = c && (c.xeroKey || c.xeroContactId);
    if (c && c.source === "xero" && key && !saved.sync.hidden.some((h) => h.id === key)) {
      saved.sync.hidden.push({ id: key, name: c.name });
      renderSettings();
    }
  };

  // ---------- Xero ----------
  async function call(tool, input) {
    const res = await mcp.callTool(SERVER, tool, input, { cache: false });
    return res.payload;
  }

  async function fetchAll() {
    const orgs = (await call("get_connected_organisations", {})).organisations || [];
    if (!orgs.length) throw { code: "tool_error", message: "no Xero organisation is connected" };
    const org = orgs.find((o) => saved.xero && o.organisation_id === saved.xero.orgId) || orgs[0];
    const id = org.organisation_id;

    const fy = await call("get_organisation_financial_year", { organisation_id: id });
    const fyStart = new Date(fy.financial_year_start_date + "T00:00:00");
    const lastStart = new Date(fyStart); lastStart.setFullYear(fyStart.getFullYear() - 1);
    const lastEnd = new Date(fyStart); lastEnd.setDate(lastEnd.getDate() - 1);
    const today = new Date();

    const months = +saved.sync.months || 3;
    const winEnd = new Date(today.getFullYear(), today.getMonth(), 0);           // last day of last month
    const winStart = new Date(today.getFullYear(), today.getMonth() - months, 1);

    const [lastYear, ytd, win, chart] = await Promise.all([
      call("get_profit_and_loss", { organisation_id: id, start_date: iso(lastStart), end_date: iso(lastEnd) }),
      call("get_profit_and_loss", { organisation_id: id, start_date: iso(fyStart), end_date: iso(today) }),
      call("get_profit_and_loss", { organisation_id: id, start_date: iso(winStart), end_date: iso(winEnd) }),
      call("get_chart_of_accounts", { organisation_id: id })
    ]);

    const invoices = [];
    for (let page = 1; page <= 40; page++) {
      const res = await call("get_invoices", {
        organisation_id: id, issued_date_start: iso(winStart), issued_date_end: iso(winEnd),
        include_line_items: true, page
      });
      invoices.push(...(res.invoices || []));
      if (!res.total_page_count || page >= res.total_page_count) break;
    }

    // Keep only what the calculator uses, so the saved copy stays small
    const slimPnl = (r) => ({
      current_pnl: r.current_pnl,
      cos_accounts: ((r.cost_of_sales_accounts && r.cost_of_sales_accounts.all_accounts) || [])
        .filter((a) => num(a.current_balance) !== 0)
        .map((a) => ({ account_name: a.account_name, current_balance: a.current_balance })),
      expense_accounts: { all_accounts: ((r.expense_accounts && r.expense_accounts.all_accounts) || [])
        .filter((a) => num(a.current_balance) !== 0)
        .map((a) => ({ account_name: a.account_name, current_balance: a.current_balance })) }
    });
    const slimInvoices = invoices.map((inv) => ({
      contact: { contact_id: inv.contact && inv.contact.contact_id, name: inv.contact && inv.contact.name },
      invoice_date: inv.invoice_date,
      line_items: (inv.line_items || []).filter((l) => l.account_code).map((l) => ({
        account_code: l.account_code, quantity: l.quantity, line_amount_net_base_currency: l.line_amount_net_base_currency
      }))
    }));
    const used = new Set();
    slimInvoices.forEach((inv) => inv.line_items.forEach((l) => used.add(l.account_code)));
    return {
      orgId: id, orgName: org.name, fyStart: iso(fyStart), lastStart: iso(lastStart), lastEnd: iso(lastEnd),
      winStart: iso(winStart), winEnd: iso(winEnd), months, lastYear: slimPnl(lastYear), ytd: slimPnl(ytd), win: slimPnl(win),
      accounts: (chart.accounts || []).filter((a) => used.has(a.code)).map((a) => ({ code: a.code, name: a.name, type: a.type })),
      invoices: slimInvoices
    };
  }

  // Income accounts that appear on invoice lines, with their names
  function invoiceAccounts(x) {
    const names = new Map(x.accounts.map((a) => [a.code, a]));
    const codes = new Map();
    x.invoices.forEach((inv) => (inv.line_items || []).forEach((l) => {
      if (l.account_code && !codes.has(l.account_code)) codes.set(l.account_code, names.get(l.account_code) || { code: l.account_code, name: "Account " + l.account_code, type: "" });
    }));
    return [...codes.values()].sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  }

  // Course sales count as revenue (grouped as Courses & programmes). Added once to an
  // earlier saved choice that left them out.
  function addCourseAccounts(x) {
    if (saved.sync.coursesAdded || !saved.sync.feeCodes) return;
    const set = new Set(saved.sync.feeCodes);
    invoiceAccounts(x).filter((a) => a.type === "REVENUE" && COURSES.test(a.name)).forEach((a) => set.add(a.code));
    saved.sync.feeCodes = [...set];
    saved.sync.coursesAdded = true;
  }

  function defaultFeeCodes(x) {
    return invoiceAccounts(x).filter((a) => a.type === "REVENUE" && !NOT_FEES.test(a.name)).map((a) => a.code);
  }

  function expenseLines(x) {
    return ((x.lastYear.expense_accounts && x.lastYear.expense_accounts.all_accounts) || [])
      .filter((a) => num(a.current_balance) !== 0).map((a) => a.account_name);
  }

  function ownerPay(pnl) {
    const owner = new Set(saved.sync.ownerAccounts || []);
    return ((pnl.expense_accounts && pnl.expense_accounts.all_accounts) || [])
      .reduce((t, a) => t + (owner.has(a.account_name) ? num(a.current_balance) : 0), 0);
  }

  // Which service an income account belongs to
  function serviceFromAccount(name) {
    if (COURSES.test(name)) return "course";
    if (SOFTWARE.test(name)) return "software";
    if (/coach/i.test(name)) return "coaching";
    if (/consult|support|training|software|advis/i.test(name)) return "consulting";
    if (/bookkeep|accounts|payroll|compliance/i.test(name)) return "bookkeeping";
    return "other";
  }

  const monthName = (ym) => new Date(ym + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "short", year: "numeric" });

  // Client fees and hours from invoice lines in the window.
  // Regular clients are averaged over the months they were billed, so a month off
  // doesn't drag the average down; ad hoc clients over the whole period.
  function clientsFrom(x) {
    const fee = new Set(saved.sync.feeCodes || []);
    const hidden = new Set(saved.sync.hidden.map((h) => h.id));
    const names = new Map(x.accounts.map((a) => [a.code, a.name]));
    const end = new Date(x.winEnd + "T00:00:00");
    const lastMonth = x.winEnd.slice(0, 7);
    const by = new Map();
    x.invoices.forEach((inv) => {
      const cid = inv.contact && inv.contact.contact_id;
      if (!cid || hidden.has(cid)) return;
      (inv.line_items || []).forEach((l) => {
        if (!fee.has(l.account_code) || l.line_amount_net_base_currency == null) return;
        const svc = serviceFromAccount(names.get(l.account_code) || "");
        const key = cid + ":" + svc;
        if (hidden.has(key)) return;
        const c = by.get(key) || { id: key, cid, svc, name: inv.contact.name, total: 0, qty: 0, hourly: false, first: inv.invoice_date, last: inv.invoice_date, months: new Set() };
        c.total += num(l.line_amount_net_base_currency);
        const q = num(l.quantity);
        c.qty += q;
        if (l.quantity != null && q !== 1) c.hourly = true;
        if (inv.invoice_date < c.first) c.first = inv.invoice_date;
        if (inv.invoice_date > c.last) c.last = inv.invoice_date;
        c.months.add(inv.invoice_date.slice(0, 7));
        by.set(key, c);
      });
    });
    const parts = new Map();
    by.forEach((c) => { if (c.total > 0) parts.set(c.cid, (parts.get(c.cid) || 0) + 1); });
    const endIdx = end.getFullYear() * 12 + end.getMonth();
    return [...by.values()].filter((c) => c.total > 0).map((c) => {
      const f = new Date(c.first + "T00:00:00");
      const active = Math.max(1, Math.min(x.months, endIdx - (f.getFullYear() * 12 + f.getMonth()) + 1));
      const idx = [...c.months].map((ym) => +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1)).sort((a, b) => a - b);
      const billed = idx.length;
      // How often they're billed: coaching, software and courses are monthly; otherwise the usual gap between bills
      let freq;
      if (billed >= 2) {
        if (["coaching", "software", "course"].includes(c.svc)) freq = "1";
        else {
          const gaps = idx.slice(1).map((v, k) => v - idx[k]).sort((a, b) => a - b);
          const g = gaps[Math.floor((gaps.length - 1) / 2)];
          freq = String([1, 2, 3, 6, 12].reduce((best, v) => (Math.abs(v - g) < Math.abs(best - g) ? v : best), 1));
        }
      } else {
        freq = active <= 1 ? "1" : "adhoc";
      }
      return {
        id: c.id, cid: c.cid, svc: c.svc, type: c.svc, baseName: c.name, split: parts.get(c.cid) > 1,
        name: parts.get(c.cid) > 1 ? `${c.name} · ${SVC_LABEL[c.svc]}` : c.name,
        total: c.total, qty: c.qty, hourly: c.hourly && c.svc !== "software" && c.svc !== "course",
        billed, active, last: idx[billed - 1], endIdx, freq
      };
    }).sort((a, b) => b.total - a.total);
  }

  const FREQ_MONTHS = { "1": 1, "2": 2, "3": 3, "6": 6, "12": 12 };
  const FREQ_WORDS = { "2": "every 2 months", "3": "quarterly", "6": "every 6 months", "12": "once a year" };

  // Fee and hours per bill for a client, given how often they're billed
  function perBill(xc, freq, x) {
    const adhoc = freq === "adhoc";
    const per = adhoc ? x.months : xc.billed;
    const fm = FREQ_MONTHS[freq] || 1;
    let note = "", warn = false;
    if (adhoc) {
      note = `Ad hoc: billed ${money(xc.total)} in ${xc.billed} of the last ${x.months} months. Shown as a monthly average.`;
    } else if (xc.last + fm <= xc.endIdx) {
      const ym = Math.floor(xc.last / 12) + "-" + String(xc.last % 12 + 1).padStart(2, "0");
      note = `Last billed ${monthName(ym)}. If they've finished, remove them with the × at the end of the row.`;
      warn = true;
    } else if (fm > 1) {
      note = `Billed ${FREQ_WORDS[freq]}: average of ${xc.billed} bill${xc.billed === 1 ? "" : "s"}.`;
    } else if (xc.billed < xc.active) {
      note = `Averaged over the ${xc.billed} months billed (not billed in ${xc.active - xc.billed}).`;
    }
    if (xc.split) note = (note ? note + " " : "") + `This row is the ${SVC_LABEL[xc.svc].toLowerCase()} part of ${xc.baseName}'s invoices.`;
    return {
      fee: Math.round(xc.total / per),
      hours: xc.hourly ? Math.round(xc.qty / per * 100) / 100 : "",
      monthly: adhoc ? xc.total / x.months : xc.total / xc.billed / fm,
      note, warn
    };
  }

  // Monthly software cost of sales, from the P&L for the same months as the fees
  function softwareCost(x) {
    if (!x.win || !x.win.cos_accounts) return null;
    const pick = new Set(saved.sync.softwareCosts || []);
    return x.win.cos_accounts.reduce((t, a) => t + (pick.has(a.account_name) ? num(a.current_balance) : 0), 0) / x.months;
  }

  // Merge Xero figures into the calculator, keeping what you've entered yourself
  function applyXero() {
    const x = saved.xero;
    if (!x) return;
    const s = window.PPC.getState();
    const prev = s.clients || [];
    const byKey = new Map(prev.filter((c) => c.xeroKey).map((c) => [c.xeroKey, c]));
    const byContact = new Map(prev.filter((c) => c.xeroContactId && !c.xeroKey).map((c) => [c.xeroContactId, c]));
    const byName = new Map(prev.map((c) => [String(c.name || "").trim().toLowerCase(), c]));
    const changed = (mine, theirs) => mine !== undefined && mine !== "" && theirs !== undefined && String(mine) !== String(theirs);
    const rows = clientsFrom(x).map((xc) => {
      // Rows saved before clients were split by service match on the contact and their main service
      const legacy = byContact.get(xc.cid);
      const old = byKey.get(xc.id) || (legacy && (legacy.xeroType === xc.type || legacy.type === xc.type) ? legacy : null) || byName.get(xc.name.toLowerCase()) || {};
      const freq = changed(old.freq, old.xeroFreq) ? String(old.freq) : xc.freq;
      return Object.assign(xc, { old, detected: xc.freq, freq, bill: perBill(xc, freq, x) });
    });
    const softRows = rows.filter((r) => r.type === "software");
    const softMonthly = softRows.reduce((t, r) => t + r.bill.monthly, 0);
    const softCost = softwareCost(x);
    const fresh = rows.map((row) => {
      const xc = Object.assign({}, row, { fee: row.bill.fee, hours: row.bill.hours, note: row.bill.note, noteWarn: row.bill.warn });
      const old = row.old;
      const fm = FREQ_MONTHS[row.freq] || 1;
      const xeroOther = xc.type === "software" && softCost !== null && softMonthly > 0 ? Math.round(softCost * row.bill.monthly / softMonthly * fm * 100) / 100 : undefined;
      const youChangedOther = old.otherCosts !== undefined && old.otherCosts !== "" && String(old.otherCosts) !== String(old.xeroOtherCosts ?? "");
      const youChangedHours = old.hours !== undefined && old.hours !== "" && String(old.hours) !== String(old.xeroHours ?? "");
      const youChangedFee = old.xeroFee !== undefined && Math.round(num(old.fee)) !== Math.round(num(old.xeroFee));
      return {
        name: changed(old.name, old.xeroName) ? old.name : xc.name, xeroName: xc.name,
        type: changed(old.type, old.xeroType) ? old.type : xc.type, xeroType: xc.type,
        freq: row.freq, xeroFreq: row.detected,
        fee: youChangedFee ? old.fee : xc.fee, xeroFee: xc.fee, origFee: xc.fee, origLabel: "Xero",
        hours: youChangedHours ? old.hours : (xc.hours !== "" ? xc.hours : (old.hours ?? "")),
        xeroHours: xc.hours,
        teamHours: old.teamHours ?? "", wip: old.wip ?? "",
        otherCosts: youChangedOther || xeroOther === undefined ? (old.otherCosts ?? "") : xeroOther, xeroOtherCosts: xeroOther,
        noReprice: !!old.noReprice,
        note: xc.note, noteWarn: xc.noteWarn,
        source: "xero", xeroContactId: xc.cid, xeroKey: xc.id
      };
    });
    const freshNames = new Set(fresh.map((c) => c.name.toLowerCase()));
    const manual = prev.filter((c) => c.source !== "xero" && !freshNames.has(String(c.name || "").trim().toLowerCase()));
    s.clients = fresh.concat(manual);

    const p = x.lastYear.current_pnl;
    const income = num(p.total_income), cos = num(p.total_cost_of_sales);
    const owner = ownerPay(x.lastYear);
    if (income > 0) {
      if (s.pt.basis === "month") {
        s.pt.netProfit = s.pt.netProfit === "" ? "" : String(Math.round(num(s.pt.netProfit) * 12));
        s.pt.basis = "year";
      }
      s.pt.overheads = String(Math.round(num(p.total_expenses) - owner));
      s.pt.gpPct = String(Math.round((income - cos) / income * 100));
      if (!(num(s.pt.netProfit) > 0)) s.pt.netProfit = String(Math.round(num(p.net_profit) + owner));
    }
    if (!s.currency) s.currency = "NZD";
    s.periodMonths = x.months;
    s.dataNote = `Live from Xero (${x.orgName}). Overheads and gross profit % come from the year to ${new Date(x.lastEnd + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })}. Client fees come from invoices over the last ${x.months} full months, excluding GST: regular clients averaged over the months they were billed, ad hoc clients over the whole period. Fees, hours and services you change stay as you set them.`;
    window.PPC.setState(s);
  }

  async function refresh() {
    if (busy || !mcp) return;
    busy = true;
    $("xeroRefresh").disabled = true;
    $("xeroRefresh").textContent = "Refreshing…";
    say("");
    try {
      const x = await fetchAll();
      x.refreshedAt = Date.now();
      saved.xero = x;
      if (!saved.sync.feeCodes) saved.sync.feeCodes = defaultFeeCodes(x);
      addCourseAccounts(x);
      if (!saved.sync.softwareCosts && x.win) saved.sync.softwareCosts = x.win.cos_accounts.map((a) => a.account_name).filter((n) => SOFTWARE_COSTS.test(n));
      if (!saved.sync.softwareAdded) {
        // Subscription and commission income now counts, in its own group
        const set = new Set(saved.sync.feeCodes || []);
        invoiceAccounts(x).filter((a) => a.type === "REVENUE" && SOFTWARE.test(a.name)).forEach((a) => set.add(a.code));
        saved.sync.feeCodes = [...set];
        saved.sync.softwareAdded = true;
      }
      if (!saved.sync.ownerAccounts) saved.sync.ownerAccounts = expenseLines(x).filter((n) => OWNER_PAY.test(n));
      applyXero();
      renderHeader();
      renderSettings();
      renderYtd();
      persist();
      say(`Refreshed. ${x.invoices.length} invoices read from ${x.orgName}.`);
    } catch (err) {
      say(errorText(err), true);
    } finally {
      busy = false;
      $("xeroRefresh").disabled = false;
      $("xeroRefresh").textContent = "Refresh from Xero";
    }
  }

  // ---------- Rendering ----------
  function renderHeader() {
    const x = saved.xero;
    $("xeroWho").textContent = x ? "Xero: " + x.orgName : "Xero";
    $("xeroWhen").textContent = x ? "Last refreshed " + fmtDate(x.refreshedAt) : (mcp ? "Not refreshed yet. Your first refresh asks for permission to read Xero." : "The Xero connection isn't available in this view. Open this page in claude.ai.");
  }

  function renderSettings() {
    const x = saved.xero;
    if (x) {
      const fee = new Set(saved.sync.feeCodes || []);
      $("xeroFeeCodes").innerHTML = invoiceAccounts(x).map((a) =>
        `<label class="chk"><input type="checkbox" data-fee="${esc(a.code)}" ${fee.has(a.code) ? "checked" : ""}>${esc(a.code)} ${esc(a.name)}</label>`).join("") || "No invoice lines in this period.";
      const soft = new Set(saved.sync.softwareCosts || []);
      $("xeroSoftCos").innerHTML = x.win
        ? (x.win.cos_accounts.map((a) => `<label class="chk"><input type="checkbox" data-softcos="${esc(a.account_name)}" ${soft.has(a.account_name) ? "checked" : ""}>${esc(a.account_name)} <span class="muted">(${money(num(a.current_balance) / x.months)}/month)</span></label>`).join("") || "No cost of sales in this period.")
        : "Refresh to see your cost of sales.";
      const owner = new Set(saved.sync.ownerAccounts || []);
      $("xeroOwner").innerHTML = expenseLines(x).map((n) =>
        `<label class="chk"><input type="checkbox" data-owner="${esc(n)}" ${owner.has(n) ? "checked" : ""}>${esc(n)}</label>`).join("") || "No expenses last year.";
    }
    $("xeroMonths").value = String(saved.sync.months || 3);
    const h = saved.sync.hidden;
    $("xeroHidden").innerHTML = h.length
      ? h.map((c) => esc(c.name)).join(", ") + ` <button type="button" class="link-btn" id="xeroUnhide">Show them again</button>`
      : "None. Removing a Xero client from the table hides it from future refreshes.";
  }

  function renderYtd() {
    const x = saved.xero;
    if (!x) return;
    const p = x.ytd.current_pnl;
    const income = num(p.total_income), cos = num(p.total_cost_of_sales);
    const owner = ownerPay(x.ytd);
    const overheads = num(p.total_expenses) - owner;
    const profit = num(p.net_profit) + owner;
    const start = new Date(x.fyStart + "T00:00:00");
    const days = Math.max(1, (new Date(x.refreshedAt) - start) / 86400000);
    const yearPassed = Math.min(1, days / 365);
    const proj = (v) => v / yearPassed;

    const s = window.PPC.getState();
    const gp = num(s.pt.gpPct) / 100;
    const k = s.pt.basis === "month" ? 12 : 1;
    const needed = gp > 0 ? (num(s.pt.netProfit) * k + num(s.pt.overheads) * k) / gp : 0;
    const reached = needed > 0 ? income / needed : 0;
    const status = !needed ? "none" : reached >= yearPassed ? "green" : reached >= yearPassed * 0.85 ? "amber" : "red";
    const label = { green: "On pace", amber: "A little behind", red: "Behind", none: "Set a target" }[status];

    $("ytdBody").innerHTML = `
      ${needed ? `<div class="ytd-pace">
        <div class="bar"><span class="now" style="width:${Math.min(100, reached * 100)}%;"></span><i class="marker" style="left:${yearPassed * 100}%"></i></div>
        <div class="bar-legend"><span><i style="background:var(--blue)"></i>Revenue so far: ${Math.round(reached * 100)}% of the ${money(needed)} your target needs</span><span><i style="background:var(--navy);width:2px;"></i>${Math.round(yearPassed * 100)}% of the year has passed</span><span class="status ${status}">${label}</span></div>
      </div>` : ""}
      <div class="summary-grid">
        <div class="stat"><div class="label">Revenue so far</div><div class="value">${money(income)}</div><div class="sub">On this pace: ${money(proj(income))} for the year</div></div>
        <div class="stat navy"><div class="label">Gross profit %</div><div class="value">${income > 0 ? Math.round((income - cos) / income * 100) + "%" : "—"}</div><div class="sub">Target: ${s.pt.gpPct ? s.pt.gpPct + "%" : "not set"}</div></div>
        <div class="stat"><div class="label">Overheads so far</div><div class="value">${money(overheads)}</div><div class="sub">On this pace: ${money(proj(overheads))} for the year</div></div>
        <div class="stat highlight"><div class="label">Profit before your pay</div><div class="value">${money(profit)}</div><div class="sub">On this pace: ${money(proj(profit))} for the year, against a target of ${money(num(s.pt.netProfit) * k)}</div></div>
      </div>
      <p class="fine-print">Financial year from ${new Date(x.fyStart + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })}. "On this pace" scales the year so far to a full year, so seasonal months can make it swing.</p>`;
  }

  // ---------- Events ----------
  $("xeroRefresh").addEventListener("click", refresh);
  $("xeroMonths").addEventListener("change", (e) => {
    saved.sync.months = +e.target.value;
    persist();
    say("Refresh from Xero to use the new period.");
  });
  card.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.fee !== undefined) {
      const set = new Set(saved.sync.feeCodes || []);
      t.checked ? set.add(t.dataset.fee) : set.delete(t.dataset.fee);
      saved.sync.feeCodes = [...set];
      applyXero(); persist();
    }
    if (t.dataset.softcos !== undefined) {
      const set = new Set(saved.sync.softwareCosts || []);
      t.checked ? set.add(t.dataset.softcos) : set.delete(t.dataset.softcos);
      saved.sync.softwareCosts = [...set];
      applyXero(); persist();
    }
    if (t.dataset.owner !== undefined) {
      const set = new Set(saved.sync.ownerAccounts || []);
      t.checked ? set.add(t.dataset.owner) : set.delete(t.dataset.owner);
      saved.sync.ownerAccounts = [...set];
      applyXero(); renderYtd(); persist();
    }
  });
  card.addEventListener("click", (e) => {
    if (e.target.id === "xeroUnhide") {
      saved.sync.hidden = [];
      applyXero(); renderSettings(); persist();
    }
  });

  // ---------- Start ----------
  (async () => {
    if (!window.claude || typeof window.claude.use !== "function") { renderHeader(); return; }
    const [m, db, user] = await Promise.all([window.claude.use("mcp"), window.claude.use("db"), window.claude.use("user")]);
    mcp = m;
    if (db && user) {
      try {
        const uid = await user.id();
        if (uid) {
          store = db.doc("data/users/" + uid + "/calculator");
          const snap = await store.get();
          if (snap.exists) {
            const d = snap.data();
            saved = { sync: Object.assign({ months: 3, feeCodes: null, ownerAccounts: null, softwareCosts: null, hidden: [] }, d.sync || {}), xero: d.xero || null };
            if (d.state) window.PPC.setState(JSON.parse(JSON.stringify(d.state)));
          }
        }
      } catch (e) {
        store = null;
      }
    }
    if (!store) say("Your settings are kept in this browser only.", false);
    if (saved.xero && (window.PPC.getState().clients || []).some((c) => c.source === "xero" && (c.xeroType === undefined || c.xeroKey === undefined || c.xeroFreq === undefined))) {
      addCourseAccounts(saved.xero);
      applyXero();
      persist();
    }
    $("xeroRefresh").disabled = !mcp;
    renderHeader();
    renderSettings();
    renderYtd();
  })();
})();
