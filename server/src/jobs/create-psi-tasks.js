import { supabaseAdmin } from '../db.js';
import { RYTSENSE_ORG, RYTSENSE_SITE } from '../scope.js';

async function notifySlack(channel, message) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: message,
        channel,
      }),
    });
  } catch (err) {
    console.error('Slack notification failed:', err.message);
  }
}

export async function createPSITasks(orgId = RYTSENSE_ORG, siteId = RYTSENSE_SITE) {
  const db = supabaseAdmin();
  if (!db) throw new Error('Database not configured');
  
  const startTime = Date.now();
  let tasksCreated = 0;
  
  try {
    console.log(`[PSI Tasks] Starting for org=${orgId}, site=${siteId}`);
    
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
    
    // Find critical/high issues without tasks, not yet reviewed
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const { data: issues, error: issuesError } = await db
      .from('psi_issues')
      .select(
        `
        id, 
        title, 
        severity, 
        impact_score, 
        psi_scores(page_url),
        task_id
      `
      )
      .eq('organization_id', orgId)
      .eq('site_id', siteId)
      .in('severity', ['critical', 'high'])
      .is('task_id', null)
      .or(`reviewed_at.is.null,reviewed_at.gt.${oneWeekAgo.toISOString()}`)
      .limit(50);
    
    if (issuesError) {
      throw issuesError;
    }
    
    console.log(`[PSI Tasks] Found ${issues?.length || 0} issues to convert to tasks`);
    
    for (const issue of issues || []) {
      try {
        const pageUrl = issue.psi_scores?.[0]?.page_url || 'unknown';
        const priority = issue.severity === 'critical' ? 'critical' : 'high';
        
        const taskTitle = `[PSI] ${pageUrl}: ${issue.title}`;
        const taskDescription = `Page Speed Issue detected:\n\n**${issue.title}**\n\nSeverity: ${issue.severity}\nImpact Score: ${issue.impact_score}/100\n\nReview and fix as part of performance optimization work.`;
        
        // Check if task already exists (duplicate prevention)
        const { data: existingTask } = await db
          .from('tasks')
          .select('id')
          .eq('organization_id', orgId)
          .eq('site_id', siteId)
          .eq('title', taskTitle)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        
        if (existingTask) {
          console.log(`[PSI Tasks] Task already exists for: ${taskTitle}`);
          // Link the issue to existing task
          await db
            .from('psi_issues')
            .update({ task_id: existingTask.id, reviewed_at: new Date().toISOString() })
            .eq('id', issue.id);
          continue;
        }
        
        // Create new task
        const { data: task, error: taskError } = await db
          .from('tasks')
          .insert({
            organization_id: orgId,
            site_id: siteId,
            title: taskTitle,
            description: taskDescription,
            status: 'open',
            priority,
            assigned_to_role: 'dev',
            assignee_id: null, // Dev can self-assign or admin assigns
          })
          .select('id')
          .single();
        
        if (taskError) {
          console.error(`[PSI Tasks] Task creation failed:`, taskError);
          continue;
        }
        
        // Link task to issue
        const { error: linkError } = await db
          .from('psi_issues')
          .update({
            task_id: task.id,
            reviewed_at: new Date().toISOString(),
          })
          .eq('id', issue.id);
        
        if (linkError) {
          console.error(`[PSI Tasks] Issue link failed:`, linkError);
        } else {
          tasksCreated++;
          
          // Notify Slack
          await notifySlack(
            process.env.SLACK_DEV_CHANNEL || '#dev-alerts',
            `:zap: PSI Task Created\n*${pageUrl}*\n${issue.title}\nSeverity: ${issue.severity}\nTask ID: ${task.id}`
          );
        }
      } catch (err) {
        console.error(`[PSI Tasks] Error processing issue ${issue.id}:`, err.message);
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[PSI Tasks] Complete: ${tasksCreated} tasks created in ${duration}s`);
    
    return { tasksCreated };
  } catch (err) {
    console.error('[PSI Tasks] Fatal error:', err);
    throw err;
  }
}
