const dateValue = value => {
  const text = typeof value === 'string' ? value : value?.value;
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
};

// Match the selection order used by taux_du_jour without changing any rate.
const buildFxRateMetadata = (rows, basis) => {
  const result = {};
  const selected = {};
  for (const row of rows) {
    const key = `${row.devise_base || row.source_currency}_${row.devise_cible || row.target_currency}`;
    if (basis === 'history_fallback' && selected[key]) continue;
    selected[key] = row.taux || row.rate;
    const rate = Number(row.taux ?? row.rate);
    result[key] = {
      rate: Number.isFinite(rate) && rate > 0 ? rate : null,
      date: dateValue(row.date_taux ?? row.date_updated),
      source: typeof row.source_taux === 'string' && row.source_taux.trim() ? row.source_taux.trim() : null,
      basis
    };
  }
  return result;
};

module.exports = { buildFxRateMetadata };
