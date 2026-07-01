import { writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

const USERNAME = 'uwusu';
const MAL_LIST_URL = `https://myanimelist.net/animelist/${encodeURIComponent(USERNAME)}?status=2`;
const OUTPUT_FILE = new URL('../anime-data.json', import.meta.url);
const INPUT_FILE = OUTPUT_FILE;

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
  const imageUrl = item?.anime_image_path ? String(item.anime_image_path) : '';
  const malUrl = item?.anime_url ? String(item.anime_url) : '';

  return {
    id: item?.anime_id ?? null,
    title: item?.anime_title_eng || item?.anime_title || 'unknown title',
    score: Number(item?.score ?? 0) || 0,
    imageUrl,
    malUrl: malUrl.startsWith('/') ? `https://myanimelist.net${malUrl}` : malUrl,
    status: item?.status === 2 ? 'completed' : 'unknown',
    mediaType: item?.anime_media_type_string ?? '',
  };
}

function decodeHtmlEntities(text) {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function extractListItems(html) {
  const match = html.match(/<table[^>]*class="list-table"[^>]*data-items="([^"]+)"/);
  if (!match) {
    throw new Error('Could not find MAL list data-items payload');
  }

  const rawJson = decodeHtmlEntities(match[1]);
  const parsed = JSON.parse(rawJson);
  if (!Array.isArray(parsed)) {
    throw new Error('MAL list payload did not parse into an array');
  }

  return parsed;
}

async function fetchMalListPage(url) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'owusu-anime-data-sync/1.0',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });

      if (response.ok) {
        return await response.text();
      }

      const requestError = new Error(`Request failed with status ${response.status}`);
      requestError.code = response.status;
      throw requestError;
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
}

async function main() {
  let entries = [];

  try {
    const html = await fetchMalListPage(MAL_LIST_URL);
    const rawEntries = extractListItems(html);
    entries = rawEntries.map(normalizeEntry).sort(compareEntries);
  } catch (error) {
    const fallback = await readExistingOutput();
    console.warn('Could not refresh MAL list for @' + USERNAME + ': ' + error.message + '. Keeping existing cached anime data.');
    await writeFile(OUTPUT_FILE, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
    return;
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
