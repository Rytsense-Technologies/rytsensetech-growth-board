import { supabaseAdmin } from '../db.js';
import { RYTSENSE_ORG, RYTSENSE_SITE } from '../scope.js';

const PSI_API_KEY = process.env.GOOGLE_PAGESPEED_API_KEY;
const PSI_BATCH_SIZE = 10; // Conservative rate limiting

async function fetchPSI(url, strategy = 'mobile') {
  if (!PSI_API_KEY) {
    throw new Error('GOOGLE_PAGESPEED_API_KEY not configured');
  }
  
  const params = new URLSearchParams({
    url,
    strategy,
    key: PSI_API_KEY,
  });
  
  const response = await fetch(`https://pagespeedonline.googleapis.com/pagereight/v5/runPagespeed?${params}`);
  if (!response.ok) {
    throw new Error(`PSI API error: ${response.status}`);
  }
  return response.json();
}

function extractMetrics(data, strategy) {
  const lighthouseResult = data.lighthouseResult || {};
  const audits = lighthouseResult.audits || {};
  
  return {
    score: lighthouseResult.score ? Math.round(lighthouseResult.score * 100) : null,
    lcp: audits['largest-contentful-paint']?.numericValue / 1000, // ms to s
    fcp: audits['first-contentful-paint']?.numericValue / 1000,
    cls: audits['cumulative-layout-shift']?.numericValue,
    ttfb: audits['server-response-time']?.numericValue / 1000,
  };
}

function extractIssues(data, strategy) {
  const lighthouseResult = data.lighthouseResult || {};
  const audits = lighthouseResult.audits || {};
  const issues = [];
  
  for (const [auditId, audit] of Object.entries(audits)) {
    const score = audit.score;
    let severity = 'low';
    
    // Determine severity from score + impact
    if (score !== null) {
      if (score < 0.25) severity = 'critical';
      else if (score < 0.5) severity = 'high';
      else if (score < 0.75) severity = 'medium';
      else severity = 'low';
    }
    
    // Skip opportunities and low-severity items
    if (audit.scoreDisplayMode === 'notApplicable' || severity === 'low') {
      continue;
    }
    
    const impactScore = Math.max(0, Math.round((1 - (score || 0)) * 100));
    
    issues.push({
      issue_type: audit.scoreDisplayMode === 'error' ? 'error' : 'warning',
      severity,
      title: audit.title,
      description: audit.description,
      impact_score: impactScore,
      estimated_savings: audit.displayValue || null,
      category: audit.categories?.[0] || 'performance',
    });
  }
  
  return issues;
}

async function getTopPages(db, siteId) {
  // Get top 25 pages by impressions from GSC in last 28 days
  const { data, error } = await db
    .from('search_pages')
    .select('url')
    .eq('site_id', siteId)
    .order('impressions', { ascending: false })
    .limit(25);
  
  if (error) {
    console.error('Failed to fetch top pages:', error);
    // Fallback: scan homepage + /blog + /services
    return ['/', '/blog', '/services', '/about', '/contact'];
  }
  
  return (data || []).map((p) => p.url);
}

export async function runPSISync(orgId = RYTSENSE_ORG, siteId = RYTSENSE_SITE) {
  const db = supabaseAdmin();
  if (!db) throw new Error('Database not configured');
  
  const startTime = Date.now();
  let syncedPages = 0;
  let syncedIssues = 0;
  let errors = 0;
  
  try {
    console.log(`[PSI Sync] Starting for org=${orgId}, site=${siteId}`);
    
    // Get site info
    const { data: site, error: siteError } = await db
      .from('sites')
      .select('id, domain')
      .eq('id', siteId)
      .eq('organization_id', orgId)
      .maybeSingle();
    
    if (siteError || !site) {
      throw new Error(`Site not found: ${siteId}`);
    }
    
    // Get pages to check
    const pages = await getTopPages(db, siteId);
    console.log(`[PSI Sync] Scanning ${pages.length} pages`);
    
    const metricDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Batch process pages
    for (let i = 0; i < pages.length; i += PSI_BATCH_SIZE) {
      const batch = pages.slice(i, i + PSI_BATCH_SIZE);
      
      for (const pageUrl of batch) {
        try {
          const fullUrl = `https://${site.domain}${pageUrl}`;
          console.log(`[PSI Sync] Fetching ${fullUrl}`);
          
          // Fetch PSI for both mobile and desktop
          const [mobileData, desktopData] = await Promise.all([
            fetchPSI(fullUrl, 'mobile'),
            fetchPSI(fullUrl, 'desktop'),
          ]);
          
          const mobileMetrics = extractMetrics(mobileData, 'mobile');
          const desktopMetrics = extractMetrics(desktopData, 'desktop');
          
          // Insert or update score
          const { data: scoreData, error: scoreError } = await db
            .from('psi_scores')
            .upsert({
              organization_id: orgId,
              site_id: siteId,
              page_url: pageUrl,
              metric_date: metricDate,
              mobile_score: mobileMetrics.score,
              desktop_score: desktopMetrics.score,
              lcp_mobile: mobileMetrics.lcp,
              lcp_desktop: desktopMetrics.lcp,
              fcp_mobile: mobileMetrics.fcp,
              fcp_desktop: desktopMetrics.fcp,
              cls_mobile: mobileMetrics.cls,
              cls_desktop: desktopMetrics.cls,
              ttfb_mobile: mobileMetrics.ttfb,
              ttfb_desktop: desktopMetrics.ttfb,
            }, { onConflict: 'organization_id,site_id,page_url,metric_date' })
            .select('id')
            .single();
          
          if (scoreError) throw scoreError;
          
          syncedPages++;
          
          // Extract and insert issues
          const mobileIssues = extractIssues(mobileData, 'mobile');
          const desktopIssues = extractIssues(desktopData, 'desktop');
          const allIssues = [...mobileIssues, ...desktopIssues];
          
          for (const issue of allIssues) {
            const { error: issueError } = await db
              .from('psi_issues')
              .insert({
                organization_id: orgId,
                site_id: siteId,
                psi_score_id: scoreData.id,
                ...issue,
              })
              .select();
            
            if (issueError && !issueError.message.includes('duplicate')) {
              console.error('Issue insert error:', issueError);
            } else if (!issueError) {
              syncedIssues++;
            }
          }
          
          // Rate limit: 25 requests per 100 seconds free tier
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (err) {
          console.error(`[PSI Sync] Error on ${pageUrl}:`, err.message);
          errors++;
        }
      }
      
      // Batch delay
      if (i + PSI_BATCH_SIZE < pages.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    
    // Update connection status
    await db
      .from('connections')
      .update({
        last_sync_at: new Date().toISOString(),
        sync_status: 'success',
      })
      .eq('organization_id', orgId)
      .eq('site_id', siteId)
      .eq('source', 'psi');
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[PSI Sync] Complete: ${syncedPages} pages, ${syncedIssues} issues, ${errors} errors in ${duration}s`
    );
    
    return { syncedPages, syncedIssues, errors };
  } catch (err) {
    console.error('[PSI Sync] Fatal error:', err);
    
    // Mark sync as failed
    await db
      .from('connections')
      .update({
        sync_status: 'error',
        error_message: err.message,
      })
      .eq('organization_id', orgId)
      .eq('site_id', siteId)
      .eq('source', 'psi');
    
    throw err;
  }
}
