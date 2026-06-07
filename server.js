// ============================================================================
// API ROUTES - USERS (RH) - FIXED VERSION
// ============================================================================

app.get('/api/users', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT
        user_id as id,
        username,
        full_name,
        email_pro,
        email_perso,
        telephone as phone,
        poste as position,
        role,
        team,
        active,
        last_login,
        created_at,
        updated_at
      FROM \`${PROJECT_ID}.${DATASET_ID}.utilisateurs\`
      WHERE user_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const options = { query, location: DATASET_LOCATION };
    const [rows] = await bigquery.query(options);

    console.log(`✅ Users returned: ${rows.length} rows`);

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Users Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});