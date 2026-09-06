const M3S_NETLIFY_PREVIEW_ORIGIN =
  /^https:\/\/deploy-preview-\d+--m3s-frontend-v2\.netlify\.app$/;
const CORS_ORIGIN_REJECTED = 'CORS_ORIGIN_REJECTED';

const createCorsOriginValidator = (allowedOrigins) => (
  origin,
  callback
) => {
  const isAllowed =
    !origin ||
    allowedOrigins.includes(origin) ||
    M3S_NETLIFY_PREVIEW_ORIGIN.test(origin);

  if (isAllowed) return callback(null, true);
  const error = new Error('Origin not allowed by CORS');
  error.code = CORS_ORIGIN_REJECTED;
  error.status = 403;
  return callback(error, false);
};

const createCorsErrorHandler = () => (error, _req, res, next) => {
  if (error?.code !== CORS_ORIGIN_REJECTED) return next(error);
  return res.status(error.status).json({
    success: false,
    code: CORS_ORIGIN_REJECTED,
    error: 'Origin not allowed by CORS'
  });
};

module.exports = {
  M3S_NETLIFY_PREVIEW_ORIGIN,
  CORS_ORIGIN_REJECTED,
  createCorsOriginValidator,
  createCorsErrorHandler
};
