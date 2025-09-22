export function scoreFromMatrix(analysis, matrix) {
  const norm = (s) => String(s || '').trim().toLowerCase();

  const mapPeso = new Map();
  const mapCategoria = new Map();
  for (const m of matrix) {
    const key = norm(m.atributo);
    mapPeso.set(key, Number(m.peso) || 0);
    mapCategoria.set(key, m.categoria);
  }

  const porAtributo = [];
  let totalDeducciones = 0;

  for (const a of (analysis.atributos || [])) {
    const key = norm(a.atributo);
    const peso = mapPeso.has(key) ? mapPeso.get(key) : 0;
    const cumplido = !!a.cumplido;
    const deduccion = cumplido ? 0 : peso;
    totalDeducciones += deduccion;

    porAtributo.push({
      atributo: a.atributo,
      categoria: a.categoria || mapCategoria.get(key) || '',
      peso,
      cumplido,
      deduccion,
      justificacion: a.justificacion || '',
      mejora: a.mejora || '',
      reconocimiento: a.reconocimiento || ''
    });
  }

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
    if (a.cumplido) c.cumplimiento.cumplidos += 1;
    else {
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

  const notaFinal = Math.max(0, Math.min(100, 100 - totalDeducciones));

  return { notaBase: 100, totalDeducciones, notaFinal, porCategoria, porAtributo };
}
