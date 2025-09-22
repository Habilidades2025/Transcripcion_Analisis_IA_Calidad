// public/scripts.js

// ---------- Utils ----------
function $(id) { return document.getElementById(id); }
function setOut(obj) { const out = $('out'); if (out) out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); }
function basename(p) { if (!p) return null; return p.toString().split(/[\\/]/).pop(); }
function isHttpOrRoot(href) { return typeof href === 'string' && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')); }

// ---------- Tabs ----------
const $tabAnalyze      = $('tabAnalyze');
const $tabConsolidado  = $('tabConsolidado');
const $viewAnalyze     = $('viewAnalyze');
const $viewConsolidado = $('viewConsolidado');

function showAnalyze() {
  if (!$tabAnalyze || !$tabConsolidado || !$viewAnalyze || !$viewConsolidado) return;
  $tabAnalyze.className = 'primary';
  $tabConsolidado.className = 'muted';
  $viewAnalyze.style.display = '';
  $viewConsolidado.style.display = 'none';
}
async function showConsolidado() {
  if (!$tabAnalyze || !$tabConsolidado || !$viewAnalyze || !$viewConsolidado) return;
  $tabAnalyze.className = 'muted';
  $tabConsolidado.className = 'primary';
  $viewAnalyze.style.display = 'none';
  $viewConsolidado.style.display = '';
  await reloadConsolidado();
}
$tabAnalyze?.addEventListener('click', showAnalyze);
$tabConsolidado?.addEventListener('click', showConsolidado);

// ---------- Dependiente: Metodología -> Cartera ----------
const $metodologia  = $('metodologia');
const $carteraField = $('cartera-field');
const $cartera      = $('cartera');

$metodologia?.addEventListener('change', function () {
  const metodologia = this.value;
  if ($cartera) $cartera.innerHTML = '<option value="">Selecciona cartera</option>';

  if (metodologia === 'cobranza') {
    if ($carteraField) $carteraField.style.display = 'block';
    [
      { value: 'carteras_bogota',   text: 'Carteras propias Bogotá'  },
      { value: 'carteras_medellin', text: 'Carteras propias Medellín'}
    ].forEach(op => {
      const option = document.createElement('option');
      option.value = op.value; option.textContent = op.text;
      $cartera?.appendChild(option);
    });
  } else {
    if ($carteraField) $carteraField.style.display = 'none';
  }
});

// ---------- Analizar (BATCH) ----------
const $formBatch  = $('formBatch');
const $matrix     = $('matrix');
const $audios     = $('audios');
const $provider   = $('provider');

// Progreso
const $progressCard = $('progressCard');
const $lblProgress  = $('lblProgress');
const $barProgress  = $('barProgress');
const $listProgress = $('listProgress');

// Resultados
const $resultsCard  = $('resultsCard');
const $detIndividual= $('detIndividual');
const $countInd     = $('countInd');
const $individualList = $('individualList');

const $grpTotal   = $('grpTotal');
const $grpAvg     = $('grpAvg');
const $grpResumen = $('grpResumen');
const $grpHall    = $('grpHall');
const $grpCrit    = $('grpCrit');
const $grpNoCrit  = $('grpNoCrit');
const $grpPlan    = $('grpPlan');

let evtSource = null;

$formBatch?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$matrix?.files?.length || !$audios?.files?.length) {
    alert('Adjunta una matriz y al menos un audio.');
    return;
  }

  // Reset UI
  $progressCard.style.display = '';
  $resultsCard.style.display  = 'none';
  $listProgress.innerHTML     = '';
  $lblProgress.textContent    = `0 / ${$audios.files.length}`;
  $barProgress.style.width    = '0%';

  // Build formdata
  const fd = new FormData();
  fd.append('matrix', $matrix.files[0]);
  Array.from($audios.files).forEach(f => fd.append('audios', f));
  if ($provider?.value)   fd.append('provider', $provider.value);
  if ($metodologia?.value)fd.append('metodologia', $metodologia.value);
  if ($cartera?.value)    fd.append('cartera', $cartera.value);

  try {
    const r = await fetch('/batch/start', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) { alert(j?.error || 'No se pudo iniciar el lote'); return; }

    startSSE(j.jobId);
  } catch (err) {
    alert('Error iniciando lote: ' + (err?.message || err));
  }
});

