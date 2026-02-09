import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', 'data', 'articles.json');
const INDEX_PATH = join(__dirname, '..', 'index.html');
const LAST_UPDATE_PATH = join(__dirname, '..', 'data', 'last-site-update.json');

const SIGNIFICANCE_MIN = 7;

// ── Extract current dashboard state from index.html ──

function extractCurrentState(html) {
  const checks = [];
  const checkRegex = /<span class="chk-name">([^<]+)<\/span>\s*\n?\s*<span class="chk-status (red|amber|green)">([^<]+)<\/span>/g;
  let m;
  while ((m = checkRegex.exec(html)) !== null) {
    checks.push({ name: m[1], color: m[2], status: m[3] });
  }

  // Extract banner counts
  const bannerMatch = html.match(/(\d+)\/(\d+)<small>checks failed<\/small>/);
  const failedCount = bannerMatch ? parseInt(bannerMatch[1]) : null;
  const totalCount = bannerMatch ? parseInt(bannerMatch[2]) : null;

  // Extract stat chips
  const stats = [];
  const statRegex = /<span class="stat-val[^"]*">([^<]+)<\/span>\s*([^<]+)<\/span>/g;
  while ((m = statRegex.exec(html)) !== null) {
    stats.push({ value: m[1].trim(), label: m[2].trim() });
  }

  return { checks, failedCount, totalCount, stats };
}

// ── Apply updates to index.html ──

