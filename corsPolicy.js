const M3S_NETLIFY_PREVIEW_ORIGIN =
  /^https:\/\/deploy-preview-\d+--m3s-frontend-v2\.netlify\.app$/;

const createCorsOriginValidator = (allowedOrigins) => (
  origin,
  callback
) => {
  const isAllowed =
    !origin ||
    allowedOrigins.includes(origin) ||
    M3S_NETLIFY_PREVIEW_ORIGIN.test(origin);

  callback(
    isAllowed ? null : new Error(`Origin not allowed by CORS: ${origin}`),
    isAllowed
  );
};

module.exports = {
  M3S_NETLIFY_PREVIEW_ORIGIN,
  createCorsOriginValidator
};