function startSSE(jobId) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  evtSource = new EventSource(`/batch/progress/${jobId}`);
  evtSource.addEventListener('progress', (ev) => {
    const data = JSON.parse(ev.data);
    updateProgressUI(data);
    if (data.status === 'done') {
      evtSource.close();
      evtSource = null;
      loadBatchResult(jobId);
    }
  });
  evtSource.onerror = () => {
    // si hay error en SSE, lo cerramos para no dejar conexión colgada
    evtSource?.close();
    evtSource = null;
  };
}

function updateProgressUI(p) {
  const total = Number(p.total || 0);
  const done  = Number(p.done || 0);
  $lblProgress.textContent = `${done} / ${total}`;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $barProgress.style.width = `${pct}%`;

  // Lista de archivos con estado
  const frag = document.createDocumentFragment();
  (p.items || []).forEach((it, idx) => {
    const d = document.createElement('div');
    const st = it.status;
    const icon = st === 'done' ? '✅' : (st === 'error' ? '❌' : '⏳');
    d.textContent = `${icon} ${idx + 1}. ${it.name}`;
    frag.appendChild(d);
  });
  $listProgress.innerHTML = '';
  $listProgress.appendChild(frag);
}

async function loadBatchResult(jobId) {
  try {
    const r = await fetch(`/batch/result/${jobId}`);
    const j = await r.json();
    if (!r.ok) { alert(j?.error || 'Error obteniendo resultados'); return; }
    renderBatchResults(j);
  } catch (err) {
    alert('Error obteniendo resultados: ' + (err?.message || err));
  }
}

