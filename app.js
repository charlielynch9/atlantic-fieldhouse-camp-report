/* =========================================================================
 * Atlantic Fieldhouse — Camp Registration Report Generator
 *
 * Reads a Sigma "Event Schedule With Participants" export (.csv or .xlsx)
 * and renders three pivot views matching the existing report structure:
 *
 *   1. Overall Counts by Week × (Day of Week × Product)
 *   2. Unique Participants by Camp
 *   3. Participants by Camp × Day of Week
 *
 * All processing is client-side. Files never leave the browser.
 * ========================================================================= */

(function() {
  'use strict';

  // === Configuration ===
  const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const REQUIRED_COLUMNS = [
    'Start Day of Week', 'Week of', 'Event Start Date',
    'Participant Name', 'Product Name'
  ];

  // === DOM references ===
  const $ = (id) => document.getElementById(id);

  // Wait until the markup is in the page (needed when loaded via Webflow embed)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    const fileInput = $('afh-file');
    if (!fileInput) {
      console.warn('[AFH] Markup not found — make sure the embed HTML is on the page.');
      return;
    }

    const fileDisplay = $('afh-file-display');
    const generateBtn = $('afh-generate');
    const statusEl = $('afh-status');
    const loadingEl = $('afh-loading');
    const reportEl = $('afh-report');
    let currentReport = null;

    // File selection
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

    // Generate button
    generateBtn.addEventListener('click', () => {
      const file = fileInput.files[0];
      if (!file) return;
      hideStatus();
      loadingEl.classList.add('active');
      reportEl.classList.remove('active');

      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'csv') {
        parseCSV(file);
      } else if (ext === 'xlsx' || ext === 'xls') {
        parseXLSX(file);
      } else {
        showError('Unsupported file type. Please upload a .csv or .xlsx file.');
        loadingEl.classList.remove('active');
      }
    });

    function parseCSV(file) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => processRows(results.data),
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
          const sheet = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
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
          throw new Error(
            'Missing required columns: ' + missing.join(', ') +
            '. Did the Sigma export format change?'
          );
        }

        const clean = rows.filter(r =>
          r['Participant Name'] && r['Product Name'] && r['Start Day of Week'] && r['Week of']
        );
        if (clean.length === 0) throw new Error('No valid registration rows found.');

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
      const daysSeen = new Set(rows.map(r => r['Start Day of Week']));
      const days = DAY_ORDER.filter(d => daysSeen.has(d));

      const weekDates = {};
      rows.forEach(r => {
        const wk = r['Week of'];
        const d = parseDate(r['Event Start Date']);
        if (!d) return;
        if (!weekDates[wk] || d < weekDates[wk]) weekDates[wk] = d;
      });
      const weeks = Object.keys(weekDates).sort((a, b) => weekDates[a] - weekDates[b]);

      const main = {};
      weeks.forEach(w => {
        main[w] = {};
        days.forEach(d => {
          main[w][d] = {};
          products.forEach(p => { main[w][d][p] = 0; });
        });
      });
      rows.forEach(r => {
        const w = r['Week of'], d = r['Start Day of Week'], p = r['Product Name'];
        if (main[w] && main[w][d] && main[w][d][p] !== undefined) main[w][d][p]++;
      });

      const byProduct = {};
      products.forEach(p => { byProduct[p] = {}; });
      rows.forEach(r => {
        const p = r['Product Name'], name = r['Participant Name'];
        if (!byProduct[p][name]) byProduct[p][name] = 0;
        byProduct[p][name]++;
      });

      const campDay = {};
      products.forEach(p => {
        campDay[p] = {};
        days.forEach(d => { campDay[p][d] = 0; });
      });
      rows.forEach(r => {
        const p = r['Product Name'], d = r['Start Day of Week'];
        if (campDay[p] && campDay[p][d] !== undefined) campDay[p][d]++;
      });

      const uniqueParticipants = uniq(rows.map(r => r['Participant Name'])).length;
      const uniqueFamilies = uniq(rows.map(r => r['Customer Name']).filter(Boolean)).length;
      const totalRegistrations = rows.length;

      return {
        products, days, weeks,
        main, byProduct, campDay,
        kpis: {
          totalRegistrations,
          uniqueParticipants,
          uniqueFamilies,
          weeksOfCamp: weeks.length
        },
        generatedAt: new Date()
      };
    }

    function renderReport(report) {
      renderAsOf(report.generatedAt);
      renderKPIs(report);
      renderMainPivot(report);
      renderUniqueTable(report);
      renderCampDayTable(report);
      $('afh-foot-meta').textContent =
        report.kpis.totalRegistrations + ' registrations · ' +
        report.weeks.length + ' weeks · ' +
        report.products.length + ' programs';
    }

    function renderAsOf(date) {
      const opts = { month: 'numeric', day: 'numeric', year: '2-digit' };
      const d = date.toLocaleDateString('en-US', opts);
      const t = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        .toLowerCase().replace(' ', '');
      $('afh-asof').textContent = 'As of ' + d + ' ' + t;
    }

    function renderKPIs(report) {
      const kpis = [
        { label: 'Total Registrations', value: report.kpis.totalRegistrations },
        { label: 'Unique Participants', value: report.kpis.uniqueParticipants },
        { label: 'Unique Families', value: report.kpis.uniqueFamilies },
        { label: 'Weeks of Camp', value: report.kpis.weeksOfCamp }
      ];
      $('afh-kpis').innerHTML = kpis.map(k =>
        '<div class="afh-kpi">' +
          '<div class="afh-kpi-label">' + esc(k.label) + '</div>' +
          '<div class="afh-kpi-value">' + k.value + '</div>' +
        '</div>'
      ).join('');
    }

    function renderMainPivot(report) {
      const { products, days, weeks, main } = report;

      const weekDayTotals = {}, weekTotal = {};
      const grandDayProduct = {}, grandDayTotal = {}, grandProductTotal = {};
      days.forEach(d => {
        grandDayTotal[d] = 0;
        grandDayProduct[d] = {};
        products.forEach(p => { grandDayProduct[d][p] = 0; });
      });
      products.forEach(p => { grandProductTotal[p] = 0; });
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
            grandProductTotal[p] += v;
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
        const dayProducts = products.filter(p => grandDayProduct[d][p] > 0);
        theadTop += '<th colspan="' + dayProducts.length + '" class="afh-th-day">' + esc(d) + '</th>';
        theadTop += '<th rowspan="2" class="afh-th-total">' + esc(d) + ' Total</th>';
      });
      theadTop += '<th rowspan="2" class="afh-th-total">Grand Total</th></tr>';

      let theadBot = '<tr>';
      days.forEach(d => {
        const dayProducts = products.filter(p => grandDayProduct[d][p] > 0);
        dayProducts.forEach(p => {
          theadBot += '<th class="afh-th-product">' + esc(shortProduct(p)) + '</th>';
        });
      });
      theadBot += '</tr>';

      let tbody = '';
      weeks.forEach(w => {
        tbody += '<tr><td class="afh-td-row-label">' + esc(w) + '</td>';
        days.forEach(d => {
          const dayProducts = products.filter(p => grandDayProduct[d][p] > 0);
          dayProducts.forEach(p => {
            const v = main[w][d][p];
            tbody += cell(v, maxCell);
          });
          const dt = weekDayTotals[w][d];
          tbody += '<td class="afh-td-day-total">' + (dt || '—') + '</td>';
        });
        tbody += '<td class="afh-td-grand">' + weekTotal[w] + '</td></tr>';
      });

      tbody += '<tr class="afh-tr-total"><td class="afh-td-row-label">Grand Total</td>';
      days.forEach(d => {
        const dayProducts = products.filter(p => grandDayProduct[d][p] > 0);
        dayProducts.forEach(p => {
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
      const ratio = max ? v / max : 0;
      let cls = 'heat-0';
      if (ratio > 0)    cls = 'heat-1';
      if (ratio > 0.2)  cls = 'heat-2';
      if (ratio > 0.35) cls = 'heat-3';
      if (ratio > 0.55) cls = 'heat-4';
      if (ratio > 0.75) cls = 'heat-5';
      if (ratio > 0.9)  cls = 'heat-6';
      return '<td class="' + cls + '">' + v + '</td>';
    }

    function renderUniqueTable(report) {
      const { products, byProduct } = report;
      let html = '<thead><tr><th>Participant</th><th>Registrations</th></tr></thead><tbody>';
      let grand = 0;
      products.forEach(p => {
        const entries = Object.entries(byProduct[p]).sort((a, b) => a[0].localeCompare(b[0]));
        const productTotal = entries.reduce((s, kv) => s + kv[1], 0);
        grand += productTotal;
        html += '<tr class="afh-group-header"><td>' + esc(p) + '</td><td>' + productTotal + '</td></tr>';
        entries.forEach(kv => {
          html += '<tr class="afh-child-row"><td>' + esc(kv[0]) + '</td><td>' + kv[1] + '</td></tr>';
        });
      });
      html += '<tr class="afh-total-row"><td>Grand Total</td><td>' + grand + '</td></tr></tbody>';
      $('afh-unique-table').innerHTML = html;
    }

    function renderCampDayTable(report) {
      const { products, days, campDay } = report;
      let thead = '<thead><tr><th class="afh-th-day">Camp</th>';
      days.forEach(d => thead += '<th class="afh-th-day">' + esc(d) + '</th>');
      thead += '<th class="afh-th-total">Grand Total</th></tr></thead>';

      let tbody = '<tbody>';
      const dayGrand = {}; days.forEach(d => dayGrand[d] = 0);
      let allGrand = 0;
      products.forEach(p => {
        tbody += '<tr><td class="afh-td-row-label">' + esc(shortProduct(p)) + '</td>';
        let rowTot = 0;
        days.forEach(d => {
          const v = campDay[p][d];
          rowTot += v; dayGrand[d] += v;
          tbody += v > 0 ? '<td>' + v + '</td>' : '<td class="afh-td-empty">—</td>';
        });
        allGrand += rowTot;
        tbody += '<td class="afh-td-grand">' + rowTot + '</td></tr>';
      });
      tbody += '<tr class="afh-tr-total"><td class="afh-td-row-label">Grand Total</td>';
      days.forEach(d => tbody += '<td class="afh-td-day-total">' + dayGrand[d] + '</td>');
      tbody += '<td class="afh-td-grand">' + allGrand + '</td></tr></tbody>';

      $('afh-camp-day-table').innerHTML = thead + tbody;
    }

    // Downloads
    $('afh-download-png').addEventListener('click', downloadPNG);
    $('afh-download-pdf').addEventListener('click', downloadPDF);
    $('afh-download-xlsx').addEventListener('click', downloadXLSX);

    function downloadPNG() {
      const surface = $('afh-report-surface');
      html2canvas(surface, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false
      }).then(canvas => {
        canvas.toBlob(blob => saveBlob(blob, fileName('png')), 'image/png');
      }).catch(err => showError('PNG export failed: ' + err.message));
    }

    function downloadPDF() {
      const surface = $('afh-report-surface');
      html2canvas(surface, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false
      }).then(canvas => {
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
            const sliceCanvas = document.createElement('canvas');
            sliceCanvas.width = canvas.width;
            sliceCanvas.height = Math.min(sliceH, canvas.height - i * sliceH);
            const ctx = sliceCanvas.getContext('2d');
            ctx.drawImage(canvas, 0, i * sliceH, canvas.width, sliceCanvas.height,
              0, 0, canvas.width, sliceCanvas.height);
            if (i > 0) pdf.addPage();
            const sliceImgH = (sliceCanvas.height / sliceCanvas.width) * imgW;
            pdf.addImage(sliceCanvas.toDataURL('image/png'), 'PNG', 20, 20, imgW, sliceImgH);
          }
        }
        pdf.save(fileName('pdf'));
      }).catch(err => showError('PDF export failed: ' + err.message));
    }

    function downloadXLSX() {
      if (!currentReport) return;
      const { products, days, weeks, main, byProduct, campDay } = currentReport;

      const mainHeader = ['Week'];
      days.forEach(d => products.forEach(p => {
        const total = weeks.reduce((s, w) => s + (main[w][d][p] || 0), 0);
        if (total > 0) mainHeader.push(d + ' - ' + shortProduct(p));
      }));
      days.forEach(d => mainHeader.push(d + ' Total'));
      mainHeader.push('Grand Total');

      const mainRows = [mainHeader];
      weeks.forEach(w => {
        const row = [w];
        let weekTot = 0;
        const dayTotals = {};
        days.forEach(d => {
          dayTotals[d] = 0;
          products.forEach(p => {
            const total = weeks.reduce((s, ww) => s + (main[ww][d][p] || 0), 0);
            if (total > 0) {
              const v = main[w][d][p] || 0;
              row.push(v);
              dayTotals[d] += v;
            }
          });
        });
        days.forEach(d => { row.push(dayTotals[d]); weekTot += dayTotals[d]; });
        row.push(weekTot);
        mainRows.push(row);
      });

      const uniqueRows = [['Category', 'Participant', 'Registrations']];
      products.forEach(p => {
        const entries = Object.entries(byProduct[p]).sort((a, b) => a[0].localeCompare(b[0]));
        const total = entries.reduce((s, kv) => s + kv[1], 0);
        uniqueRows.push([p, '', total]);
        entries.forEach(kv => uniqueRows.push(['', kv[0], kv[1]]));
      });

      const cdHeader = ['Camp'].concat(days).concat(['Grand Total']);
      const cdRows = [cdHeader];
      products.forEach(p => {
        const row = [shortProduct(p)];
        let tot = 0;
        days.forEach(d => { row.push(campDay[p][d]); tot += campDay[p][d]; });
        row.push(tot);
        cdRows.push(row);
      });

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mainRows), 'Weekly Pivot');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(uniqueRows), 'Unique Participants');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cdRows), 'Camp by Day');
      XLSX.writeFile(wb, fileName('xlsx'));
    }

    // Helpers
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
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 100);
    }
    function showError(msg) {
      statusEl.className = 'afh-status error';
      statusEl.textContent = msg;
    }
    function hideStatus() { statusEl.className = 'afh-status'; statusEl.textContent = ''; }
  }
})();
