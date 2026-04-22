#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches public job APIs where available (Greenhouse, Ashby, Lever,
 * boards.greenhouse.io, SmartRecruiters postings JSON, Workday CXS),
 * applies title filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const WEBSEARCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse (US job-boards + boards hosts)
  const ghBoardMatch = url.match(/(?:job-boards(?:\.eu)?|boards)\.greenhouse\.io\/([^/?#]+)/);
  if (ghBoardMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghBoardMatch[1]}/jobs`,
    };
  }

  // SmartRecruiters public postings API (slug from careers URL path)
  const srMatch = url.match(/careers\.smartrecruiters\.com\/([^/?#]+)/i);
  if (srMatch) {
    const slug = srMatch[1];
    return {
      type: 'smartrecruiters',
      url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`,
    };
  }

  // Workday CXS (POST JSON; no auth on public boards)
  const wd = detectWorkdayCxS(url);
  if (wd) {
    return { type: 'workday', ...wd };
  }

  return null;
}

/**
 * @param {string} careersUrl
 * @returns {{ url: string, referer: string, host: string } | null}
 */
function detectWorkdayCxS(careersUrl) {
  try {
    const u = new URL(careersUrl);
    const hostMatch = u.hostname.match(/^([^.]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
    if (!hostMatch) return null;
    const tenantSub = hostMatch[1];
    const wdPart = hostMatch[2];
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    const site = segments[segments.length - 1];
    if (!site) return null;
    const tenantPath = tenantSub.toLowerCase();
    const listUrl = `https://${tenantSub}.${wdPart}.myworkdayjobs.com/wday/cxs/${tenantPath}/${site}/jobs`;
    return {
      url: listUrl,
      referer: `${u.origin}/`,
      host: u.hostname,
    };
  } catch {
    return null;
  }
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    description: j.content || '',
    posted_at: j.updated_at || j.created_at || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    description: j.descriptionHtml || j.descriptionPlain || '',
    posted_at: j.publishedDate || j.updatedAt || j.createdAt || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    description: j.description || '',
    posted_at: j.createdAt || j.updatedAt || '',
  }));
}

function parseSmartRecruiters(json, companyName) {
  const list = Array.isArray(json.content) ? json.content : [];
  return list.map(item => ({
    title: item.name || '',
    url:
      item.jobAd?.urls?.public
      || item.jobAd?.urls?.apply
      || item.referralUrl
      || item.jobAdUrl
      || '',
    company: companyName,
    location: [item.location?.city, item.location?.country].filter(Boolean).join(', '),
    description: (
      item.jobAd?.sections?.jobDescription?.text
      || item.jobAd?.sections?.qualifications?.text
      || item.jobAd?.sections?.additionalInformation?.text
      || ''
    ),
    posted_at: item.releasedDate || item.createdOn || '',
  })).filter(j => j.title);
}

function parseWorkday(json, companyName, host) {
  const list = json.jobPostings || json.searchResults || [];
  const origin = host ? `https://${host}` : '';
  return list.map(jp => {
    const path = jp.externalPath || jp.externalUrl || '';
    let jobUrl = '';
    if (path.startsWith('http')) jobUrl = path;
    else if (path && origin) jobUrl = `${origin}${path.startsWith('/') ? '' : '/'}${path}`;
    return {
      title: jp.title || '',
      url: jobUrl,
      company: companyName,
      location: jp.locationsText || jp.location || '',
      description: jp.bulletFields?.jobDescription || '',
      posted_at: jp.postedOn || jp.postedDate || '',
    };
  }).filter(j => j.title && j.url);
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWorkdayJobList(apiInfo) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(apiInfo.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Referer: apiInfo.referer || `https://${apiInfo.host}/`,
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: 100,
        offset: 0,
        searchText: '',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; career-ops-scanner/1.0)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithRetry(urls, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const url of urls) {
      try {
        return await fetchText(url);
      } catch (err) {
        lastError = err;
      }
    }
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError || new Error('Websearch fetch failed');
}

function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDuckDuckGoResults(html, companyName) {
  const jobs = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const url = match[1];
    const title = stripHtml(match[2]);
    if (!url || !title) continue;
    jobs.push({
      title,
      url,
      company: companyName,
      location: '',
    });
  }
  return jobs;
}

function parseBingResults(html, companyName) {
  const jobs = [];
  const re = /<li class="b_algo"[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const url = match[1];
    const title = stripHtml(match[2]);
    if (!url || !title) continue;
    jobs.push({
      title,
      url,
      company: companyName,
      location: '',
    });
  }
  return jobs;
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title, description = '') => {
    const lower = title.toLowerCase();
    const descLower = (description || '').toLowerCase();
    const hasPositiveTitle = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasPositiveDesc = positive.length === 0 || positive.some(k => descLower.includes(k));
    const hasPositive = hasPositiveTitle || hasPositiveDesc;
    const isAnalystRole = lower.includes('analyst');
    const isAllowedManagerRole =
      lower.includes('technical program manager')
      || lower.includes('program manager')
      || lower.includes('project manager')
      || lower.includes('tpm')
      || lower.includes('scrum master')
      || lower.includes('delivery manager');
    const hasNegative = negative.some(k => {
      if (k === 'senior' && isAnalystRole) return false;
      if (k === 'manager' && isAllowedManagerRole) return false;
      return lower.includes(k);
    });
    return hasPositive && !hasNegative;
  };
}