function renderBatchResults(result) {
  // Mostrar tarjeta de resultados
  $resultsCard.style.display = '';

  // Individuales (colapsables, no se expanden por defecto)
  const items = (result.items || []).filter(it => it.status === 'done' && it.meta);
  $countInd.textContent = String(items.length);

  $individualList.innerHTML = '';
  items.forEach((it) => {
    const m = it.meta;
    const det = document.createElement('details');
    det.innerHTML = `
      <summary><b>${m.agente || '-'}</b> — ${m.cliente || '-'} · <span class="pill">Nota: ${m.nota ?? '-'}</span> · <small>${m.callId}</small></summary>
      <div style="padding:8px 12px">
        <p><b>Resumen:</b> ${m.resumen ? m.resumen : '(sin resumen)'}</p>
        <p><b>Hallazgos:</b></p>
        <ul>${(m.hallazgos || []).map(h => `<li>${escapeHtml(h)}</li>`).join('')}</ul>
        <p><b>Afectados (críticos):</b> ${m.afectadosCriticos?.join(', ') || '—'}</p>
        <p><b>Afectados (no críticos):</b> ${m.afectadosNoCriticos?.join(', ') || '—'}</p>
        <p><b>Sugerencias:</b></p>
        <ul>${(m.sugerencias || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
      </div>
    `;
    $individualList.appendChild(det);
  });

  // Resumen grupal
  const g = result.group || {};
  $grpTotal.textContent   = String(g.total ?? 0);
  $grpAvg.textContent     = String(g.promedio ?? 0);
  $grpResumen.textContent = g.resumen || '';

  $grpHall.innerHTML = (g.topHallazgos || []).map(h => `<li>${escapeHtml(h)}</li>`).join('') || '<li>—</li>';
  $grpCrit.textContent  = (g.atributosCriticos || []).join(', ') || '—';
  $grpNoCrit.textContent= (g.atributosNoCriticos || []).join(', ') || '—';
  $grpPlan.textContent  = g.planMejora || '';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

// ---------- Consolidado ----------
const $btnReload = $('btnReload');
const $summary   = $('summary');
const $tbody     = document.querySelector('#tbl tbody');

function renderSummaryCompatible(s) {
  const isOld = s && (s.totalCalls !== undefined || s.byAgent || s.byCategory);
  const total = isOld ? (s.totalCalls ?? 0) : (s.total ?? 0);
  const prom  = isOld ? (s.averageScore ?? 0) : (s.promedio ?? 0);
  const promTxt = Number.isFinite(+prom) ? Math.round(+prom) : prom;

  let html = `
    <div class="pill">Total llamadas: <b>${total}</b></div>
    <div class="pill">Promedio: <b>${promTxt}</b></div>
  `;

  html += `<h3>Por agente</h3>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:8px;">`;
  if (isOld && s.byAgent) {
    const chips = Object.entries(s.byAgent).map(([k, v]) =>
      `<span class="pill">${k || 'Sin agente'}: ${v.count} (${Math.round(v.avgScore || 0)})</span>`
    );
    html += chips.join('') || '<span>—</span>';
  } else if (Array.isArray(s?.porAgente)) {
    const chips = s.porAgente.map(a =>
      `<span class="pill">${a.agente || 'Sin agente'}: ${a.total} (${Math.round(a.promedio || 0)})</span>`
    );
    html += chips.join('') || '<span>—</span>';
  } else {
    html += '<span>—</span>';
  }
  html += `</div>`;

  html += `<h3>Por categoría</h3>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:8px;">`;
  if (isOld && s.byCategory) {
    const chips = Object.entries(s.byCategory).map(([k, v]) =>
      `<span class="pill">${k}: ${Math.round(v.avgCumplimiento || 0)}%</span>`
    );
    html += chips.join('') || '<span>—</span>';
  } else if (Array.isArray(s?.porCategoria)) {
    const chips = s.porCategoria.map(c =>
      `<span class="pill">${c.atributo}: ${Math.round(c.porcentaje || 0)}%</span>`
    );
    html += chips.join('') || '<span>—</span>';
  } else {
    html += '<span>—</span>';
  }
  html += `</div>`;

  return html;
}

async function loadSummary() {
  if (!$summary) return;
  try {
    const r = await fetch('/audits/summary');
    const s = await r.json();
    if (!r.ok) throw new Error(s?.error || 'Error summary');
    $summary.innerHTML = renderSummaryCompatible(s);
  } catch (e) {
    $summary.innerHTML = `<span style="color:#b00">Error cargando resumen: ${e.message || e}</span>`;
  }
}

async function loadAudits() {
  if (!$tbody) return;
  try {
    const r = await fetch('/audits');
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'Error audits');

    const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
    $tbody.innerHTML = '';

    items.forEach(it => {
      const tr = document.createElement('tr');
      const ts = it?.metadata?.timestamp ? new Date(it.metadata.timestamp).toLocaleString() : '-';
      const call  = it?.metadata?.callId || '-';
      const ag    = it?.metadata?.agentName    || it?.analisis?.agent_name  || '-';
      const cli   = it?.metadata?.customerName || it?.analisis?.client_name || '-';
      const nota  = it?.consolidado?.notaFinal ?? '-';

      let reporteHtml = '—';
      if (it?.reportPath) {
        const href = isHttpOrRoot(it.reportPath) ? it.reportPath : ('/audits/files/' + basename(it.reportPath));
        reporteHtml = `<a href="${href}" target="_blank" rel="noopener">MD</a>`;
      }

      tr.innerHTML = `
        <td>${ts}</td>
        <td>${call}</td>
        <td>${ag}</td>
        <td>${cli}</td>
        <td>${nota}</td>
        <td>${reporteHtml}</td>
      `;
      $tbody.appendChild(tr);
    });

    if ($tbody.children.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Sin auditorías aún.';
      tr.appendChild(td);
      $tbody.appendChild(tr);
    }
  } catch (e) {
    $tbody.innerHTML = `<tr><td colspan="6" style="color:#b00">Error cargando auditorías: ${e.message || e}</td></tr>`;
  }
}

async function reloadConsolidado() {
  await Promise.all([loadSummary(), loadAudits()]);
}
$('btnReload')?.addEventListener('click', reloadConsolidado);

// ---------- Estado inicial ----------
showAnalyze();
