function previousMonth(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('DATE_INVALID');
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('DATE_INVALID');
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() - 1);
  return parsed.toISOString().slice(0, 7);
}

function validationError(data, today) {
  if (!/^\d{4}-\d{2}$/.test(data.period) || Number(data.period.slice(5)) < 1 || Number(data.period.slice(5)) > 12) return 'La période de salaire est à préciser.';
  try { previousMonth(data.receivedDate); } catch { return 'Indique la date réelle de réception.'; }
  if (data.receivedDate > today) return 'La date de réception ne peut pas être dans le futur.';
  if (!Number.isSafeInteger(data.amount) || data.amount <= 0) return 'Le montant est à vérifier.';
  if (data.channel === 'accompanied' && !data.collector.trim()) return 'Indique la personne qui recueille la confirmation.';
  if (!data.checked) return 'La confirmation doit être volontaire.';
  return '';
}

function scopedWolofAudio(worker, fields) {
  if (!/^data:audio\/(mpeg|wav|ogg|mp4);base64,[A-Za-z0-9+/=]+$/.test(worker.wolofAudio || '')) return null;
  if (worker.wolofScope && (worker.wolofScope.period !== fields.period || worker.wolofScope.amount !== fields.amount)) return null;
  return worker.wolofAudio;
}

function applyWolofTemplate(template, worker, fields) {
  const audio = scopedWolofAudio(worker, fields) || '';
  const mime = audio.match(/^data:audio\/(mpeg|wav|ogg|mp4);/)?.[1];
  const extension = { mpeg: 'mp3', wav: 'wav', ogg: 'ogg', mp4: 'm4a' }[mime] || 'm4a';
  const amount = Number.isSafeInteger(fields.amount) && fields.amount > 0 ? new Intl.NumberFormat('fr-FR').format(fields.amount) : 'le montant indiqué en';
  return template.replaceAll('__CONFIRMATION_AMOUNT__', amount).replaceAll('__WOLOF_SOURCE__', audio)
    .replaceAll('__WOLOF_MEDIA_ATTRIBUTE__', audio ? `src="${audio}"` : '')
    .replaceAll('__WOLOF_LINK_ATTRIBUTE__', audio ? `href="${audio}"` : '')
    .replaceAll('__WOLOF_VISIBILITY__', audio ? '' : 'hidden')
    .replaceAll('__WOLOF_FILENAME__', `2SG-consignes-wolof.${extension}`);
}

function individualSeed(config, worker, fields) {
  return {
    mode: 'individual', period: fields.period, transferDate: fields.transferDate,
    receivedDate: fields.receivedDate, channel: fields.channel, collector: fields.collector,
    workers: [{ key: worker.key, name: worker.name, role: worker.role, amount: fields.amount, photo: worker.photo || null,
      wolofAudio: scopedWolofAudio(worker, fields),
      wolofScope: scopedWolofAudio(worker, fields) && worker.wolofScope ? { period: fields.period, amount: fields.amount } : null }],
    site: config.site, revision: '2026-10-04', routine: 'after_payment',
    theme: ['light', 'dark', 'deep'].includes(config.theme) ? config.theme : 'light',
    templateBase64: config.templateBase64
  };
}

function spokenInstructions(name, month, amount, accompanied = false) {
  const action = accompanied ? 'appuie sur le bouton vert Consigner la déclaration orale' : 'appuie sur le bouton vert Valider ma confirmation';
  return `${name}. Salaire de ${month}. ${amount} francs CFA. Indique d’abord le jour où tu as réellement reçu ton salaire. Si tu as reçu ce montant pour cette période, coche la case à côté du texte écrit en vert. Ensuite, ${action}. Si le montant ou la date ne correspond pas, ne confirme pas : choisis Signaler une différence. Ta déclaration reste sur cet appareil. Conserve-la ou copie le message pour le transmettre au contact 2SG convenu. Pour ton reçu, ouvre la rubrique Mon reçu Wave, avec le logo du pingouin bleu. N’envoie jamais ton code secret, ton solde ni tout ton historique.`;
}

function audioFormat(bytes) {
  if (bytes.length < 12) return null;
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp' && mp4AudioOnly(bytes)) return 'audio/mp4';
  return null;
}

