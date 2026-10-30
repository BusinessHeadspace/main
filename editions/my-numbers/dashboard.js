/* Monthly Dashboard add-on for the private "My numbers" edition.
   Month by month for this financial year, against goals for the year: the P&L and
   clients billed come from the live Xero add-on (window.PPC.live); hours and
   marketing stats are entered each month. Entries are saved with the rest of the
   calculator by the Xero add-on. */
(function () {
  "use strict";
  const live = window.PPC && window.PPC.live;
  if (!live) return;

  const $ = (id) => document.getElementById(id);
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "" && isFinite(parseFloat(v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => window.PPC.money(v);
  const pct = (v) => (v === null || !isFinite(v) ? "—" : Math.round(v * 100) + "%");
  const count = (v) => (v === null || !isFinite(v) ? "—" : String(Math.round(v * 100) / 100));
  const FMT = { money, pct, count };

  const STAFF = /subcontract|contractor|wages|salar|staff|kiwisaver|admin va|\bva\b/i;
  const MARKETING = /advertis|marketing|promotion|facebook|google|website|networking|conference/i;
  const SVC_ORDER = ["coaching", "consulting", "bookkeeping", "course", "software", "other"];
  const SVC_LABEL = { coaching: "Coaching", consulting: "Consulting", bookkeeping: "Bookkeeping", course: "Courses & programmes", software: "Software & commissions", other: "Other income" };
  const DEFAULT_METRICS = [
    { id: "leads", name: "Leads / enquiries", kind: "count" },
    { id: "calls", name: "Discovery calls", kind: "count" },
    { id: "won", name: "New clients won", kind: "count" },
    { id: "email", name: "Email list size", kind: "level" },
    { id: "social", name: "Social followers", kind: "level" }
  ];

  // ---------- Tab ----------
  const style = document.createElement("style");
  style.textContent = `
    .dash-table { border-collapse: separate; border-spacing: 0; font-size: .85rem; min-width: 100%; }
    .dash-table th, .dash-table td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
    .dash-table thead th { font-size: .75rem; color: var(--muted); font-weight: 600; background: var(--white); }
    .dash-table th:first-child, .dash-table td:first-child { text-align: left; position: sticky; left: 0; background: var(--white); z-index: 1; min-width: 190px; white-space: normal; }
    .dash-table tr.sec td { background: var(--cream); color: var(--navy); font-weight: 700; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; padding-top: 12px; }
    .dash-table tr.sec td:first-child { background: var(--cream); }
    .dash-table td.goal input { width: 86px; }
    .dash-table td.mo input { width: 66px; }
    .dash-table input.calc, .dash-table input.mname { padding: 3px 6px; text-align: right; }
    .dash-table input.mname { text-align: left; width: 150px; }
    .dash-table td.ytd { font-weight: 600; color: var(--navy); }
    .dash-table th.partial, .dash-table td.partial { color: var(--muted); font-style: italic; }
    .dash-table td.future { color: var(--line); }
    .dash-table .status { font-size: .72rem; padding: 2px 7px; }
    .dash-table .mcell { display: flex; gap: 6px; align-items: center; }
    .dash-table select { font-size: .75rem; padding: 2px 4px; }
    .dash-pace { margin: 0 0 14px; }
  `;
  document.head.appendChild(style);

  const nav = document.querySelector(".tabs");
  const btn = document.createElement("button");
  btn.className = "tab"; btn.type = "button"; btn.setAttribute("role", "tab");
  btn.id = "tab-dashboard"; btn.dataset.tab = "dashboard"; btn.setAttribute("aria-controls", "panel-dashboard");
  btn.innerHTML = `<span class="step">1</span>Monthly dashboard`;
  nav.insertBefore(btn, nav.firstChild);
  nav.querySelectorAll(".tab .step").forEach((s, i) => { s.textContent = String(i + 1); });

  const panel = document.createElement("div");
  panel.dataset.panel = "dashboard"; panel.id = "panel-dashboard";
  panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", "tab-dashboard");
  panel.innerHTML = `<section class="card"><h2>Monthly dashboard</h2>
    <p class="muted" style="margin-top:-6px;">How each month of this financial year went, against your goals for the year. The money comes from Xero; add your hours and marketing numbers each month.</p>
    <div id="dashBody"><p class="muted">Loading…</p></div></section>`;
  const firstPanel = $("panel-profit-target");
  firstPanel.parentNode.insertBefore(panel, firstPanel);
  window.PPC.showTab(location.hash.slice(1));

  // ---------- Saved entries ----------
  function dash() {
    const d = live.dash();
    if (!d.goals) d.goals = {};
    if (!d.hours) d.hours = {};
    if (!d.values) d.values = {};
    if (!Array.isArray(d.metrics)) d.metrics = DEFAULT_METRICS.map((m) => Object.assign({}, m));
    return d;
  }

  // ---------- Figures ----------
  function monthsOfYear(fyStart) {
    const s = new Date(fyStart + "T00:00:00");
    return Array.from({ length: 12 }, (_, k) => {
      const d = new Date(s.getFullYear(), s.getMonth() + k, 1);
      return { ym: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"), label: d.toLocaleDateString("en-NZ", { month: "short" }) };
    });
  }

  function figures(x) {
    const sync = live.sync();
    const owner = new Set(sync.ownerAccounts || []);
    const fee = new Set(sync.feeCodes || []);
    const byYm = {};
    (x.monthly || []).forEach((m) => {
      const ownerPay = Object.keys(m.expBy).reduce((t, n) => t + (owner.has(n) ? m.expBy[n] : 0), 0);
      const svc = {};
      Object.keys(m.incomeBy).forEach((n) => { const k = live.serviceFromAccount(n); svc[k] = (svc[k] || 0) + m.incomeBy[n]; });
      const pick = (o, re) => Object.keys(o).reduce((t, n) => t + (re.test(n) && !owner.has(n) ? o[n] : 0), 0);
      byYm[m.ym] = {
        partial: m.partial, revenue: m.income, gp: m.income - m.cos, expenses: m.expenses - ownerPay, np: m.net + ownerPay,
        svc, staff: pick(m.cosBy, STAFF) + pick(m.expBy, STAFF), marketing: pick(m.expBy, MARKETING), clients: new Set()
      };
    });
    (x.invoices || []).forEach((inv) => {
      const f = byYm[String(inv.invoice_date).slice(0, 7)];
      const cid = inv.contact && inv.contact.contact_id;
      if (f && cid && (inv.line_items || []).some((l) => fee.has(l.account_code) && num(l.line_amount_net_base_currency) > 0)) f.clients.add(cid);
    });
    return byYm;
  }

  // ---------- Rendering ----------
  function render() {
    const body = $("dashBody");
    const x = live.xero();
    if (!x || !x.monthly) {
      body.innerHTML = `<p class="muted">${!live.loaded() ? "Loading…" : x ? "Click <strong>Refresh from Xero</strong> above to load your month-by-month figures." : "Refresh from Xero above to see your month-by-month figures."}</p>`;
      return;
    }
    const d = dash();
    const months = monthsOfYear(x.fyStart);
    const f = figures(x);
    const done = months.filter((m) => f[m.ym]);
    const nowYm = done.length ? done[done.length - 1].ym : months[0].ym;

    const start = new Date(x.fyStart + "T00:00:00");
    const end = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
    const yearPassed = Math.min(1, Math.max(0, (new Date(x.refreshedAt) - start) / (end - start)));

    // Defaults for the goals come from the Profit target tab
    const t = window.PPC.profitTarget();
    const pt = t ? {
      revenue: t.revenue, gp: t.grossProfit, gpPct: t.gpPct, expenses: t.overheads, np: t.netProfit,
      npPct: t.revenue > 0 ? t.netProfit / t.revenue : null, hours: t.hours
    } : {};

    const sum = (fn) => done.reduce((s, m) => s + fn(f[m.ym]), 0);
    const ytd = { revenue: sum((m) => m.revenue), gp: sum((m) => m.gp), expenses: sum((m) => m.expenses), np: sum((m) => m.np), staff: sum((m) => m.staff), marketing: sum((m) => m.marketing) };
    const allClients = new Set(); done.forEach((m) => f[m.ym].clients.forEach((c) => allClients.add(c)));
    const lastFull = [...done].reverse().find((m) => !f[m.ym].partial) || done[done.length - 1];
    const div = (a, b) => (b > 0 ? a / b : null);
    const hoursYtd = done.reduce((s, m) => s + num(d.hours[m.ym]), 0);
    const anyHours = done.some((m) => has(d.hours[m.ym]));
    // Revenue per hour only counts months that have hours entered
    const revWithHours = done.reduce((s, m) => s + (num(d.hours[m.ym]) > 0 ? f[m.ym].revenue : 0), 0);

    // Rows: how each is shown, worked out for a month and for the year to date, and judged against its goal
    //   pace: the year to date is compared with how much of the year has passed
    //   rate: a percentage or average, compared with the goal itself
    //   level: a number at a point in time, the latest month compared with the goal
    const R = (key, label, fmt, month, ytdVal, judge, better, goalDefault, goalFmt) => ({ key, label, fmt, month, ytd: ytdVal, judge, better: better || "up", goalDefault, goalFmt: goalFmt || fmt });
    const sections = [
      ["Financial · from Xero", [
        R("revenue", "Total revenue", "money", (m) => m.revenue, ytd.revenue, "pace", "up", pt.revenue),
        R("gp", "Gross profit $", "money", (m) => m.gp, ytd.gp, "pace", "up", pt.gp),
        R("gpPct", "Gross profit %", "pct", (m) => div(m.gp, m.revenue), div(ytd.gp, ytd.revenue), "rate", "up", pt.gpPct),
        R("expenses", "Expenses (not your pay)", "money", (m) => m.expenses, ytd.expenses, "pace", "down", pt.expenses),
        R("np", "Net profit before your pay", "money", (m) => m.np, ytd.np, "pace", "up", pt.np),
        R("npPct", "Net profit %", "pct", (m) => div(m.np, m.revenue), div(ytd.np, ytd.revenue), "rate", "up", pt.npPct),
        R("clients", "Clients billed", "count", (m) => m.clients.size, lastFull ? f[lastFull.ym].clients.size : null, "level", "up"),
        R("avgClient", "Average revenue per client", "money", (m) => div(m.revenue, m.clients.size), div(ytd.revenue, allClients.size), "pace", "up")
      ]],
      ["Revenue by category · from Xero", SVC_ORDER.filter((k) => done.some((m) => f[m.ym].svc[k])).map((k) =>
        R("svc_" + k, SVC_LABEL[k], "money", (m) => m.svc[k] || 0, sum((m) => m.svc[k] || 0), "pace", "up"))],
      ["Costs · from Xero", [
        R("staffPct", "Staff & contractor cost %", "pct", (m) => div(m.staff, m.revenue), div(ytd.staff, ytd.revenue), "rate", "down"),
        R("mktPct", "Marketing cost %", "pct", (m) => div(m.marketing, m.revenue), div(ytd.marketing, ytd.revenue), "rate", "down")
      ]],
      ["Time · enter or import each month", [
        Object.assign(R("hours", "Hours worked", "count", null, anyHours ? hoursYtd : null, "pace", "up", pt.hours), { input: (ym) => d.hours[ym], inputKey: "hours" }),
        R("perHour", "Revenue per hour worked", "money", null, anyHours && hoursYtd > 0 ? revWithHours / hoursYtd : null, "rate", "up", t && t.rate > 0 ? t.rate : undefined)
      ]],
      ["Marketing · enter each month", d.metrics.map((mt) => {
        const vals = d.values[mt.id] || {};
        const entered = done.filter((m) => has(vals[m.ym]));
        const y = !entered.length ? null : mt.kind === "level" ? num(vals[entered[entered.length - 1].ym]) : entered.reduce((s, m) => s + num(vals[m.ym]), 0);
        return Object.assign(R("m_" + mt.id, mt.name, "count", null, y, mt.kind === "level" ? "level" : "pace", "up"), { metric: mt, input: (ym) => vals[ym] });
      })]
    ];

    const goalOf = (r) => (has(d.goals[r.key]) ? num(d.goals[r.key]) / (r.fmt === "pct" ? 100 : 1) : (r.goalDefault ?? null));
    function judge(r) {
      const g = goalOf(r);
      if (r.ytd === null || g === null || !(g > 0)) return null;
      const ratio = r.ytd / g;
      const aim = r.judge === "pace" ? yearPassed : 1;
      const good = r.better === "up" ? ratio >= aim : ratio <= aim;
      const close = r.better === "up" ? ratio >= aim * 0.85 : ratio <= aim * 1.15;
      return { ratio, status: good ? "green" : close ? "amber" : "red" };
    }

    const head = `<tr><th>Measure</th><th>Goal for the year</th><th>Year to date</th><th>Of goal</th>${months.map((m) => {
      const p = f[m.ym] && f[m.ym].partial;
      return `<th class="${p ? "partial" : ""}">${esc(m.label)}${p ? " so far" : ""}</th>`;
    }).join("")}</tr>`;

    const rowHtml = (r) => {
      const g = goalOf(r);
      const j = judge(r);
      const goalVal = has(d.goals[r.key]) ? d.goals[r.key] : "";
      const ph = r.goalDefault !== undefined && r.goalDefault !== null ? (r.fmt === "pct" ? String(Math.round(r.goalDefault * 100)) : String(Math.round(r.goalDefault))) : "";
      const name = r.metric
        ? `<div class="mcell"><input type="text" class="mname" data-mname="${esc(r.metric.id)}" value="${esc(r.metric.name)}" aria-label="Name of this stat"><select data-mkind="${esc(r.metric.id)}" aria-label="How this stat adds up" title="Count: added up over the year. Total: the number at the end of the month."><option value="count"${r.metric.kind !== "level" ? " selected" : ""}>Count</option><option value="level"${r.metric.kind === "level" ? " selected" : ""}>Total</option></select><button type="button" class="btn-remove" data-mdel="${esc(r.metric.id)}" aria-label="Remove ${esc(r.metric.name)}">×</button></div>`
        : esc(r.label);
      const cells = months.map((m) => {
        const mf = f[m.ym];
        const cls = mf && mf.partial ? "partial" : "";
        if (r.input) {
          if (m.ym > nowYm && !has(r.input(m.ym))) return `<td class="mo future">·</td>`;
          const v = r.input(m.ym);
          const attr = r.inputKey === "hours" ? `data-hours="${m.ym}"` : `data-metric="${esc(r.metric.id)}" data-ym="${m.ym}"`;
          return `<td class="mo ${cls}"><input type="text" inputmode="decimal" class="calc" ${attr} value="${has(v) ? esc(v) : ""}" aria-label="${esc(r.label)}, ${esc(m.label)}"></td>`;
        }
        if (r.key === "perHour") {
          const h = num(d.hours[m.ym]);
          return `<td class="${cls}">${mf && h > 0 ? money(mf.revenue / h) : mf ? "—" : ""}</td>`;
        }
        if (!mf) return `<td class="future">·</td>`;
        const v = r.month(mf);
        return `<td class="${cls}">${v === null ? "—" : FMT[r.fmt](v)}</td>`;
      }).join("");
      return `<tr>
        <td>${name}</td>
        <td class="goal"><input type="text" inputmode="decimal" class="calc" data-goal="${esc(r.key)}" value="${esc(goalVal)}" placeholder="${esc(ph)}" aria-label="Goal for ${esc(r.label)}${r.fmt === "pct" ? " (%)" : ""}"></td>
        <td class="ytd">${r.ytd === null ? "—" : FMT[r.fmt](r.ytd)}</td>
        <td>${j ? `<span class="status ${j.status}">${Math.round(j.ratio * 100)}%</span>` : ""}</td>
        ${cells}</tr>`;
    };

    const tbody = sections.filter(([, rows]) => rows.length).map(([title, rows]) =>
      `<tr class="sec"><td colspan="${4 + months.length}">${esc(title)}</td></tr>` + rows.map(rowHtml).join("") +
      (title.startsWith("Marketing") ? `<tr><td colspan="${4 + months.length}"><button type="button" class="link-btn" id="dashAddMetric">+ Add a stat</button></td></tr>` : "")).join("");

    const rev = sections[0][1][0], np = sections[0][1][4];
    const jr = judge(rev), jn = judge(np);
    body.innerHTML = `
      <div class="dash-pace">
        <div class="summary-grid">
          <div class="stat"><div class="label">Of the year passed</div><div class="value">${Math.round(yearPassed * 100)}%</div><div class="sub">Financial year from ${start.toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })}</div></div>
          <div class="stat"><div class="label">Revenue so far</div><div class="value">${money(ytd.revenue)}</div><div class="sub">${jr ? `${Math.round(jr.ratio * 100)}% of your goal of ${money(goalOf(rev))}` : "Set a goal to track it"}</div></div>
          <div class="stat highlight"><div class="label">Net profit before your pay</div><div class="value">${money(ytd.np)}</div><div class="sub">${jn ? `${Math.round(jn.ratio * 100)}% of your goal of ${money(goalOf(np))}` : "Set a goal to track it"}</div></div>
          <div class="stat navy"><div class="label">Hours worked so far</div><div class="value">${anyHours ? count(hoursYtd) : "—"}</div><div class="sub">${anyHours && hoursYtd > 0 ? money(revWithHours / hoursYtd) + " revenue per hour" : "Add your hours below each month"}</div></div>
        </div>
      </div>
      <div class="table-scroll"><table class="dash-table"><thead>${head}</thead><tbody>${tbody}</tbody></table></div>
      <p class="fine-print">The year-to-date colour compares each figure with how much of the year has passed (or, for percentages, averages and totals, with the goal itself): green on track, gold close, red behind. Blank goals use your Profit target figures, shown in grey. Net profit is before your own pay, as on the Profit target. Clients billed counts anyone invoiced for client fees that month. Staff and marketing costs come from accounts whose names mention staff, wages, contractors or VA, and advertising or marketing.</p>`;
  }

  // Re-render without losing your place in the table. Replacing the table takes focus
  // out of the box you're in, which mustn't start another re-render.
  let rendering = false;
  function rerender() {
    const a = document.activeElement;
    const keys = a && panel.contains(a) ? ["data-goal", "data-hours", "data-metric", "data-ym", "data-mname", "data-mkind"].filter((k) => a.hasAttribute(k)).map((k) => `[${k}="${a.getAttribute(k)}"]`).join("") : "";
    const sel = keys && typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null;
    rendering = true;
    try {
      render();
      const el = keys && panel.querySelector(keys);
      if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (err) { /* selects have no caret */ } }
    } finally {
      rendering = false;
    }
  }

  // ---------- Events ----------
  panel.addEventListener("input", (e) => {
    const t = e.target, d = dash();
    if (t.dataset.goal) d.goals[t.dataset.goal] = t.value.trim();
    else if (t.dataset.hours) d.hours[t.dataset.hours] = t.value.trim();
    else if (t.dataset.metric) (d.values[t.dataset.metric] = d.values[t.dataset.metric] || {})[t.dataset.ym] = t.value.trim();
    else if (t.dataset.mname) { const m = d.metrics.find((x) => x.id === t.dataset.mname); if (m) m.name = t.value; }
    else return;
    live.save();
  });
  panel.addEventListener("change", (e) => {
    const t = e.target, d = dash();
    if (!t.dataset.mkind) return;
    const m = d.metrics.find((x) => x.id === t.dataset.mkind);
    if (m) { m.kind = t.value; live.save(); rerender(); }
  });
  panel.addEventListener("click", (e) => {
    const d = dash();
    const del = e.target.closest("[data-mdel]");
    if (del) {
      d.metrics = d.metrics.filter((m) => m.id !== del.dataset.mdel);
      delete d.values[del.dataset.mdel];
      live.save(); rerender();
      return;
    }
    if (e.target.id === "dashAddMetric") {
      const id = "s" + Date.now().toString(36);
      d.metrics.push({ id, name: "New stat", kind: "count" });
      live.save();
      rendering = true;
      try {
        render();
        const el = panel.querySelector(`[data-mname="${id}"]`);
        if (el) { el.focus(); el.select(); }
      } finally {
        rendering = false;
      }
    }
  });
  // After a number box is worked out (the calculator settles sums as you leave a box), show the new totals
  document.addEventListener("focusout", (e) => {
    if (rendering || e.target.tagName !== "INPUT" || !panel.contains(e.target)) return;
    setTimeout(rerender, 0);
  });

  live.onUpdate(rerender);
  render();
})();
