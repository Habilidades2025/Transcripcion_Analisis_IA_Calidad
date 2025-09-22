import OpenAI from 'openai';

function isCritical(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (typeof attr.critico === 'boolean') return attr.critico;

  const cat = String(attr.categoria || attr.category || '').toLowerCase();
  if (cat.includes('crítico') || cat.includes('critico')) return true;

  const thr = Number(process.env.CRITICAL_WEIGHT_THRESHOLD ?? 10);
  const peso = Number(attr.peso);
  return Number.isFinite(peso) && peso >= thr;
}

export function buildBlockStats(audits = []) {
  const total = audits.length;
  const notas = audits.map(a => Number(a?.consolidado?.notaFinal || 0));
  const promedio = total ? Math.round(notas.reduce((s, n) => s + n, 0) / total) : 0;

  // Por agente
  const porAgenteMap = new Map();
  for (const a of audits) {
    const ag = a?.metadata?.agentName || 'Sin agente';
    const rec = porAgenteMap.get(ag) || { agente: ag, total: 0, suma: 0 };
    rec.total += 1;
    rec.suma += Number(a?.consolidado?.notaFinal || 0);
    porAgenteMap.set(ag, rec);
  }
  const porAgente = Array.from(porAgenteMap.values()).map(r => ({
    agente: r.agente,
    total: r.total,
    promedio: Math.round(r.suma / r.total)
  })).sort((a, b) => a.agente.localeCompare(b.agente, 'es'));

  // Incumplidos (críticos vs no críticos) por frecuencia
  const freqCrit = new Map();
  const freqNoCrit = new Map();

  for (const a of audits) {
    const arr = Array.isArray(a?.consolidado?.porAtributo) ? a.consolidado.porAtributo : [];
    for (const it of arr) {
      if (it?.cumplido === false) {
        const k = String(it?.atributo || '(sin nombre)');
        const target = isCritical(it) ? freqCrit : freqNoCrit;
        target.set(k, (target.get(k) || 0) + 1);
      }
    }
  }
  const topCriticos = Array.from(freqCrit.entries())
    .map(([atributo, veces]) => ({ atributo, veces }))
    .sort((a, b) => b.veces - a.veces)
    .slice(0, 10);

  const topNoCriticos = Array.from(freqNoCrit.entries())
    .map(([atributo, veces]) => ({ atributo, veces }))
    .sort((a, b) => b.veces - a.veces)
    .slice(0, 10);

  return { total, promedio, porAgente, topCriticos, topNoCriticos };
}

async function llmNarrative(stats, audits) {
  if (process.env.BLOCK_SUMMARY_USE_LLM !== '1') return null;
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: Number(process.env.OPENAI_TIMEOUT_MS || 120_000),
    });
    const compact = {
      total: stats.total,
      promedio: stats.promedio,
      porAgente: stats.porAgente,
      topCriticos: stats.topCriticos,
      topNoCriticos: stats.topNoCriticos,
    };
    // además pasamos 3-5 resúmenes individuales para contexto
    const someSummaries = audits.slice(0, 5).map(a => ({
      agente: a?.metadata?.agentName || '-',
      cliente: a?.metadata?.customerName || '-',
      nota: a?.consolidado?.notaFinal ?? 0,
      resumen: a?.analisis?.resumen || ''
    }));

    const messages = [
      { role: 'system', content: 'Eres un auditor senior. Redactas un resumen ejecutivo en español, breve y accionable.' },
      { role: 'user', content:
`Genera un resumen de bloque (máx. 200 palabras) con:
- desempeño global (total y promedio),
- patrones por agente (sin listar a todos),
- top incumplimientos críticos/no críticos,
- 3 acciones recomendadas.

Datos:
${JSON.stringify({ compact, someSummaries }, null, 2)}`
      }
    ];
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 300,
      messages,
    });
    return resp.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

export async function buildBlockMarkdown({ batchId, audits }) {
  const stats = buildBlockStats(audits);
  const narrative = await llmNarrative(stats, audits);

  const tabla = [
    '| Fecha | Call ID | Agente | Cliente | Nota |',
    '|------:|--------:|--------|---------|-----:|',
    ...audits.map(a => {
      const fecha = a?.metadata?.timestamp ? new Date(a.metadata.timestamp).toLocaleString() : '-';
      const call  = a?.metadata?.callId || '-';
      const ag    = a?.metadata?.agentName || '-';
      const cli   = a?.metadata?.customerName || '-';
      const nota  = a?.consolidado?.notaFinal ?? '-';
      return `| ${fecha} | ${call} | ${ag} | ${cli} | ${nota} |`;
    })
  ].join('\n');

  const topCrit = stats.topCriticos.map(t => `- ${t.atributo} (${t.veces})`).join('\n') || '—';
  const topNo   = stats.topNoCriticos.map(t => `- ${t.atributo} (${t.veces})`).join('\n') || '—';

  const porAgente = stats.porAgente.map(a => `- ${a.agente}: ${a.total} llamadas (prom. ${a.promedio})`).join('\n') || '—';

  const md = `# Resumen de Lote — ${batchId}

**Total llamadas:** ${stats.total}  
**Promedio:** ${stats.promedio}

## Resumen ejecutivo
${narrative || 'No se pudo generar un resumen ejecutivo automático. Revisa los KPIs y hallazgos a continuación.'}

## KPIs por agente
${porAgente}

## Top incumplimientos críticos
${topCrit}

## Top incumplimientos NO críticos
${topNo}

## Llamadas del lote
${tabla}
`;

  return { markdown: md, stats };
}
