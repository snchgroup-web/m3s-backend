const numberOrZero = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeFinanceTransaction = (body, id, kind) => {
  const date = String(body.date || body.date_created || '').slice(0, 10);
  const description = String(body.description || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !description) {
    throw new Error('La date et la designation sont obligatoires.');
  }

  const deviseOrigine = String(body.devise_origine || body.devise || 'CHF').toUpperCase();
  if (!['CHF', 'CFA'].includes(deviseOrigine)) {
    throw new Error('La devise doit etre CHF ou CFA.');
  }

  const montantOrigine = numberOrZero(body.montant_origine ?? body.montant);
  const montantChf = numberOrZero(body.montant_chf);
  const montantCfa = numberOrZero(body.montant_cfa);
  const tauxFxApplique = numberOrZero(body.taux_fx_applique ?? body.taux_fx);
  const tauxFxReference = numberOrZero(body.taux_fx_reference ?? body.taux_ref_auto);

  if (montantOrigine <= 0 || montantChf <= 0 || montantCfa <= 0 || tauxFxApplique <= 0) {
    throw new Error('Les montants CHF/CFA et le taux applique exact sont obligatoires.');
  }

  return {
    id,
    date,
    description,
    montant_origine: montantOrigine,
    devise_origine: deviseOrigine,
    montant_chf: montantChf,
    montant_cfa: montantCfa,
    // taux_fx remains available for existing consumers and means applied rate.
    taux_fx: tauxFxApplique,
    taux_fx_applique: tauxFxApplique,
    taux_fx_reference: tauxFxReference,
    categorie: String(body.categorie || (kind === 'income' ? 'Recettes' : 'Depenses')),
    type: String(body.type || (kind === 'income' ? 'Virement' : 'Paiement')),
    departement: String(body.departement || ''),
    team: String(body.team || ''),
    phase_projet: String(body.phase_projet || ''),
    agent: String(body.agent || ''),
    pays: String(body.pays || ''),
    commentaire: String(body.commentaire || ''),
    fournisseur: String(body.fournisseur || ''),
    annee: Number(date.slice(0, 4))
  };
};

module.exports = {
  numberOrZero,
  normalizeFinanceTransaction,
};