function applyUpdates(html, updates) {
  let modified = html;

  // Apply status changes
  if (updates.statusChanges && updates.statusChanges.length > 0) {
    for (const change of updates.statusChanges) {
      const oldColor = change.fromColor || 'red|amber|green';
      const pattern = new RegExp(
        `(<span class="chk-name">${escapeRegex(change.check)}<\\/span>\\s*\\n?\\s*<span class="chk-status )(${oldColor})(">)[^<]+(</span>)`
      );
      const newColor = change.toColor || (
        ['Compromised', 'Weaponized', 'Gutted', 'Unprecedented', 'Failed'].includes(change.newStatus) ? 'red' :
        ['Degraded', 'At Risk', 'Strained'].includes(change.newStatus) ? 'amber' : 'green'
      );
      modified = modified.replace(pattern, `$1${newColor}$3${change.newStatus}$4`);
    }
  }

  // Add new events to check bodies
  if (updates.newCheckEvents && updates.newCheckEvents.length > 0) {
    for (const evt of updates.newCheckEvents) {
      const evtHtml = `\n        <div class="evt"><span class="evt-d">${escapeHtml(evt.date)}</span><span class="evt-t">${evt.text}</span></div>`;
      // Insert before the closing </div> of the chk-body for the matching check
      const checkPattern = new RegExp(
        `(<span class="chk-name">${escapeRegex(evt.check)}<\\/span>[\\s\\S]*?)(\\s*<\\/div>\\s*<\\/div>\\s*\\n\\s*<div class="chk"|\\s*<\\/div>\\s*<\\/div>\\s*\\n\\s*<\\/div>\\s*\\n\\s*<!-- ═══)`
      );
      modified = modified.replace(checkPattern, `$1${evtHtml}$2`);
    }
  }

  // Add new incidents (prepend after dynamicIncidents div)
  if (updates.newIncidents && updates.newIncidents.length > 0) {
    const incidentsHtml = updates.newIncidents.map(inc => {
      const badgeClass = inc.severity === 'crit' ? 'crit' : 'warn';
      const badgeText = inc.severity === 'crit' ? 'Critical' : 'Warning';
      return `    <div class="inc">
      <div class="inc-head">
        <span class="inc-badge ${badgeClass}">${badgeText}</span>
        <span class="inc-date">${escapeHtml(inc.date)}</span>
      </div>
      <div class="inc-title">${escapeHtml(inc.title)}</div>
      <div class="inc-desc">${inc.description}</div>
    </div>`;
    }).join('\n');

    // Insert after the dynamicIncidents div and before the first hardcoded incident
    modified = modified.replace(
      '<div id="dynamicIncidents"></div>\n    <div class="inc">',
      `<div id="dynamicIncidents"></div>\n${incidentsHtml}\n    <div class="inc">`
    );
  }

  // Update banner count if needed
  if (updates.bannerUpdate) {
    modified = modified.replace(
      /(\d+)\/(\d+)<small>checks failed<\/small>/,
      `${updates.bannerUpdate.failed}/${updates.bannerUpdate.total}<small>checks failed</small>`
    );
    // Also update the banner detail text if provided
    if (updates.bannerUpdate.detail) {
      modified = modified.replace(
        /<div class="banner-detail">[^<]+<\/div>/,
        `<div class="banner-detail">${updates.bannerUpdate.detail}</div>`
      );
    }
  }

  // Update stat chips if needed
  if (updates.statUpdates && updates.statUpdates.length > 0) {
    for (const stat of updates.statUpdates) {
      const pattern = new RegExp(
        `<span class="stat-val[^"]*">${escapeRegex(stat.oldValue)}<\\/span>\\s*${escapeRegex(stat.oldLabel)}`
      );
      const cssClass = stat.class || '';
      modified = modified.replace(pattern,
        `<span class="stat-val${cssClass ? ' ' + cssClass : ''}">${stat.newValue}</span> ${stat.newLabel || stat.oldLabel}`
      );
      // Also update the duplicated marquee copy
      modified = modified.replace(pattern,
        `<span class="stat-val${cssClass ? ' ' + cssClass : ''}">${stat.newValue}</span> ${stat.newLabel || stat.oldLabel}`
      );
    }
  }

  // Update ticker items if needed
  if (updates.newTickerItems && updates.newTickerItems.length > 0) {
    const tickerHtml = updates.newTickerItems.map(t =>
      `<span class="live-ticker-item"><span class="hl">${escapeHtml(t.label)}</span> &mdash; ${t.text}</span>`
    ).join('\n        ');
    // Prepend to both halves of the ticker
    modified = modified.replace(
      '<div class="live-ticker-track">\n',
      `<div class="live-ticker-track">\n        ${tickerHtml}\n`
    );
  }

  return modified;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main ──

console.log('=== checks.fail: SITE UPDATE REVIEW ===');

// Load data
if (!existsSync(DATA_PATH)) {
  console.log('No articles.json found. Nothing to update.');
  process.exit(0);
}

const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
const html = readFileSync(INDEX_PATH, 'utf-8');
const currentState = extractCurrentState(html);

// Determine what's new since last site update
let lastUpdate = null;
if (existsSync(LAST_UPDATE_PATH)) {
  lastUpdate = JSON.parse(readFileSync(LAST_UPDATE_PATH, 'utf-8'));
}
const since = lastUpdate ? new Date(lastUpdate.timestamp) : new Date(0);

const recentArticles = data.articles
  .filter(a => {
    const d = new Date(a.scoredAt || a.published);
    return d > since && a.significance >= SIGNIFICANCE_MIN;
  })
  .sort((a, b) => b.significance - a.significance);

if (recentArticles.length === 0) {
  console.log('No significant new articles since last update. Skipping.');
  process.exit(0);
}

console.log(`Found ${recentArticles.length} significant articles since last update.`);
console.log(`Current dashboard: ${currentState.failedCount}/${currentState.totalCount} checks failed.`);
console.log(`Checks: ${currentState.checks.map(c => `${c.name}: ${c.status}`).join(', ')}`);

// Ask Claude to propose updates
const client = new Anthropic();
const articleSummaries = recentArticles.slice(0, 25).map(a =>
  `- [${a.significance}/10] "${a.title}" (${a.source}, ${a.published || a.scoredAt})\n  Categories: ${(a.categories || []).join(', ') || 'uncategorized'}\n  Reason: ${a.reason}\n  URL: ${a.url}`
).join('\n');

const currentChecksStr = currentState.checks.map(c =>
  `- ${c.name}: ${c.status} (${c.color})`
).join('\n');

const response = await client.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 4000,
  messages: [{
    role: 'user',
    content: `You are the automated update system for checks.fail, a status page monitoring U.S. democratic institutions.

CURRENT DASHBOARD STATE:
${currentChecksStr}
Banner: ${currentState.failedCount}/${currentState.totalCount} checks failed

NEW SIGNIFICANT ARTICLES (scored 7+ out of 10):
${articleSummaries}

Based on these new developments, propose updates to the dashboard. Be conservative — only propose changes when the evidence clearly warrants it.

Respond with ONLY valid JSON in this exact format:
{
  "statusChanges": [
    {"check": "Check Name", "currentStatus": "Current", "newStatus": "New", "toColor": "red|amber|green", "reason": "one sentence"}
  ],
  "newIncidents": [
    {"date": "Mon DD, YYYY", "severity": "crit|warn", "title": "Short factual headline", "description": "1-2 sentences with <a href=\\"URL\\" target=\\"_blank\\" rel=\\"noopener\\">Source</a>"}
  ],
  "newCheckEvents": [
    {"check": "Check Name", "date": "Mon YYYY", "text": "Event description with <a href=\\"URL\\" target=\\"_blank\\" rel=\\"noopener\\">Source</a>"}
  ],
  "newTickerItems": [
    {"label": "CATEGORY", "text": "Short headline with <strong>emphasis</strong> on key facts"}
  ],
  "statUpdates": [
    {"oldValue": "current value", "oldLabel": "current label", "newValue": "new value", "newLabel": "optional new label"}
  ],
  "bannerUpdate": null,
  "summary": "2-3 sentence summary of what changed and why for the PR description"
}

Rules:
- statusChanges: Only if accumulated evidence clearly shows a status has worsened or improved. This is rare.
- newIncidents: Top 3-5 most significant new developments. Must include source links. These go into the permanent incident log.
- newCheckEvents: New sourced events to add to specific check detail panels. Only for truly notable events (8+ significance).
- newTickerItems: 2-4 punchy headlines for the scrolling ticker. Keep under 80 chars.
- statUpdates: Only if a tracked number has a new confirmed value.
- bannerUpdate: Only if the number of failed/degraded checks changes. Usually null.
- summary: For the PR description. Factual, no editorializing.

If nothing warrants a change, return empty arrays and null for bannerUpdate. Do not invent or hallucinate sources — only use URLs from the articles provided.`
  }]
});

