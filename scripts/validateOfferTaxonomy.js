const fs = require('fs');
const path = require('path');

const taxonomyPath = path.join(__dirname, '..', 'referentiels', 'offerTaxonomy.json');

const EXPECTED_ITEM_COUNT = 19;
const REQUIRED_ROOT_FIELDS = ['version', 'validated_at', 'items'];
const REQUIRED_ITEM_FIELDS = [
  'code',
  'das_strategique',
  'famille_offre',
  'sous_famille_offre',
  'type_offre',
  'scope',
  'category',
  'active',
];
const REQUIRED_STRING_ITEM_FIELDS = REQUIRED_ITEM_FIELDS.filter((field) => field !== 'active');

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function loadTaxonomy(errors) {
  let raw;

  try {
    raw = fs.readFileSync(taxonomyPath, 'utf8');
  } catch (error) {
    errors.push(`Cannot read taxonomy JSON at ${taxonomyPath}: ${error.message}`);
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    errors.push(`Invalid JSON syntax in ${taxonomyPath}: ${error.message}`);
    return null;
  }
}

function validateRoot(taxonomy, errors) {
  if (!taxonomy || typeof taxonomy !== 'object' || Array.isArray(taxonomy)) {
    errors.push('Taxonomy root must be an object.');
    return false;
  }

  REQUIRED_ROOT_FIELDS.forEach((field) => {
    if (!hasOwn(taxonomy, field)) {
      errors.push(`Missing root field: ${field}`);
    }
  });

  if (hasOwn(taxonomy, 'version') && !isNonEmptyString(taxonomy.version)) {
    errors.push('Root field version must be a non-empty string.');
  }

  if (hasOwn(taxonomy, 'validated_at') && !isNonEmptyString(taxonomy.validated_at)) {
    errors.push('Root field validated_at must be a non-empty string.');
  }

  if (!hasOwn(taxonomy, 'items')) {
    return false;
  }

  if (!Array.isArray(taxonomy.items)) {
    errors.push('Root field items must be an array.');
    return false;
  }

  if (taxonomy.items.length !== EXPECTED_ITEM_COUNT) {
    errors.push(`Root field items must contain ${EXPECTED_ITEM_COUNT} entries, got ${taxonomy.items.length}.`);
  }

  return true;
}

function validateItems(items, errors) {
  if (!Array.isArray(items)) {
    return;
  }

  const codes = new Set();
  const duplicateCodes = new Set();
  const aliasOwners = new Map();
  const duplicateAliases = new Set();

  items.forEach((item, index) => {
    const label = isNonEmptyString(item && item.code) ? item.code : `item[${index}]`;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`item[${index}] must be an object.`);
      return;
    }

    REQUIRED_ITEM_FIELDS.forEach((field) => {
      if (!hasOwn(item, field)) {
        errors.push(`${label}: missing required field ${field}`);
      }
    });

    REQUIRED_STRING_ITEM_FIELDS.forEach((field) => {
      if (hasOwn(item, field) && !isNonEmptyString(item[field])) {
        errors.push(`${label}: ${field} must be a non-empty string.`);
      }
    });

    if (hasOwn(item, 'active') && typeof item.active !== 'boolean') {
      errors.push(`${label}: active must be a boolean.`);
    }

    if (isNonEmptyString(item.code)) {
      if (codes.has(item.code)) {
        duplicateCodes.add(item.code);
      } else {
        codes.add(item.code);
      }
    }

    if (hasOwn(item, 'aliases')) {
      if (!Array.isArray(item.aliases)) {
        errors.push(`${label}: aliases must be an array.`);
      } else {
        item.aliases.forEach((alias) => {
          if (!isNonEmptyString(alias)) {
            errors.push(`${label}: aliases must contain only non-empty strings.`);
            return;
          }

          if (aliasOwners.has(alias)) {
            duplicateAliases.add(alias);
          } else {
            aliasOwners.set(alias, item.code);
          }
        });
      }
    }
  });

  duplicateCodes.forEach((code) => {
    errors.push(`Duplicate code: ${code}`);
  });

  duplicateAliases.forEach((alias) => {
    errors.push(`Duplicate alias: ${alias}`);
  });

  aliasOwners.forEach((owner, alias) => {
    if (codes.has(alias)) {
      errors.push(`Alias must not also be a standalone entry: ${alias}`);
    }
  });

  if (codes.has('KM')) {
    errors.push('KM must not be a standalone entry.');
  }

  if (codes.has('IA')) {
    errors.push('IA must not be a standalone entry.');
  }

  if (aliasOwners.get('KM') !== 'KNOWLEDGE_MANAGEMENT') {
    errors.push('KM must only be an alias of KNOWLEDGE_MANAGEMENT.');
  }
}

function main() {
  const errors = [];
  const taxonomy = loadTaxonomy(errors);

  if (taxonomy !== null) {
    const rootIsValid = validateRoot(taxonomy, errors);
    if (rootIsValid) {
      validateItems(taxonomy.items, errors);
    }
  } else if (errors.length === 0) {
    errors.push('Taxonomy root must be an object.');
  }

  if (errors.length > 0) {
    console.error('Backend offer taxonomy validation failed.');
    errors.forEach((error) => {
      console.error(`- ${error}`);
    });
    process.exit(1);
  }

  console.log('Backend offer taxonomy validation OK.');
  console.log(`Items checked: ${taxonomy.items.length}`);
}

main();
