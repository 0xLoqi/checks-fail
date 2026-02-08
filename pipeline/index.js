import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DATA_PATH = join(DATA_DIR, 'articles.json');
const FEEDS = JSON.parse(readFileSync(join(__dirname, 'feeds.json'), 'utf-8'));

const KEYWORDS = [
  'election', 'voting', 'ballot', 'voter', 'midterm', 'poll worker',
  'DOJ', 'department of justice', 'attorney general', 'bondi', 'prosecutor',
  'FBI', 'patel', 'kash', 'search warrant', 'raid',
  'DOGE', 'musk', 'department of government efficiency',
  'immigration', 'ICE', 'homan', 'deportation', 'detained', 'border czar',
  'schedule f', 'civil service', 'federal workers', 'federal employees',
  'project 2025', 'heritage foundation', 'project 2026',
  'congressional oversight', 'subpoena', 'impeach', 'oversight hearing',
  'gabbard', 'intelligence', 'DNI', 'national intelligence',
  'fulton county', 'georgia election',
  'miller', 'white house', 'executive order',
  'johnson', 'speaker', 'house majority',
  'court order', 'judicial', 'unconstitutional', 'ruling',
  'MEGA act', 'election administration', 'mail-in voting',
  'CISA', 'election security', 'cybersecurity',
  'USAID', 'foreign aid',
  'classified', 'executive privilege',
  'trump', 'vought', 'roberts kevin',
  'democracy', 'authoritarian', 'checks and balances',
];

const SIGNIFICANCE_THRESHOLD = 7;
const BREAKING_THRESHOLD = 9;

// ── Helpers ──

function articleId(url) {
  return createHash('md5').update(url).digest('hex').slice(0, 12);
}

function matchesKeywords(text) {
  const lower = text.toLowerCase();
  return KEYWORDS.filter(k => lower.includes(k.toLowerCase()));
}

function loadData() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(DATA_PATH)) {
    return JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
  }
  return { articles: [], lastDigest: null, lastFetch: null };
}

function saveData(data) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// ── Step 1: Fetch RSS feeds ──

async function fetchFeeds() {
  const parser = new Parser({ timeout: 10000 });
  const allArticles = [];

  for (const feed of FEEDS) {
    try {
      const result = await parser.parseURL(feed.url);
      for (const item of result.items.slice(0, 20)) {
        if (!item.link) continue;
        const text = `${item.title || ''} ${item.contentSnippet || ''}`;
        const keywords = matchesKeywords(text);
        if (keywords.length > 0) {
          allArticles.push({
            id: articleId(item.link),
            title: item.title,
            url: item.link,
            source: feed.name,
            published: item.isoDate || item.pubDate || null,
            description: (item.contentSnippet || '').slice(0, 500),
            keywords,
          });
        }
      }
    } catch (e) {
      console.error(`[WARN] ${feed.name}: ${e.message}`);
    }
  }

  return allArticles;
}

// ── Step 2: Score significance with Claude Haiku ──

