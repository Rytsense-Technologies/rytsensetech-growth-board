import express from 'express';
import { assertSameOrg } from '../scope.js';

const router = express.Router();

// GET /api/psi/scores - List PSI scores for a site
router.get('/psi/scores', async (req, res) => {
  const db = req.db;
  const actor = req.actor;
  
  const siteId = req.query.site_id;
  const days = parseInt(req.query.days || '28', 10);
  
  if (!siteId) {
    return res.status(400).json({ error: 'site_id required' });
  }
  
  if (!actor) {
    return res.status(401).json({ error: 'login required' });
  }
  
  try {
    // Verify site access
    const { data: site } = await db
      .from('sites')
      .select('organization_id')
      .eq('id', siteId)
      .maybeSingle();
    
    if (!site) {
      return res.status(404).json({ error: 'site not found' });
    }
    
    assertSameOrg(site.organization_id, req.userOrgId);
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const { data, error } = await db
      .from('psi_scores')
      .select(
        `
        id,
        page_url,
        metric_date,
        desktop_score,
        mobile_score,
        lcp_desktop,
        lcp_mobile,
        fcp_desktop,
        fcp_mobile,
        cls_desktop,
        cls_mobile,
        ttfb_desktop,
        ttfb_mobile,
        psi_issues(
          id,
          severity,
          title,
          impact_score,
          task_id
        )
      `
      )
      .eq('site_id', siteId)
      .gte('metric_date', startDate.toISOString().split('T')[0])
      .order('metric_date', { ascending: false });
    
    if (error) {
      console.error('PSI scores query error:', error);
      return res.status(500).json({ error: 'query failed' });
    }
    
    // Calculate summary stats
    const allScores = data || [];
    const mobileScores = allScores
      .map((d) => d.mobile_score)
      .filter((s) => s !== null);
    const desktopScores = allScores
      .map((d) => d.desktop_score)
      .filter((s) => s !== null);
    
    const avgMobileScore = mobileScores.length
      ? (mobileScores.reduce((a, b) => a + b, 0) / mobileScores.length).toFixed(0)
      : null;
    
    const avgDesktopScore = desktopScores.length
      ? (desktopScores.reduce((a, b) => a + b, 0) / desktopScores.length).toFixed(0)
      : null;
    
    const criticalCount = allScores.reduce(
      (acc, score) =>
        acc +
        (score.psi_issues || []).filter((issue) => issue.severity === 'critical')
          .length,
      0
    );
    
    const highCount = allScores.reduce(
      (acc, score) =>
        acc + (score.psi_issues || []).filter((issue) => issue.severity === 'high')
          .length,
      0
    );
    
    res.json({
      summary: {
        avg_mobile_score: avgMobileScore,
        avg_desktop_score: avgDesktopScore,
        critical_issues: criticalCount,
        high_issues: highCount,
        pages_scanned: new Set(allScores.map((d) => d.page_url)).size,
      },
      scores: allScores,
    });
  } catch (err) {
    console.error('PSI scores error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

// GET /api/psi/issues - List PSI issues with optional filters
router.get('/psi/issues', async (req, res) => {
  const db = req.db;
  const actor = req.actor;
  
  const siteId = req.query.site_id;
  const severity = (req.query.severity || 'critical,high').split(',');
  
  if (!siteId) {
    return res.status(400).json({ error: 'site_id required' });
  }
  
  if (!actor) {
    return res.status(401).json({ error: 'login required' });
  }
  
  try {
    // Verify site access
    const { data: site } = await db
      .from('sites')
      .select('organization_id')
      .eq('id', siteId)
      .maybeSingle();
    
    if (!site) {
      return res.status(404).json({ error: 'site not found' });
    }
    
    assertSameOrg(site.organization_id, req.userOrgId);
    
    let query = db
      .from('psi_issues')
      .select(
        `
        id,
        title,
        severity,
        impact_score,
        category,
        psi_scores(page_url, metric_date),
        tasks(id, status, assignee_id)
      `
      )
      .eq('site_id', siteId)
      .in('severity', severity);
    
    if (req.query.category) {
      query = query.eq('category', req.query.category);
    }
    
    if (req.query.has_task === 'true') {
      query = query.not('task_id', 'is', null);
    } else if (req.query.has_task === 'false') {
      query = query.is('task_id', null);
    }
    
    const { data, error } = await query
      .order('impact_score', { ascending: false })
      .limit(100);
    
    if (error) {
      console.error('PSI issues query error:', error);
      return res.status(500).json({ error: 'query failed' });
    }
    
    res.json({ issues: data || [] });
  } catch (err) {
    console.error('PSI issues error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

export default router;