const text = response.content[0].text.trim();
let updates;
try {
  // Strip markdown code fences if present
  const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  updates = JSON.parse(jsonStr);
} catch (e) {
  console.error('Failed to parse Claude response as JSON:');
  console.error(text);
  process.exit(1);
}

console.log('\n--- PROPOSED UPDATES ---');
console.log(JSON.stringify(updates, null, 2));
console.log('--- END PROPOSED UPDATES ---\n');

// Check if there are any actual updates
const hasUpdates =
  (updates.statusChanges && updates.statusChanges.length > 0) ||
  (updates.newIncidents && updates.newIncidents.length > 0) ||
  (updates.newCheckEvents && updates.newCheckEvents.length > 0) ||
  (updates.newTickerItems && updates.newTickerItems.length > 0) ||
  (updates.statUpdates && updates.statUpdates.length > 0) ||
  updates.bannerUpdate;

if (!hasUpdates) {
  console.log('No updates proposed. Dashboard is current.');
  process.exit(0);
}

// Apply updates
const updatedHtml = applyUpdates(html, updates);
writeFileSync(INDEX_PATH, updatedHtml);

// Save the update metadata for the PR
const updateMeta = {
  timestamp: new Date().toISOString(),
  articleCount: recentArticles.length,
  updates,
};
writeFileSync(LAST_UPDATE_PATH, JSON.stringify(updateMeta, null, 2));

console.log('index.html updated successfully.');
console.log(`Summary: ${updates.summary}`);

// Write outputs for the workflow
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `has_updates=true\n`);
}

// Write PR body to file for the workflow
const prBody = `## Proposed Dashboard Updates

${updates.summary || 'Automated dashboard updates based on recent articles.'}

### Changes
${updates.statusChanges?.length ? `**Status Changes:** ${updates.statusChanges.map(c => `${c.check}: ${c.currentStatus} → ${c.newStatus}`).join(', ')}` : 'No status changes.'}
${updates.newIncidents?.length ? `**New Incidents:** ${updates.newIncidents.length} added` : ''}
${updates.newCheckEvents?.length ? `**New Check Events:** ${updates.newCheckEvents.length} added` : ''}
${updates.newTickerItems?.length ? `**New Ticker Items:** ${updates.newTickerItems.length} added` : ''}
${updates.statUpdates?.length ? `**Stat Updates:** ${updates.statUpdates.map(s => `${s.oldValue} → ${s.newValue}`).join(', ')}` : ''}

Based on **${recentArticles.length} articles** scored 7+ in significance since last update.

---

**Review the diff**, then:
- **Merge** to apply updates to the live site
- **Close** to skip this week's updates

Generated by \`pipeline/update-site.js\` using Claude Sonnet.
`;
writeFileSync(join(__dirname, '..', 'data', 'pr-body.md'), prBody);
console.log('PR body written to data/pr-body.md');