async function scoreArticles(articles) {
  const client = new Anthropic();
  const scored = [];

  // Process in batches of 5 to respect rate limits
  for (let i = 0; i < articles.length; i += 5) {
    const batch = articles.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (article) => {
      try {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Rate this article's significance to U.S. democratic checks and balances (1-10).

We track: DOJ independence, FBI independence, intelligence community integrity, civil service independence, election infrastructure, congressional oversight, judicial independence.

Scale:
1-3: Routine news, opinion, commentary
4-6: Notable but not urgent
7-8: Significant (major ruling, policy change, institutional action)
9-10: Critical (unprecedented action, major erosion of democratic checks)

Title: "${article.title}"
Source: ${article.source}
Summary: ${article.description}

Respond ONLY with valid JSON: {"score": N, "reason": "one sentence", "categories": ["check-name"]}`
          }]
        });

        const text = response.content[0].text.trim();
        const parsed = JSON.parse(text);
        return {
          ...article,
          significance: parsed.score,
          reason: parsed.reason,
          categories: parsed.categories,
          scoredAt: new Date().toISOString(),
        };
      } catch (e) {
        console.error(`[WARN] Score failed: "${article.title}" — ${e.message}`);
        return {
          ...article,
          significance: 5,
          reason: 'Scoring failed',
          categories: [],
          scoredAt: new Date().toISOString(),
        };
      }
    }));

    scored.push(...results);
  }

  return scored;
}

// ── Step 3: Synthesize digest with Claude Sonnet ──

async function synthesizeDigest(articles, dashboardState) {
  const client = new Anthropic();

  const summaries = articles
    .sort((a, b) => b.significance - a.significance)
    .slice(0, 15)
    .map(a => `- [${a.significance}/10] "${a.title}" (${a.source}, ${a.url}) — ${a.reason}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are the editor of checks.fail — a status page tracking U.S. democratic checks and balances like server monitoring infrastructure.

Write a weekly digest post for the checks.fail Substack.

Tone: direct, factual. The dark humor comes naturally from the server-status metaphor. Not preachy, not partisan — just sourced facts. Every claim links to its source.

This week's significant developments (scored by significance):
${summaries}

Current dashboard state:
${dashboardState}

Write the email with this structure:
1. First line must be: Subject: <compelling subject, under 60 chars>
2. Opening: 1-2 sentence system status summary
3. Key developments: 3-5 bullet points, each with a [source](url) link
4. Dashboard updates: what status changed (if anything)
5. Upcoming: 1-2 things to watch
6. Sign-off: brief, matches the checks.fail voice

Format as markdown. Keep it under 500 words total. No emoji.`
    }]
  });

  return response.content[0].text;
}

// ── Step 4: Save digest to file (for posting to Substack) ──

function saveDigest(markdown) {
  const DIGEST_DIR = join(__dirname, '..', 'digests');
  if (!existsSync(DIGEST_DIR)) mkdirSync(DIGEST_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}.md`;
  const filepath = join(DIGEST_DIR, filename);

  writeFileSync(filepath, markdown);
  return { filepath, filename };
}

// ── Main ──

const mode = process.argv[2] || 'fetch';

if (mode === 'fetch') {
  console.log('=== checks.fail pipeline: FETCH ===');
  console.log(`Fetching ${FEEDS.length} RSS feeds...`);

  const raw = await fetchFeeds();
  console.log(`Found ${raw.length} keyword-matched articles.`);

  const data = loadData();
  const existingIds = new Set(data.articles.map(a => a.id));
  const newArticles = raw.filter(a => !existingIds.has(a.id));

  if (newArticles.length === 0) {
    console.log('No new articles. Done.');
    process.exit(0);
  }

  console.log(`${newArticles.length} new articles. Scoring with Claude Haiku...`);
  const scored = await scoreArticles(newArticles);

  data.articles.push(...scored);
  data.lastFetch = new Date().toISOString();

  // Prune: keep only last 30 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  data.articles = data.articles.filter(a =>
    new Date(a.published || a.scoredAt) > cutoff
  );

  saveData(data);

  // Report
  const significant = scored.filter(a => a.significance >= SIGNIFICANCE_THRESHOLD);
  const breaking = scored.filter(a => a.significance >= BREAKING_THRESHOLD);

  console.log(`Stored: ${scored.length} | Significant (7+): ${significant.length} | Breaking (9+): ${breaking.length}`);

  if (breaking.length > 0) {
    console.log('\n!!! BREAKING ALERTS !!!');
    breaking.forEach(a => console.log(`  [${a.significance}] ${a.title} (${a.source})`));

    // Signal to GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, 'breaking=true\n');
    }
  }

} else if (mode === 'digest') {
  console.log('=== checks.fail pipeline: DIGEST ===');

  const data = loadData();
  const since = data.lastDigest ? new Date(data.lastDigest) : new Date(0);
  const recent = data.articles.filter(a =>
    new Date(a.scoredAt || a.published) > since &&
    a.significance >= SIGNIFICANCE_THRESHOLD
  );

  if (recent.length === 0) {
    console.log('No significant articles since last digest. Skipping.');
    process.exit(0);
  }

  const dashboardState = [
    '9 of 12 checks FAILED.',
    'DOJ Independence: COMPROMISED — AG takes prosecution orders via DM. Public Integrity Section gutted.',
    'FBI Independence: COMPROMISED — Political purges, director admits illegality.',
    'Intelligence Community: COMPROMISED — Election security center dissolved.',
    'Civil Service: COMPROMISED — Schedule F finalized Feb 2026, 50K workers reclassified.',
    'Election Infrastructure: AT RISK — Fulton County raid, MEGA Act introduced.',
    'Congressional Oversight: DEGRADED — Speaker abdicated oversight role.',
    'Judicial Independence: STRAINED — Courts rule against admin, enforcement uneven. Court orders defied in 1/3 of immigration cases.',
    'Political Retribution: WEAPONIZED — 1,500 Jan 6 pardons, 230+ DOJ purged, opponents indicted, IGs fired.',
    'Press Freedom: COMPROMISED — U.S. 57th on press freedom index. Public media defunded. Pentagon press exodus.',
    'Immigration & Civil Rights: COMPROMISED — 170+ citizens detained, 31 detention deaths, 85K visas revoked, courts defied.',
    'Corruption & Self-Dealing: UNPRECEDENTED — $500M crypto profits, $400M Qatar jet, Public Integrity gutted.',
    'Federal Programs: GUTTED — USAID closed, CFPB halted, $911B Medicaid cut, EPA lost 33% of staff.',
  ].join(' ');

  console.log(`Synthesizing ${recent.length} significant articles into digest...`);
  const digest = await synthesizeDigest(recent, dashboardState);

  console.log('\n--- DIGEST PREVIEW ---');
  console.log(digest);
  console.log('--- END PREVIEW ---\n');

  const result = saveDigest(digest);

  data.lastDigest = new Date().toISOString();
  recent.forEach(a => { a.digestedAt = data.lastDigest; });
  saveData(data);

  console.log(`Saved to: ${result.filepath}`);
  console.log('Ready to paste into Substack and publish.');

} else {
  console.error(`Unknown mode: "${mode}". Use 'fetch' or 'digest'.`);
  process.exit(1);
}