/** For websearch Bing snippets: keep volume by only applying negative keywords (drop obvious bad roles). */
function buildNegativeOnlyFilter(titleFilter) {
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const isAnalystRole = lower.includes('analyst');
    const isAllowedManagerRole =
      lower.includes('technical program manager')
      || lower.includes('program manager')
      || lower.includes('project manager')
      || lower.includes('tpm')
      || lower.includes('scrum master')
      || lower.includes('delivery manager');
    return !negative.some(k => {
      if (k === 'senior' && isAnalystRole) return false;
      if (k === 'manager' && isAllowedManagerRole) return false;
      return lower.includes(k);
    });
  };
}

function parsePostedAt(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    // Some APIs return epoch milliseconds.
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isOlderThanDays(postedAt, days) {
  const posted = parsePostedAt(postedAt);
  if (!posted || !Number.isFinite(days) || days <= 0) return false;
  const ageMs = Date.now() - posted.getTime();
  return ageMs > days * 24 * 60 * 60 * 1000;
}

function hasUsCitizenshipRequirement(job) {
  const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  if (!text) return false;

  const blockedPhrases = [
    'us citizenship required',
    'u.s. citizenship required',
    'must be a us citizen',
    'must be a u.s. citizen',
    'must be us citizen',
    'must be u.s. citizen',
    'requires us citizenship',
    'requires u.s. citizenship',
    'required to be a us citizen',
    'required to be a u.s. citizen',
    'only us citizens',
    'u.s. citizens only',
    'us citizens only',
    'citizenship is required',
    'active u.s. security clearance',
    'active us security clearance',
    'must be eligible for a security clearance',
  ];

  return blockedPhrases.some(phrase => text.includes(phrase));
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const websearchRelax = config.scan_settings?.websearch_relax_title_filter === true;
  const websearchTitleCheck = websearchRelax
    ? buildNegativeOnlyFilter(config.title_filter)
    : titleFilter;

  // 2. Split targets into API and websearch groups
  const enabledCompanies = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }));

  const apiTargets = enabledCompanies.filter(c => c._api !== null);
  const webTargets = enabledCompanies.filter(c => c._api === null && c.scan_method === 'websearch' && c.scan_query);
  const skippedCount = enabledCompanies.length - apiTargets.length - webTargets.length;

  console.log(
    `Scanning ${apiTargets.length} companies via API + ${webTargets.length} via websearch` +
    (skippedCount > 0 ? ` (${skippedCount} skipped — no API/query detected)` : ''),
  );
  if (dryRun) console.log('(dry run — no files will be written)\n');
  if (websearchRelax) {
    console.log('Websearch title filter: RELAXED (negative keywords only) — see scan_settings.websearch_relax_title_filter in portals.yml\n');
  }

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalAgeFiltered = 0;
  let totalCitizenshipExcluded = 0;
  const maxJobAgeDays = Number(config.scan_settings?.max_job_age_days || 0);

  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const apiTasks = apiTargets.map(company => async () => {
    const apiInfo = company._api;
    const { type, url } = apiInfo;
    try {
      const json = type === 'workday'
        ? await fetchWorkdayJobList(apiInfo)
        : await fetchJson(url);
      const jobs = type === 'smartrecruiters'
        ? parseSmartRecruiters(json, company.name)
        : type === 'workday'
          ? parseWorkday(json, company.name, apiInfo.host)
          : PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (isOlderThanDays(job.posted_at, maxJobAgeDays)) {
          totalAgeFiltered++;
          continue;
        }
        if (hasUsCitizenshipRequirement(job)) {
          totalCitizenshipExcluded++;
          continue;
        }
        if (!titleFilter(job.title, job.description)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  const webTasks = webTargets.map(company => async () => {
    try {
      const query = encodeURIComponent(company.scan_query);
      const urls = [
        `https://www.bing.com/search?q=${query}`,
        `https://duckduckgo.com/html/?q=${query}`,
        `https://html.duckduckgo.com/html/?q=${query}`,
      ];
      const html = await fetchTextWithRetry(urls, 3);
      const jobs = html.includes('b_algo')
        ? parseBingResults(html, company.name)
        : parseDuckDuckGoResults(html, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (isOlderThanDays(job.posted_at, maxJobAgeDays)) {
          totalAgeFiltered++;
          continue;
        }
        if (hasUsCitizenshipRequirement(job)) {
          totalCitizenshipExcluded++;
          continue;
        }
        if (!websearchTitleCheck(job.title)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: 'websearch' });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(apiTasks, CONCURRENCY);
  await parallelFetch(webTasks, WEBSEARCH_CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${apiTargets.length + webTargets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by age:       ${totalAgeFiltered} removed`);
  console.log(`Citizenship required:  ${totalCitizenshipExcluded} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
