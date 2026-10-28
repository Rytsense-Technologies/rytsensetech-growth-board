-- Page Speed Index (PSI) tracking
-- Stores PSI scores and issues for all pages across organizations

CREATE TABLE IF NOT EXISTS psi_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL,
  metric_date DATE NOT NULL,
  
  -- Core Web Vitals + overall scores
  desktop_score INT, -- 0-100
  mobile_score INT,  -- 0-100
  
  -- Largest Contentful Paint (seconds)
  lcp_desktop NUMERIC,
  lcp_mobile NUMERIC,
  
  -- First Contentful Paint (seconds)
  fcp_desktop NUMERIC,
  fcp_mobile NUMERIC,
  
  -- Cumulative Layout Shift
  cls_desktop NUMERIC,
  cls_mobile NUMERIC,
  
  -- Time to First Byte (seconds)
  ttfb_desktop NUMERIC,
  ttfb_mobile NUMERIC,
  
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  
  UNIQUE(organization_id, site_id, page_url, metric_date)
);

CREATE TABLE IF NOT EXISTS psi_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  psi_score_id UUID NOT NULL REFERENCES psi_scores(id) ON DELETE CASCADE,
  
  -- Issue metadata from PSI API
  issue_type TEXT NOT NULL, -- 'error', 'warning', 'opportunity'
  severity TEXT NOT NULL, -- 'critical', 'high', 'medium', 'low'
  title TEXT NOT NULL,
  description TEXT,
  impact_score INT, -- 0-100 (custom weighted score)
  estimated_savings TEXT, -- "Potential time saving: 5s", "Potential bytes saved: 2.5 KB"
  category TEXT, -- 'performance', 'accessibility', 'best-practices', 'seo'
  
  -- Task linking (created when severity >= high and not yet reviewed)
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT now(),
  
  UNIQUE(organization_id, site_id, psi_score_id, title)
);

-- RLS Policies
ALTER TABLE psi_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE psi_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY psi_scores_read ON psi_scores FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM members WHERE user_id = auth.uid()
  ));

CREATE POLICY psi_scores_write ON psi_scores FOR INSERT
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM members WHERE user_id = auth.uid() AND role = 'admin'
  ));

CREATE POLICY psi_issues_read ON psi_issues FOR SELECT
  USING (organization_id IN (
    SELECT organization_id FROM members WHERE user_id = auth.uid()
  ));

CREATE POLICY psi_issues_write ON psi_issues FOR INSERT
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM members WHERE user_id = auth.uid() AND role = 'admin'
  ));

-- Indexes for performance
CREATE INDEX idx_psi_scores_org_site_date ON psi_scores(organization_id, site_id, metric_date DESC);
CREATE INDEX idx_psi_scores_page_date ON psi_scores(page_url, metric_date DESC);
CREATE INDEX idx_psi_issues_org_severity ON psi_issues(organization_id, severity);
CREATE INDEX idx_psi_issues_task_id ON psi_issues(task_id);