function mp4AudioOnly(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  // Inspect bounded ISO media boxes, not filename/MIME alone; reject video tracks.
  function boxes(start, end) {
    const result = [];
    while (start < end) {
      if (end - start < 8) throw new Error();
      let size = view.getUint32(start), header = 8;
      if (size === 1) {
        if (end - start < 16) throw new Error();
        size = Number(view.getBigUint64(start + 8)); header = 16;
      } else if (!size) size = end - start;
      if (!Number.isSafeInteger(size) || size < header || size > end - start) throw new Error();
      result.push({ type: ascii(start + 4, start + 8), start: start + header, end: start + size });
      start += size;
    }
    return result;
  }
  try {
    const root = boxes(0, bytes.length), ftyp = root[0];
    if (ftyp.type !== 'ftyp' || ftyp.end - ftyp.start < 8 || (ftyp.end - ftyp.start) % 4) return false;
    const brands = [ascii(ftyp.start, ftyp.start + 4)];
    for (let i = ftyp.start + 8; i < ftyp.end; i += 4) brands.push(ascii(i, i + 4));
    if (!brands.some(brand => ['M4A ', 'mp41', 'mp42', 'isom', 'iso2'].includes(brand))) return false;
    const movies = root.filter(box => box.type === 'moov');
    if (movies.length !== 1 || !root.some(box => box.type === 'mdat' && box.end > box.start)) return false;
    const tracks = boxes(movies[0].start, movies[0].end).filter(box => box.type === 'trak');
    if (!tracks.length) return false;
    return tracks.every(track => {
      const media = boxes(track.start, track.end).filter(box => box.type === 'mdia');
      if (media.length !== 1) return false;
      const handlers = boxes(media[0].start, media[0].end).filter(box => box.type === 'hdlr');
      return handlers.length === 1 && handlers[0].end - handlers[0].start >= 12 && ascii(handlers[0].start + 8, handlers[0].start + 12) === 'soun';
    });
  } catch { return false; }
}

function workMinutes(start, end, pause, overnight) {
  const valid = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!valid(start) || !valid(end)) throw new Error('Indique les heures de début et de fin.');
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const span = minutes(end) - minutes(start) + (overnight ? 1440 : 0);
  if (span <= 0 || span > 1440) throw new Error('Vérifie les horaires et la case « Fin le lendemain ».');
  if (!Number.isSafeInteger(pause) || pause < 0 || pause >= span) throw new Error('La pause doit être inférieure à la durée de présence.');
  return span - pause;
}

function workInterval(entry) {
  previousMonth(entry.date);
  const duration = workMinutes(entry.start, entry.end, entry.pause, entry.overnight);
  const start = Date.parse(`${entry.date}T${entry.start}:00Z`);
  return { start, end: start + (duration + entry.pause) * 60000 };
}

function mergeWorkEntries(existing, incoming) {
  const result = [...existing];
  let skipped = 0;
  const slot = entry => `${entry.date}|${entry.start}|${entry.end}|${entry.overnight}`;
  for (const candidate of incoming) {
    const interval = workInterval(candidate);
    const sameId = candidate.id && result.find(entry => entry.id === candidate.id);
    const duplicate = result.find(entry => slot(entry) === slot(candidate));
    if (sameId && (slot(sameId) !== slot(candidate) || sameId.pause !== candidate.pause)) throw new Error('Le fichier contient une autre version d’une saisie existante. Rien n’a été remplacé.');
    if (duplicate) {
      if (duplicate.pause !== candidate.pause) throw new Error('Ces horaires existent avec une autre pause. Modifie la saisie existante ; rien n’a été remplacé.');
      skipped += 1;
      continue;
    }
    if (result.some(entry => {
      const other = workInterval(entry);
      return interval.start < other.end && interval.end > other.start;
    })) throw new Error('Ces horaires chevauchent une saisie existante, éventuellement la nuit précédente. Vérifie les horaires.');
    result.push(candidate);
  }
  return { entries: result, skipped };
}

function monthWorkEntries(entries, month) {
  return entries.filter(entry => entry.date.slice(0, 7) === month);
}

function monthlyWorkText(worker, entries, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choisis un mois pour préparer le relevé.');
  const selected = [...monthWorkEntries(entries, month)].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const duration = value => `${Math.floor(value / 60)} h ${String(value % 60).padStart(2, '0')}`;
  let total = 0;
  const lines = selected.map(entry => {
    workInterval(entry);
    const minutes = workMinutes(entry.start, entry.end, entry.pause, entry.overnight);
    total += minutes;
    const date = entry.date.split('-').reverse().join('.');
    return `${date} · ${entry.start}–${entry.end}${entry.overnight ? ' (fin le lendemain)' : ''} · pause ${entry.pause} min · ${duration(minutes)}`;
  });
  const period = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
  return [
    '2SG · Relevé mensuel d’heures', `${worker.name} · ${worker.role}`, `Mois : ${period}`, 'Horaires : Dakar', '',
    ...(lines.length ? lines : ['Aucune heure déclarée pour ce mois.']), '',
    `Total déclaré : ${duration(total)} · ${selected.length} saisie(s)`,
    'Nuits rattachées au jour de début. Ce relevé couvre uniquement les saisies disponibles.', '',
    'Déclaration locale non authentifiée, non validée par 2SG. Aucun calcul de salaire.',
    'Aucun envoi automatique ni enregistrement dans M3S.'
  ].join('\n');
}

function hoursFileState(revision, exportedRevision, count) {
  const pending = revision > exportedRevision;
  const canExport = revision > 0 || count > 0;
  return { pending, canExport, label: pending ? 'À conserver' : canExport ? 'Export préparé' : 'Aucune saisie à conserver' };
}

if (typeof module !== 'undefined') module.exports = { previousMonth, validationError, individualSeed, spokenInstructions, audioFormat, workMinutes, workInterval, mergeWorkEntries, monthWorkEntries, monthlyWorkText, hoursFileState, scopedWolofAudio, applyWolofTemplate };
