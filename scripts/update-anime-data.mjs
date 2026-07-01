import { writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

const USERNAME = 'uwusu';
const API_ROOT = 'https://api.jikan.moe/v4';
const OUTPUT_FILE = new URL('../anime-data.json', import.meta.url);
const INPUT_FILE = OUTPUT_FILE;
const PAGE_SIZE = 100;
const MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getScore(item) {
  const score = item?.list_status?.score ?? item?.listStatus?.score ?? item?.score ?? 0;
  return Number(score) || 0;
}

function compareEntries(left, right) {
  const scoreDelta = getScore(right) - getScore(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const leftTitle = left?.node?.title ?? left?.title ?? '';
  const rightTitle = right?.node?.title ?? right?.title ?? '';
  return leftTitle.localeCompare(rightTitle);
}

function normalizeEntry(item) {
  const node = item?.node ?? item?.anime ?? item ?? {};
  const listStatus = item?.list_status ?? item?.listStatus ?? {};

  return {
    id: node?.mal_id ?? item?.mal_id ?? null,
    title: node?.title ?? item?.title ?? 'unknown title',
    score: Number(listStatus?.score ?? item?.score ?? 0) || 0,
    imageUrl: node?.images?.jpg?.image_url ?? item?.imageUrl ?? '',
    malUrl: node?.url ?? item?.malUrl ?? '',
    status: listStatus?.status ?? item?.status ?? 'completed',
    mediaType: node?.media_type ?? item?.mediaType ?? '',
  };
}

async function fetchJsonWithRetry(url, attemptCount = MAX_ATTEMPTS) {
  let lastError = null;

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'owusu-anime-data-sync/1.0',
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        return await response.json();
      }

      if (response.status === 404) {
        const notFoundError = new Error('User not found on Jikan (404)');
        notFoundError.code = 404;
        throw notFoundError;
      }

      if (!RETRYABLE_STATUS.has(response.status) || attempt === attemptCount) {
        const requestError = new Error(`Request failed with status ${response.status}`);
        requestError.code = response.status;
        throw requestError;
      }

      const retryAfter = Number(response.headers.get('Retry-After'));
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * attempt * attempt;
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt === attemptCount) {
        break;
      }
      await sleep(1000 * attempt);
    }
  }

  throw lastError ?? new Error('Unknown fetch error');
}

async function readExistingOutput() {
  try {
    const raw = await readFile(INPUT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch (_error) {
    // No existing cache available.
  }

  return {
    username: USERNAME,
    generatedAt: null,
    count: 0,
    entries: [],
  };
}

async function fetchAllAnime(username) {
  const collected = [];
  let page = 1;

  while (true) {
    const url = `${API_ROOT}/users/${encodeURIComponent(username)}/animelist?status=completed&order_by=list_score&sort=desc&limit=${PAGE_SIZE}&page=${page}`;
    const payload = await fetchJsonWithRetry(url);
    const data = Array.isArray(payload?.data) ? payload.data : [];

    collected.push(...data);

    if (!payload?.pagination?.has_next_page || data.length === 0) {
      break;
    }

    page += 1;
  }

  return collected;
}

async function main() {
  let entries = [];

  try {
    const rawEntries = await fetchAllAnime(USERNAME);
    entries = rawEntries.map(normalizeEntry).sort(compareEntries);
  } catch (error) {
    if (error && error.code === 404) {
      const fallback = await readExistingOutput();
      console.warn('Jikan returned 404 for @' + USERNAME + '; keeping existing cached anime data.');
      await writeFile(OUTPUT_FILE, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
      return;
    }

    throw error;
  }

  const output = {
    username: USERNAME,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };

  await writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${entries.length} anime entries to anime-data.json`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
