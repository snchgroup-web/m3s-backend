const fs = require('fs/promises');
const path = require('path');

const BOUSSOLE_ARTIFACT_PATH = path.join(
  __dirname,
  'artifacts',
  'M3S_BOUSSOLE_TRILINGUE_V3_1_2026-09-13.html'
);

const loadBoussoleArtifact = async (readFile = fs.readFile) => {
  const content = await readFile(BOUSSOLE_ARTIFACT_PATH, 'utf8');
  if (!/<html[\s>]/i.test(content) || !content.includes('Boussole')) {
    const error = new Error('Boussole artifact is invalid');
    error.code = 'BOUSSOLE_ARTIFACT_INVALID';
    throw error;
  }
  return content;
};

const createBoussoleArtifactHandler = ({
  loadArtifact = loadBoussoleArtifact,
  logError = (message) => console.error('Boussole artifact error:', message)
} = {}) => async (req, res) => {
  try {
    const content = await loadArtifact();
    res
      .type('html')
      .set('Cache-Control', 'private, no-store')
      .set('Content-Disposition', 'inline; filename="M3S_Boussole_V3_1.html"')
      .set('X-Content-Type-Options', 'nosniff');
    return res.send(content);
  } catch (error) {
    logError(error.message);
    return res.status(500).json({ success: false, error: 'Boussole indisponible' });
  }
};

module.exports = {
  BOUSSOLE_ARTIFACT_PATH,
  createBoussoleArtifactHandler,
  loadBoussoleArtifact
};
