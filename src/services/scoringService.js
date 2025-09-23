// src/services/scoringService.js

/**
 * Calcula la nota final a partir del análisis y la matriz.
 * - Deduce el peso de cada atributo NO cumplido.
 * - Marca "crítico" si el peso >= CRITICAL_WEIGHT_VALUE (por defecto 100).
 * - Si el análisis no trae un atributo o no especifica "cumplido",
 *   se aplica FAIL-CLOSED para críticos (cumplido=false) y PASS-OPEN para no críticos (cumplido=true).
 * - Garantiza que "porAtributo" tenga TODOS los atributos de la matriz en orden.
 * - Mantiene compatibilidad con campos existentes: { notaBase, totalDeducciones, notaFinal, porCategoria, porAtributo }.
 */

export function scoreFromMatrix(analysis = {}, matrix = [], opts = {}) {
  const norm = (s) => String(s || '').trim().toLowerCase();

  // Umbral para considerar un atributo como crítico según su peso.
  const CRIT_THR = Number(process.env.CRITICAL_WEIGHT_VALUE ?? opts.criticalWeight ?? 100);

  // ---- Mapas desde la matriz ----
  const mPeso = new Map();       // atributo (norm) -> peso (number)
  const mCat  = new Map();       // atributo (norm) -> categoría (string)
  const mName = [];              // lista en orden para preservar orden de la matriz

  for (const m of (matrix || [])) {
    const key = norm(m.atributo ?? m.Atributo);
    if (!key) continue;
    const peso = safeNum(m.peso ?? m.Peso);
    mPeso.set(key, peso);
    mCat.set(key, String(m.categoria ?? m.Categoria ?? '').trim());
    mName.push(key);
  }

  // ---- Análisis: deduplicamos por nombre normalizado (primer valor gana) ----
  const aMap = new Map();
  for (const a of (analysis?.atributos || [])) {
    const key = norm(a?.atributo);
    if (!key || aMap.has(key)) continue;
    aMap.set(key, a);
  }

  // ---- Construimos porAtributo en el orden de la matriz (lista cerrada) ----
  const porAtributo = [];
  let totalDeducciones = 0;

  for (const key of mName) {
    const peso = mPeso.get(key) ?? 0;
    const categoria = mCat.get(key) ?? 'Sin categoría';
    const critico = peso >= CRIT_THR;

    const src = aMap.get(key) || null;

    // Fail-closed para críticos si falta info; pass-open para no críticos
    const cumplido = typeof src?.cumplido === 'boolean'
      ? !!src.cumplido
      : (!critico); // si es crítico y no hay dato, NO cumple

    const deduccion = cumplido ? 0 : peso;
    totalDeducciones += deduccion;

    const justificacion = pickJustificacion(src?.justificacion, cumplido, critico);
    const mejora = src?.mejora ?? (cumplido ? null : 'Definir acciones concretas para cumplir el criterio.');
    const reconocimiento = src?.reconocimiento ?? null;

    porAtributo.push({
      atributo: src?.atributo || displayFromKey(key),
      categoria: src?.categoria || categoria,
      peso,
      critico,
      cumplido,
      deduccion,
      justificacion,
      mejora,
      reconocimiento
    });
  }

  // (Opcional) Transparencia: si el análisis trajo atributos que NO existen en la matriz,
  // los anexamos como informativos con peso/deducción 0. No afectan la nota.
  for (const [key, src] of aMap.entries()) {
    if (mPeso.has(key)) continue; // ya fue contemplado
    porAtributo.push({
      atributo: src?.atributo || displayFromKey(key),
      categoria: src?.categoria || 'Fuera de matriz',
      peso: 0,
      critico: false,
      cumplido: !!src?.cumplido,
      deduccion: 0,
      justificacion: src?.justificacion || 'Atributo no presente en la matriz. Solo para referencia.',
      mejora: src?.mejora ?? null,
      reconocimiento: src?.reconocimiento ?? null
    });
  }

  // ---- Agregación por categoría ----
  const porCategoriaMap = new Map();
  for (const a of porAtributo) {
    const cat = a.categoria || 'Sin categoría';
    if (!porCategoriaMap.has(cat)) {
      porCategoriaMap.set(cat, {
        categoria: cat,
        cumplimiento: { cumplidos: 0, noCumplidos: 0, porcentaje: 0 },
        recomendaciones: new Set()
      });
    }
    const c = porCategoriaMap.get(cat);
    if (a.cumplido) {
      c.cumplimiento.cumplidos += 1;
    } else {
      c.cumplimiento.noCumplidos += 1;
      if (a.mejora) c.recomendaciones.add(a.mejora);
    }
  }

  const porCategoria = [];
  for (const [cat, data] of porCategoriaMap.entries()) {
    const total = data.cumplimiento.cumplidos + data.cumplimiento.noCumplidos;
    data.cumplimiento.porcentaje = total ? Math.round((data.cumplimiento.cumplidos / total) * 100) : 0;
    porCategoria.push({
      categoria: cat,
      cumplimiento: data.cumplimiento,
      recomendaciones: Array.from(data.recomendaciones)
    });
  }

  // ---- Nota final ----
  const notaBase = 100;
  const notaFinal = clamp0to100(notaBase - totalDeducciones);

  return { notaBase, totalDeducciones, notaFinal, porCategoria, porAtributo };
}

/* -------------------- helpers -------------------- */

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function clamp0to100(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function displayFromKey(key) {
  // Reconstruye un nombre "bonito" desde el key normalizado (solo para fallback)
  return key.split(' ').map(w => w ? (w[0].toUpperCase() + w.slice(1)) : '').join(' ');
}
function pickJustificacion(srcJust, cumplido, critico) {
  const j = String(srcJust || '').trim();
  if (j) return j;
  if (cumplido) return 'No se evidencia incumplimiento';
  return critico
    ? 'No se encontró evidencia explícita de cumplimiento (fail-closed por criticidad).'
    : 'Incumplimiento detectado o evidencia insuficiente.';
}
