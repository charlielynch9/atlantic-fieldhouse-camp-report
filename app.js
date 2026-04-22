/* =========================================================================
 * Atlantic Fieldhouse — Camp Registration Report Generator (v4)
 *
 * Reads a Sigma "Event Schedule With Participants" export (.csv or .xlsx)
 *
 * COUNTING LOGIC:
 *   "Register by week"          -> Each row IS one day of attendance (Sigma
 *                                  already exploded to 5 rows). For the
 *                                  Registrations KPI, collapse to one per
 *                                  (participant, week).
 *   "Register for specific days" -> each row = 1 registration = 1 day of
 *                                   attendance.
 *
 * PRICING (edit to match current rates):
 * ========================================================================= */

const AFH_PRICES = {
  '1 Week of Camp (Full Day)':       400,   // per week
  'Summer Camp Full Day (9am-3pm)':  95,    // per day
  'Summer Camp Half Day (9am-12pm)': 55     // per day
};

(function() {
  'use strict';

  const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const REQUIRED_COLUMNS = ['Event Start Date', 'Participant Name', 'Product Name'];
  const WEEKLY_SESSION_NAME = 'Register by week';

  // Camp palette — matches CSS
  const CAMP_COLORS = {
    navy:   '#11304d',
    forest: '#2d6a4f',
    leaf:   '#52b788',
    sun:    '#f9a620',
    clay:   '#e76f51',
    sky:    '#6ba4b8'
  };
  // Day colors for grouped bar chart (mimics the Excel reference)
  const DAY_COLORS = {
    Mon: CAMP_COLORS.navy,
    Tue: CAMP_COLORS.clay,
    Wed: CAMP_COLORS.leaf,
    Thu: CAMP_COLORS.sun,
    Fri: CAMP_COLORS.sky,
    Sat: '#9b5de5',
    Sun: '#6c757d'
  };

  const $ = (id) => document.getElementById(id);
  let chartInstance = null;  // keep Chart.js reference so we can destroy on re-run

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    const fileInput = $('afh-file');
    if (!fileInput) return;

    const fileDisplay = $('afh-file-display');
    const generateBtn = $('afh-generate');
    const statusEl = $('afh-status');
    const loadingEl = $('afh-loading');
    const reportEl = $('afh-report');
    let currentReport = null;

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) {
        fileDisplay.textContent = file.name;
        fileDisplay.classList.add('has-file');
        generateBtn.disabled = false;
        hideStatus();
      } else {
        fileDisplay.textContent = 'Click to choose a .csv or .xlsx file…';
        fileDisplay.classList.remove('has-file');
        generateBtn.disabled = true;
      }
    });

    generateBtn.addEventListener('click', () => {
      const file = fileInput.files[0];
      if (!file) return;
      hideStatus();
      loadingEl.classList.add('active');
      reportEl.classList.remove('active');

      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'csv') parseCSV(file);
      else if (ext === 'xlsx' || ext === 'xls') parseXLSX(file);
      else {
        showError('Unsupported file type. Please upload a .csv or .xlsx file.');
        loadingEl.classList.remove('active');
      }
    });

    function parseCSV(file) {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (r) => processRows(r.data),
        error: (err) => {
          showError('Could not parse CSV: ' + err.message);
          loadingEl.classList.remove('active');
        }
      });
    }

    function parseXLSX(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
          const preferred = wb.SheetNames.find(n =>
            n.toLowerCase().includes('participant') && n.toLowerCase().includes('attendance')
          );
          const sheetName = preferred || wb.SheetNames[wb.SheetNames.length - 1];
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
          processRows(rows);
        } catch (err) {
          showError('Could not read Excel file: ' + err.message);
          loadingEl.classList.remove('active');
        }
      };
      reader.onerror = () => {
        showError('Failed to read file.');
        loadingEl.classList.remove('active');
      };
      reader.readAsArrayBuffer(file);
    }

    function processRows(rows) {
      try {
        if (!rows || rows.length === 0) throw new Error('The file is empty.');
        const cols = Object.keys(rows[0] || {});
        const missing = REQUIRED_COLUMNS.filter(c => !cols.includes(c));
        if (missing.length) {
          throw new Error('Missing required columns: ' + missing.join(', ') +
            '. Did the Sigma export format change?');
        }

        const clean = rows.filter(r =>
          r['Participant Name'] && r['Product Name'] && r['Event Start Date']
        );
        if (clean.length === 0) throw new Error('No valid registration rows found.');

        clean.forEach(r => {
          const d = parseDate(r['Event Start Date']);
          r._date = d;
          r._dow = d ? deriveDayOfWeek(d) : '';
          r._week = d ? deriveWeekLabel(d) : '';
        });

        const report = buildReport(clean);
        currentReport = report;
        renderReport(report);

        loadingEl.classList.remove('active');
        reportEl.classList.add('active');
        reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        console.error(err);
        showError(err.message);
        loadingEl.classList.remove('active');
      }
    }

    function buildReport(rows) {
      const products = uniq(rows.map(r => r['Product Name'])).sort();
      const daysSeen = new Set(rows.map(r => r._dow));
      const days = DAY_ORDER.filter(d => daysSeen.has(d));

      const weekDates = {};
      rows.forEach(r => {
        const wk = r._week;
        if (!wk || !r._date) return;
        if (!weekDates[wk] || r._date < weekDates[wk]) weekDates[wk] = r._date;
      });
      const weeks = Object.keys(weekDates).sort((a, b) => weekDates[a] - weekDates[b]);

      // Attendance matrix (rows = attendance days)
      const att = {};
      weeks.forEach(w => {
        att[w] = {};
        days.forEach(d => {
          att[w][d] = {};
          products.forEach(p => { att[w][d][p] = 0; });
        });
      });
      rows.forEach(r => {
        const w = r._week, d = r._dow, p = r['Product Name'];
        if (att[w] && att[w][d] && att[w][d][p] !== undefined) att[w][d][p]++;
      });

      // Registrations (billable)
      const regs = [];
      const seenWeekly = new Set();
      rows.forEach(r => {
        const isWeekly = (r['Session Name'] || '') === WEEKLY_SESSION_NAME;
        const name = r['Participant Name'];
        const product = r['Product Name'];
        const week = r._week;
        if (isWeekly) {
          const k = name + '||' + week;
          if (seenWeekly.has(k)) return;
          seenWeekly.add(k);
          regs.push({ participant: name, product, week, days: 5,
            amount: AFH_PRICES[product] || 0, type: 'weekly' });
        } else {
          regs.push({ participant: name, product, week, days: 1,
            amount: AFH_PRICES[product] || 0, type: 'daily' });
        }
      });

      // Revenue by week
      const revenueByWeek = {};
      weeks.forEach(w => { revenueByWeek[w] = 0; });
      regs.forEach(r => {
        if (revenueByWeek[r.week] !== undefined) revenueByWeek[r.week] += r.amount;
      });

      // Product × Day matrix (for the grouped bar chart — this is the Excel chart)
      const productDay = {};
      products.forEach(p => {
        productDay[p] = {};
        days.forEach(d => { productDay[p][d] = 0; });
      });
      rows.forEach(r => {
        const p = r['Product Name'], d = r._dow;
        if (productDay[p] && productDay[p][d] !== undefined) productDay[p][d]++;
      });

      // Unique participants by product
      const byProduct = {};
      products.forEach(p => { byProduct[p] = {}; });
      rows.forEach(r => {
        const p = r['Product Name'], name = r['Participant Name'];
        if (!byProduct[p][name]) byProduct[p][name] = 0;
        byProduct[p][name]++;
      });

      const uniqueParticipants = uniq(rows.map(r => r['Participant Name'])).length;
      const uniqueFamilies = uniq(rows.map(r => r['Customer Name']).filter(Boolean)).length;
      const totalAttendanceDays = rows.length;
      const totalRegistrations = regs.length;
      const totalRevenue = regs.reduce((s, r) => s + r.amount, 0);

      return {
        products, days, weeks,
        attendance: att,
        registrations: regs,
        revenueByWeek,
        productDay,
        byProduct,
        kpis: {
          totalAttendanceDays, totalRegistrations, uniqueParticipants,
          uniqueFamilies, totalRevenue, weeksOfCamp: weeks.length
        },
        generatedAt: new Date()
      };
    }

    function renderReport(report) {
      renderAsOf(report.generatedAt);
      renderKPIs(report);
      renderMainPivot(report);
      renderUniqueTable(report);
      renderProductDayChart(report);
      renderRevenueChart(report);
      $('afh-foot-meta').textContent =
        report.kpis.totalAttendanceDays + ' attendance days · ' +
        report.kpis.totalRegistrations + ' registrations · ' +
        report.weeks.length + ' weeks';
    }

    function renderAsOf(date) {
      const opts = { month: 'numeric', day: 'numeric', year: '2-digit' };
      const d = date.toLocaleDateString('en-US', opts);
      const t = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        .toLowerCase().replace(' ', '');
      $('afh-asof').textContent = 'As of ' + d + ' ' + t;
    }

    function renderKPIs(report) {
      const k = report.kpis;
      const kpis = [
        { label: 'Attendance Days', value: k.totalAttendanceDays.toLocaleString(),
          sub: 'Total kid-days on site', icon: iconTent() },
        { label: 'Registrations', value: k.totalRegistrations.toLocaleString(),
          sub: 'Billable bookings', icon: iconTicket() },
        { label: 'Unique Kids', value: k.uniqueParticipants.toLocaleString(),
          sub: k.uniqueFamilies + ' families', icon: iconKids() },
        { label: 'Est. Revenue', value: '$' + k.totalRevenue.toLocaleString(),
          sub: 'At current pricing', icon: iconCoin() }
      ];
      $('afh-kpis').innerHTML = kpis.map(k =>
        '<div class="afh-kpi">' +
          '<div class="afh-kpi-icon">' + k.icon + '</div>' +
          '<div class="afh-kpi-label">' + esc(k.label) + '</div>' +
          '<div class="afh-kpi-value">' + k.value + '</div>' +
          '<div class="afh-kpi-sub">' + esc(k.sub) + '</div>' +
        '</div>'
      ).join('');
    }

    function renderMainPivot(report) {
      const { products, days, weeks, attendance: main } = report;

      const weekDayTotals = {}, weekTotal = {};
      const grandDayProduct = {}, grandDayTotal = {};
      days.forEach(d => {
        grandDayTotal[d] = 0;
        grandDayProduct[d] = {};
        products.forEach(p => { grandDayProduct[d][p] = 0; });
      });
      let grand = 0;

      weeks.forEach(w => {
        weekDayTotals[w] = {};
        weekTotal[w] = 0;
        days.forEach(d => {
          let dayTot = 0;
          products.forEach(p => {
            const v = main[w][d][p];
            dayTot += v;
            grandDayProduct[d][p] += v;
            grandDayTotal[d] += v;
          });
          weekDayTotals[w][d] = dayTot;
          weekTotal[w] += dayTot;
        });
        grand += weekTotal[w];
      });

      let maxCell = 0;
      weeks.forEach(w => days.forEach(d => products.forEach(p => {
        if (main[w][d][p] > maxCell) maxCell = main[w][d][p];
      })));

      let theadTop = '<tr><th rowspan="2" class="afh-th-day">Week</th>';
      days.forEach(d => {
        const dp = products.filter(p => grandDayProduct[d][p] > 0);
        theadTop += '<th colspan="' + dp.length + '" class="afh-th-day">' + esc(d) + '</th>';
        theadTop += '<th rowspan="2" class="afh-th-total">' + esc(d) + ' Total</th>';
      });
      theadTop += '<th rowspan="2" class="afh-th-total">Grand Total</th></tr>';

      let theadBot = '<tr>';
      days.forEach(d => {
        products.filter(p => grandDayProduct[d][p] > 0).forEach(p => {
          theadBot += '<th class="afh-th-product">' + esc(shortProduct(p)) + '</th>';
        });
      });
      theadBot += '</tr>';

      let tbody = '';
      weeks.forEach(w => {
        tbody += '<tr><td class="afh-td-row-label">' + esc(w) + '</td>';
        days.forEach(d => {
          products.filter(p => grandDayProduct[d][p] > 0).forEach(p => {
            tbody += cell(main[w][d][p], maxCell);
          });
          tbody += '<td class="afh-td-day-total">' + (weekDayTotals[w][d] || '—') + '</td>';
        });
        tbody += '<td class="afh-td-grand">' + weekTotal[w] + '</td></tr>';
      });

      tbody += '<tr class="afh-tr-total"><td class="afh-td-row-label">Grand Total</td>';
      days.forEach(d => {
        products.filter(p => grandDayProduct[d][p] > 0).forEach(p => {
          tbody += '<td>' + grandDayProduct[d][p] + '</td>';
        });
        tbody += '<td class="afh-td-day-total">' + grandDayTotal[d] + '</td>';
      });
      tbody += '<td class="afh-td-grand">' + grand + '</td></tr>';

      $('afh-main-pivot').innerHTML =
        '<thead>' + theadTop + theadBot + '</thead><tbody>' + tbody + '</tbody>';
    }

    function cell(v, max) {
      if (!v) return '<td class="afh-td-empty">—</td>';
      const r = max ? v / max : 0;
      let cls = 'heat-1';
      if (r > 0.2)  cls = 'heat-2';
      if (r > 0.35) cls = 'heat-3';
      if (r > 0.55) cls = 'heat-4';
      if (r > 0.75) cls = 'heat-5';
      if (r > 0.9)  cls = 'heat-6';
      return '<td class="' + cls + '">' + v + '</td>';
    }

    function renderUniqueTable(report) {
      const { products, byProduct } = report;
      let html = '<thead><tr><th>Participant</th><th>Days</th></tr></thead><tbody>';
      let grand = 0;
      products.forEach(p => {
        const entries = Object.entries(byProduct[p]).sort((a, b) => a[0].localeCompare(b[0]));
        const total = entries.reduce((s, kv) => s + kv[1], 0);
        grand += total;
        html += '<tr class="afh-group-header"><td>' + esc(p) + '</td><td>' + total + '</td></tr>';
        entries.forEach(kv => {
          html += '<tr class="afh-child-row"><td>' + esc(kv[0]) + '</td><td>' + kv[1] + '</td></tr>';
        });
      });
      html += '<tr class="afh-total-row"><td>Grand Total</td><td>' + grand + '</td></tr></tbody>';
      $('afh-unique-table').innerHTML = html;
    }

    /* =====================================================================
     * Grouped bar chart — replicates the Excel chart you shared.
     * X-axis: each product. Within each product, one bar per day of week.
     * ===================================================================== */
    function renderProductDayChart(report) {
      const { products, days, productDay } = report;
      const canvas = $('afh-product-day-chart');
      if (!canvas) return;

      // Destroy previous instance if re-running
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

      const datasets = days.map(d => ({
        label: d,
        data: products.map(p => productDay[p][d] || 0),
        backgroundColor: DAY_COLORS[d] || CAMP_COLORS.forest,
        borderRadius: 6,
        borderSkipped: false,
        maxBarThickness: 44,
        categoryPercentage: 0.8,
        barPercentage: 0.92
      }));

      chartInstance = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: products.map(p => p),   // full product names, matches Excel
          datasets: datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 600, easing: 'easeOutCubic' },
          plugins: {
            legend: {
              position: 'right',
              align: 'center',
              labels: {
                boxWidth: 14, boxHeight: 14, borderRadius: 4,
                useBorderRadius: true,
                padding: 14,
                font: { size: 13, weight: '600', family: 'inherit' },
                color: CAMP_COLORS.navy
              }
            },
            tooltip: {
              backgroundColor: CAMP_COLORS.navy,
              titleFont: { weight: '700', size: 13 },
              bodyFont: { size: 12.5 },
              padding: 10,
              cornerRadius: 8,
              displayColors: true,
              callbacks: {
                title: (items) => items[0].label,
                label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.y + ' kids'
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                font: { size: 12.5, weight: '600', family: 'inherit' },
                color: CAMP_COLORS.navy,
                autoSkip: false,
                maxRotation: 0,
                minRotation: 0
              }
            },
            y: {
              beginAtZero: true,
              grid: { color: '#f0e8d6', drawBorder: false },
              ticks: {
                font: { size: 11.5, family: 'inherit' },
                color: '#64748b',
                stepSize: 5,
                padding: 6
              }
            }
          }
        }
      });
    }

    /* Revenue chart — clean custom bars, not Chart.js */
    function renderRevenueChart(report) {
      const { weeks, revenueByWeek } = report;
      const max = Math.max(1, ...weeks.map(w => revenueByWeek[w]));
      let html = '<div class="afh-bar-chart">';
      weeks.forEach(w => {
        const v = revenueByWeek[w];
        const pct = (v / max) * 100;
        html +=
          '<div class="afh-bar-row">' +
            '<div class="afh-bar-label">' + esc(w) + '</div>' +
            '<div class="afh-bar-track"><div class="afh-bar-fill revenue" style="width:' + pct + '%"></div></div>' +
            '<div class="afh-bar-value">$' + v.toLocaleString() + '</div>' +
          '</div>';
      });
      html += '</div>';
      $('afh-revenue-chart').innerHTML = html;
    }

    // === Downloads ===
    $('afh-download-png').addEventListener('click', downloadPNG);
    $('afh-download-pdf').addEventListener('click', downloadPDF);
    $('afh-download-xlsx').addEventListener('click', downloadXLSX);

    function downloadPNG() {
      const surface = $('afh-report-surface');
      html2canvas(surface, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false })
        .then(canvas => canvas.toBlob(blob => saveBlob(blob, fileName('png')), 'image/png'))
        .catch(err => showError('PNG export failed: ' + err.message));
    }

    function downloadPDF() {
      const surface = $('afh-report-surface');
      html2canvas(surface, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false })
        .then(canvas => {
          const imgData = canvas.toDataURL('image/png');
          const { jsPDF } = window.jspdf;
          const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
          const pageW = pdf.internal.pageSize.getWidth();
          const pageH = pdf.internal.pageSize.getHeight();
          const imgW = pageW - 40;
          const imgH = (canvas.height / canvas.width) * imgW;
          if (imgH <= pageH - 40) {
            pdf.addImage(imgData, 'PNG', 20, 20, imgW, imgH);
          } else {
            const totalPages = Math.ceil(imgH / (pageH - 40));
            const sliceH = canvas.width * ((pageH - 40) / imgW);
            for (let i = 0; i < totalPages; i++) {
              const sc = document.createElement('canvas');
              sc.width = canvas.width;
              sc.height = Math.min(sliceH, canvas.height - i * sliceH);
              const ctx = sc.getContext('2d');
              ctx.drawImage(canvas, 0, i * sliceH, canvas.width, sc.height, 0, 0, canvas.width, sc.height);
              if (i > 0) pdf.addPage();
              pdf.addImage(sc.toDataURL('image/png'), 'PNG', 20, 20, imgW, (sc.height / sc.width) * imgW);
            }
          }
          pdf.save(fileName('pdf'));
        })
        .catch(err => showError('PDF export failed: ' + err.message));
    }

    function downloadXLSX() {
      if (!currentReport) return;
      const { products, days, weeks, attendance, byProduct, productDay, revenueByWeek } = currentReport;

      const mainHeader = ['Week'];
      days.forEach(d => products.forEach(p => {
        const total = weeks.reduce((s, w) => s + (attendance[w][d][p] || 0), 0);
        if (total > 0) mainHeader.push(d + ' - ' + shortProduct(p));
      }));
      days.forEach(d => mainHeader.push(d + ' Total'));
      mainHeader.push('Grand Total');

      const mainRows = [mainHeader];
      weeks.forEach(w => {
        const row = [w];
        let wTot = 0;
        const dt = {};
        days.forEach(d => {
          dt[d] = 0;
          products.forEach(p => {
            const total = weeks.reduce((s, ww) => s + (attendance[ww][d][p] || 0), 0);
            if (total > 0) {
              const v = attendance[w][d][p] || 0;
              row.push(v); dt[d] += v;
            }
          });
        });
        days.forEach(d => { row.push(dt[d]); wTot += dt[d]; });
        row.push(wTot);
        mainRows.push(row);
      });

      const uniqueRows = [['Category', 'Participant', 'Days']];
      products.forEach(p => {
        const entries = Object.entries(byProduct[p]).sort((a, b) => a[0].localeCompare(b[0]));
        const total = entries.reduce((s, kv) => s + kv[1], 0);
        uniqueRows.push([p, '', total]);
        entries.forEach(kv => uniqueRows.push(['', kv[0], kv[1]]));
      });

      const pdHeader = ['Product'].concat(days);
      const pdRows = [pdHeader];
      products.forEach(p => {
        pdRows.push([p].concat(days.map(d => productDay[p][d])));
      });

      const revRows = [['Week', 'Revenue']];
      weeks.forEach(w => revRows.push([w, revenueByWeek[w]]));

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mainRows), 'Weekly Attendance');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(uniqueRows), 'Unique Participants');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pdRows), 'Product by Day');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(revRows), 'Revenue by Week');
      XLSX.writeFile(wb, fileName('xlsx'));
    }

    // === Helpers ===
    function uniq(arr) { return Array.from(new Set(arr)); }
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function parseDate(v) {
      if (!v) return null;
      if (v instanceof Date) return v;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    function deriveDayOfWeek(date) {
      return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
    }
    function deriveWeekLabel(date) {
      const dow = date.getDay();
      const daysFromMon = (dow === 0) ? 6 : dow - 1;
      const monday = new Date(date);
      monday.setDate(date.getDate() - daysFromMon);
      monday.setHours(0, 0, 0, 0);
      const friday = new Date(monday);
      friday.setDate(monday.getDate() + 4);
      const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const m1 = mn[monday.getMonth()], d1 = monday.getDate();
      const m2 = mn[friday.getMonth()], d2 = friday.getDate();
      if (m1 === m2) return 'Week ' + m1 + ' ' + d1 + '-' + d2;
      return 'Week ' + m1 + ' ' + d1 + '-' + m2 + ' ' + d2;
    }
    function shortProduct(p) {
      return p
        .replace(/\s*\(9am-3pm\)/i, ' (9-3)')
        .replace(/\s*\(9am-12pm\)/i, ' (9-12)')
        .replace(/Summer Camp /i, '')
        .replace(/1 Week of Camp/i, 'Week Pass');
    }
    function fileName(ext) {
      const d = new Date();
      const stamp = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      return 'AFH_Camp_Report_' + stamp + '.' + ext;
    }
    function saveBlob(blob, name) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    }
    function showError(msg) {
      statusEl.className = 'afh-status error';
      statusEl.textContent = msg;
    }
    function hideStatus() { statusEl.className = 'afh-status'; statusEl.textContent = ''; }

    // === Camp-themed inline SVG icons (sized via CSS) ===
    function iconTent() {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20l9-16 9 16H3z"/><path d="M12 4v16"/><path d="M8 20l4-6 4 6"/></svg>';
    }
    function iconTicket() {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a2 2 0 1 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a2 2 0 1 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v2z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>';
    }
    function iconKids() {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M17 13.5a3 3 0 0 1 3 3V19"/></svg>';
    }
    function iconCoin() {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9.5a2.5 2.5 0 0 0-2.5-2.5h-1A2.5 2.5 0 0 0 9 9.5v0a2.5 2.5 0 0 0 2.5 2.5h1A2.5 2.5 0 0 1 15 14.5v0a2.5 2.5 0 0 1-2.5 2.5h-1A2.5 2.5 0 0 1 9 14.5"/><path d="M12 6V5"/><path d="M12 19v-1"/></svg>';
    }
  }

  // Logo SVG (small pine tree) for the app header
  // Called from inline HTML so no need to export.
})();
