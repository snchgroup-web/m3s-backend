const fs = require('fs');
const path = require('path');

const frontendTaxonomyPath = path.resolve(
  __dirname,
  '..',
  process.env.FRONTEND_TAXONOMY_PATH || '../m3s-frontend-v2/src/shared/offerTaxonomy.json'
);
const backendTaxonomyPath = path.resolve(__dirname, '..', 'referentiels', 'offerTaxonomy.json');

const CRITICAL_FIELDS = [
  'das_strategique',
  'famille_offre',
  'sous_famille_offre',
  'type_offre',
  'scope',
  'category',
  'active',
];

function readJson(filePath, label, errors) {
  if (!fs.existsSync(filePath)) {
    errors.push(`${label} file not found: ${filePath}`);
    return null;
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    errors.push(`Cannot read ${label} file at ${filePath}: ${error.message}`);
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    errors.push(`Invalid ${label} JSON at ${filePath}: ${error.message}`);
    return null;
  }
}

function indexItems(taxonomy, label, errors) {
  const index = new Map();

  if (!taxonomy || !Array.isArray(taxonomy.items)) {
    errors.push(`${label}: items must be an array.`);
    return index;
  }

  taxonomy.items.forEach((item, position) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${label}: item[${position}] must be an object.`);
      return;
    }

    if (typeof item.code !== 'string' || item.code.trim() === '') {
      errors.push(`${label}: item[${position}] must have a non-empty code.`);
      return;
    }

    if (index.has(item.code)) {
      errors.push(`${label}: duplicate code ${item.code}.`);
      return;
    }

    index.set(item.code, item);
  });

  return index;
}

function compareArrays(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function compareTaxonomies(frontend, backend, errors) {
  if (!frontend || !backend) {
    return;
  }

  if (frontend.version !== backend.version) {
    errors.push(`version mismatch: frontend ${frontend.version} / backend ${backend.version}`);
  }

  if (frontend.validated_at !== backend.validated_at) {
    errors.push(`validated_at mismatch: frontend ${frontend.validated_at} / backend ${backend.validated_at}`);
  }

  if (!Array.isArray(frontend.items) || !Array.isArray(backend.items)) {
    return;
  }

  if (frontend.items.length !== backend.items.length) {
    errors.push(`items count mismatch: frontend ${frontend.items.length} / backend ${backend.items.length}`);
  }

  const frontendItems = indexItems(frontend, 'frontend', errors);
  const backendItems = indexItems(backend, 'backend', errors);

  frontendItems.forEach((frontendItem, code) => {
    const backendItem = backendItems.get(code);
    if (!backendItem) {
      errors.push(`missing backend code: ${code}`);
      return;
    }

    CRITICAL_FIELDS.forEach((field) => {
      if (frontendItem[field] !== backendItem[field]) {
        errors.push(
          `${code}: ${field} mismatch: frontend ${String(frontendItem[field])} / backend ${String(backendItem[field])}`
        );
      }
    });

    if (!compareArrays(frontendItem.aliases || [], backendItem.aliases || [])) {
      errors.push(`${code}: aliases mismatch.`);
    }
  });

  backendItems.forEach((_, code) => {
    if (!frontendItems.has(code)) {
      errors.push(`extra backend code: ${code}`);
    }
  });

  verifySensitiveRules('frontend', frontendItems, errors);
  verifySensitiveRules('backend', backendItems, errors);
}

function verifySensitiveRules(label, items, errors) {
  if (items.has('KM')) {
    errors.push(`${label}: KM must not be a standalone entry.`);
  }

  if (items.has('IA')) {
    errors.push(`${label}: IA must not be a standalone entry.`);
  }

  const knowledgeManagement = items.get('KNOWLEDGE_MANAGEMENT');
  const kmOwner = Array.from(items.values()).find((item) => (item.aliases || []).includes('KM'));

  if (!knowledgeManagement) {
    errors.push(`${label}: KNOWLEDGE_MANAGEMENT entry is missing.`);
  }

  if (!kmOwner || kmOwner.code !== 'KNOWLEDGE_MANAGEMENT') {
    errors.push(`${label}: KM must only be an alias of KNOWLEDGE_MANAGEMENT.`);
  }
}

function main() {
  const errors = [];
  const frontend = readJson(frontendTaxonomyPath, 'frontend taxonomy', errors);
  const backend = readJson(backendTaxonomyPath, 'backend taxonomy', errors);

  compareTaxonomies(frontend, backend, errors);

  if (errors.length > 0) {
    console.error('Offer taxonomy comparison failed.');
    errors.forEach((error) => {
      console.error(`- ${error}`);
    });
    process.exit(1);
  }

  console.log('Offer taxonomy comparison OK.');
  console.log(`Frontend items: ${frontend.items.length}`);
  console.log(`Backend items: ${backend.items.length}`);
  console.log(`Items matched: ${frontend.items.length}`);
}

main();
