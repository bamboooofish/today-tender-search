'use strict';

(() => {
  // Set this to the deployed Apps Script Web App URL ending in /exec.
  const APPS_SCRIPT_URL =
    'https://script.google.com/macros/s/AKfycbz7lV7tuMMZNmATiEnY5RCfD3Tl6z0ePGUWmkNZTSQhqvoYSlk2EzM1hFaFJ6crPaHV/exec';
  const MAX_SELECTIONS = 5;
  const ALLOWED_ANNOUNCEMENT_TYPES = new Set([
    '公開招標公告',
    '經公開評選或公開徵求之限制性招標公告',
    '選擇性招標(建立合格廠商名單)公告',
    '選擇性招標(個案)公告',
    '選擇性招標後續邀標公告',
    '公開取得報價單或企劃書公告',
    '公開招標更正公告',
    '經公開評選或公開徵求之限制性招標更正公告',
    '選擇性招標(建立合格廠商名單)更正公告',
    '選擇性招標(個案)更正公告',
    '選擇性招標後續邀標更正公告',
    '公開取得報價單或企劃書更正公告',
  ]);
  const FILTER_STORAGE = {
    titleInclude: 'tender_title_includes',
    agencyInclude: 'tender_agency_includes',
    titleExclude: 'tender_title_excludes',
    agencyExclude: 'tender_agency_excludes',
  };
  const state = {
    date: '',
    items: [],
    filters: {
      titleInclude: [],
      agencyInclude: [],
      titleExclude: [],
      agencyExclude: [],
    },
    filtersActive: false,
    selected: new Map(),
    detailTexts: [],
    detailsLoading: false,
    loadError: '',
  };
  const byId = (id) => document.getElementById(id);

  function todayInTaipei() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const values = {};
    parts.forEach((part) => {
      values[part.type] = part.value;
    });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function normalize(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .trim();
  }

  function splitTerms(value) {
    return normalize(value)
      .split(/[,\uFF0C\u3001;\uFF1B\n\r]+/)
      .map((term) => term.trim().toLocaleLowerCase())
      .filter(Boolean);
  }

  function itemKey(item) {
    return [
      item.agency,
      item.id,
      item.title,
      item.type,
      item.unit_id,
      item.filename,
    ]
      .map(normalize)
      .join('|');
  }

  function validOfficialUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url, 'https://web.pcc.gov.tw');
      if (parsed.protocol === 'https:' && parsed.hostname === 'web.pcc.gov.tw')
        return parsed.href;
    } catch (_) {}
    return '';
  }

  function officialUrl(item) {
    const existingUrl = validOfficialUrl(item.url);
    if (existingUrl) return existingUrl;
    return (
      'https://web.pcc.gov.tw/prkms/tender/common/basic/readTenderBasic?tenderId=' +
      encodeURIComponent(item.id || '') +
      '&dateType=isNow'
    );
  }

  function readFilters() {
    Object.keys(FILTER_STORAGE).forEach((id) => {
      try {
        byId(id).value = localStorage.getItem(FILTER_STORAGE[id]) || '';
      } catch (_) {}
      byId(id).addEventListener('input', () => {
        try {
          localStorage.setItem(FILTER_STORAGE[id], byId(id).value);
        } catch (_) {}
      });
    });
  }

  function setDataset(payload) {
    state.selected.clear();
    state.detailTexts = [];
    state.date = payload.date || '';
    state.loadError = payload.message || '';
    state.items = Array.isArray(payload.items)
      ? payload.items.filter((item) => item && item.id && item.title)
      : [];
    state.filtersActive = false;
    state.filters = {
      titleInclude: [],
      agencyInclude: [],
      titleExclude: [],
      agencyExclude: [],
    };
    byId('detailResults').replaceChildren();
    byId('copyDetails').disabled = true;
    byId('detailsStatus').textContent =
      '請選擇欲查詢的標案後，按「查詢詳細資訊」';
    byId('fetchDetails').disabled = true;
    render();
  }

  async function loadToday() {
    const expectedDate = todayInTaipei();
    try {
      const payload = await requestApi('listbydate', {
        date: expectedDate.replace(/-/g, ''),
      });
      const items = getApiRecords(payload)
        .map((record) => apiRecordToItem(record, expectedDate))
        .filter(
          (item) =>
            item.id && item.title && ALLOWED_ANNOUNCEMENT_TYPES.has(item.type),
        );

      if (!items.length) {
        setDataset({
          date: expectedDate,
          items: [],
          message: '今日沒有符合原有公告類型的標案資料。',
        });
        return;
      }
      setDataset({ date: expectedDate, items: items, status: 'success' });
    } catch (error) {
      setDataset({
        date: expectedDate,
        items: [],
        message: '清單載入失敗，或非上班日無標案資訊。',
      });
    }
  }

  function matchesAny(text, terms) {
    if (!terms.length) return true;
    const value = normalize(text).toLocaleLowerCase();
    return terms.some((term) => value.includes(term));
  }

  function isVisible(item) {
    if (!state.filtersActive) return true;
    const title = normalize(item.title).toLocaleLowerCase();
    const agency = normalize(item.agency).toLocaleLowerCase();
    return (
      matchesAny(title, state.filters.titleInclude) &&
      matchesAny(agency, state.filters.agencyInclude) &&
      !state.filters.titleExclude.some((term) => title.includes(term)) &&
      !state.filters.agencyExclude.some((term) => agency.includes(term))
    );
  }

  function makeCell(text, className) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = normalize(text) || '—';
    return cell;
  }

  function toggleSelection(item) {
    if (state.detailsLoading) return;
    const key = itemKey(item);
    if (state.selected.has(key)) {
      state.selected.delete(key);
    } else if (state.selected.size < MAX_SELECTIONS) {
      state.selected.set(key, item);
    }
    render();
  }

  function render() {
    const rows = state.items.filter(isVisible);
    const body = byId('tenderRows');
    const fragment = document.createDocumentFragment();
    body.replaceChildren();
    byId('visibleCount').textContent =
      '顯示 ' +
      rows.length.toLocaleString() +
      ' / ' +
      state.items.length.toLocaleString() +
      ' 件，已選取 ' +
      state.selected.size +
      ' / ' +
      MAX_SELECTIONS +
      ' 件';
    byId('fetchDetails').disabled =
      state.selected.size === 0 || state.detailsLoading;
    byId('downloadExcel').disabled = rows.length === 0;
    byId('emptyList').hidden = rows.length > 0;

    if (!rows.length) {
      byId('emptyList').textContent = state.items.length
        ? '沒有符合目前篩選條件的標案'
        : state.loadError || '目前沒有可顯示的今日標案';
    }

    rows.forEach((item) => {
      const row = document.createElement('tr');
      const key = itemKey(item);
      if (state.selected.has(key)) row.classList.add('is-selected');
      row.addEventListener('click', () => toggleSelection(item));

      const selectCell = document.createElement('td');
      selectCell.className = 'select-column';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'tender-checkbox';
      checkbox.setAttribute('aria-label', '選取 ' + normalize(item.title));
      checkbox.checked = state.selected.has(key);
      checkbox.disabled =
        !checkbox.checked && state.selected.size >= MAX_SELECTIONS;
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', () => toggleSelection(item));
      selectCell.append(checkbox);
      row.append(selectCell);

      row.append(makeCell(item.type), makeCell(item.agency));

      const titleCell = document.createElement('td');
      const titleLink = document.createElement('a');
      titleLink.href = officialUrl(item);
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
      titleLink.textContent = normalize(item.title) || '查看公告';
      const caseNumber = normalize(item.id);
      if (caseNumber) {
        titleLink.title = '案號：' + caseNumber;
        titleLink.setAttribute(
          'aria-label',
          normalize(item.title) + '，案號：' + caseNumber,
        );
      }
      titleLink.addEventListener('click', (event) => event.stopPropagation());
      titleCell.append(titleLink);
      row.append(titleCell);
      fragment.append(row);
    });
    body.append(fragment);
  }

  function applyFilters() {
    if (state.detailsLoading) return;
    state.filters = {
      titleInclude: splitTerms(byId('titleInclude').value),
      agencyInclude: splitTerms(byId('agencyInclude').value),
      titleExclude: splitTerms(byId('titleExclude').value),
      agencyExclude: splitTerms(byId('agencyExclude').value),
    };
    state.filtersActive = Object.values(state.filters).some(
      (terms) => terms.length > 0,
    );
    state.selected.clear();
    byId('detailResults').replaceChildren();
    state.detailTexts = [];
    byId('copyDetails').disabled = true;
    byId('detailsStatus').textContent =
      '請選擇欲查詢的標案後，按「查詢詳細資訊」';
    render();
  }

  function resetFilters() {
    if (state.detailsLoading) return;
    Object.keys(FILTER_STORAGE).forEach((id) => {
      byId(id).value = '';
      try {
        localStorage.removeItem(FILTER_STORAGE[id]);
      } catch (_) {}
    });
    state.filters = {
      titleInclude: [],
      agencyInclude: [],
      titleExclude: [],
      agencyExclude: [],
    };
    state.filtersActive = false;
    state.selected.clear();
    state.detailTexts = [];
    byId('detailResults').replaceChildren();
    byId('copyDetails').disabled = true;
    byId('detailsStatus').textContent =
      '請選擇欲查詢的標案後，按「查詢詳細資訊」';
    render();
  }

  function requestApi(action, params) {
    return new Promise((resolve, reject) => {
      if (
        !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(
          APPS_SCRIPT_URL,
        )
      ) {
        reject(new Error('尚未設定部署網址。'));
        return;
      }

      const callbackName =
        '__tenderApi_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const endpoint = new URL(APPS_SCRIPT_URL);
      endpoint.searchParams.set('action', action);
      Object.keys(params || {}).forEach((key) => {
        endpoint.searchParams.set(key, String(params[key]));
      });
      endpoint.searchParams.set('callback', callbackName);

      let settled = false;
      let timeoutId;
      function cleanup() {
        if (timeoutId) window.clearTimeout(timeoutId);
        delete window[callbackName];
        script.remove();
      }
      function fail(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }

      window[callbackName] = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (payload && payload.error) {
          reject(new Error(payload.error));
          return;
        }
        resolve(payload);
      };
      script.onerror = () =>
        fail(new Error('無法連線到，請確認部署網址和存取權限。'));
      timeoutId = window.setTimeout(
        () => fail(new Error('回應逾時，請稍後再試。')),
        30000,
      );
      script.src = endpoint.toString();
      document.head.append(script);
    });
  }

  function getApiTitle(record) {
    if (record.brief && typeof record.brief === 'object')
      return normalize(record.brief.title);
    return normalize(record.title || '');
  }

  function getApiType(record) {
    if (record.brief && typeof record.brief === 'object')
      return normalize(record.brief.type);
    return normalize(record.type || '');
  }

  function getApiRecords(payload) {
    if (Array.isArray(payload)) return payload;
    return Array.isArray(payload.records) ? payload.records : [];
  }

  function apiRecordToItem(record, date) {
    const brief =
      record.brief && typeof record.brief === 'object' ? record.brief : {};
    return {
      agency: normalize(
        record.unit_name || record.dept_name || brief.unit_name,
      ),
      title: normalize(brief.title || record.title),
      id: normalize(record.job_number || record.tender_id),
      type: normalize(brief.type || record.type),
      date: normalize(record.date) || date,
      unit_id: normalize(record.unit_id),
      filename: normalize(record.filename),
      url: normalize(record.unit_url || record.pcc_url || record.url),
    };
  }

  function comparableText(value) {
    return normalize(value)
      .replace(/[\s\u3000]+/g, '')
      .toLocaleLowerCase();
  }

  function agencyMatches(apiAgency, sourceAgency) {
    const apiName = comparableText(apiAgency);
    const sourceName = comparableText(sourceAgency);
    return Boolean(
      apiName &&
      sourceName &&
      (apiName === sourceName ||
        apiName.includes(sourceName) ||
        sourceName.includes(apiName)),
    );
  }

  function matchApiRecord(item, records) {
    const itemNumber = normalize(item.id);
    const itemTitle = comparableText(item.title);
    const itemType = comparableText(item.type);
    const itemFilename = normalize(item.filename);
    if (itemFilename) {
      const itemUnitId = normalize(item.unit_id);
      const filenameMatches = records.filter(
        (record) =>
          normalize(record.filename) === itemFilename &&
          (!itemUnitId || normalize(record.unit_id) === itemUnitId),
      );
      if (filenameMatches.length === 1) return filenameMatches[0];
    }
    const candidates = records
      .map((record) => {
        const apiNumber = normalize(record.job_number);
        const apiTitle = comparableText(getApiTitle(record));
        const apiAgency = normalize(record.unit_name);
        const sameNumber = Boolean(
          itemNumber && apiNumber && apiNumber === itemNumber,
        );
        const sameTitle = Boolean(
          itemTitle && apiTitle && apiTitle === itemTitle,
        );
        const sameAgency = agencyMatches(apiAgency, item.agency);

        // Reject an explicit case-number mismatch; title searches can return similar notices.
        if (apiNumber && itemNumber && !sameNumber) return { record, score: 0 };
        if (sameNumber && sameTitle && (!apiAgency || sameAgency))
          return { record, score: 5 };
        if (sameNumber && sameAgency) return { record, score: 4 };
        if (sameNumber && sameTitle) return { record, score: 3 };
        if (sameTitle && sameAgency) return { record, score: 4 };
        if (sameTitle && !apiAgency) return { record, score: 2 };
        return { record, score: 0 };
      })
      .filter((candidate) => candidate.score > 0);

    if (!candidates.length) return null;
    const bestScore = Math.max(
      ...candidates.map((candidate) => candidate.score),
    );
    let best = candidates
      .filter((candidate) => candidate.score === bestScore)
      .map((candidate) => candidate.record);
    // Use notice type only to break a tie among equally ranked matches.
    if (best.length > 1 && itemType) {
      const typedMatches = best.filter(
        (record) => comparableText(getApiType(record)) === itemType,
      );
      if (typedMatches.length) best = typedMatches;
    }
    const identities = new Set(
      best.map((record) =>
        [normalize(record.unit_id), normalize(record.job_number)].join('|'),
      ),
    );
    if (identities.size !== 1) return null;
    return best.sort((left, right) =>
      normalize(right.date).localeCompare(normalize(left.date)),
    )[0];
  }

  async function findApiRecord(item, dailyRecords) {
    const dailyMatch = matchApiRecord(item, dailyRecords);
    if (dailyMatch) return dailyMatch;

    // The current tender page can include still-open notices published before today.
    // Search by title when today's publication index does not contain the selected notice.
    const searchPayload = await requestApi('searchbytitle', {
      query: item.title,
      page: '1',
    });
    return matchApiRecord(item, getApiRecords(searchPayload));
  }

  function chooseAnnouncement(payload, apiIndexRecord, date) {
    const records = getApiRecords(payload);
    if (!records.length) {
      if (payload && payload.detail) return payload;
      throw new Error('沒有回傳公告內容。');
    }
    const filename = normalize(apiIndexRecord.filename);
    if (filename) {
      const filenameMatches = records.filter(
        (record) => normalize(record.filename) === filename,
      );
      if (filenameMatches.length) return filenameMatches[0];
    }

    const sourceDate = normalize(apiIndexRecord.date) || normalize(date);
    const dateKey = sourceDate.replace(/-/g, '');
    let candidates = records.filter((record) => {
      const recordDate = normalize(record.date).replace(/-/g, '');
      return !recordDate || recordDate === dateKey;
    });
    if (!candidates.length) {
      throw new Error('沒有回傳相符日期的公告版本。');
    }
    const expectedType = comparableText(getApiType(apiIndexRecord));
    // The type is a fallback disambiguator; keep the single date match even if labels differ.
    if (candidates.length > 1 && expectedType) {
      const typedMatches = candidates.filter(
        (record) => comparableText(getApiType(record)) === expectedType,
      );
      if (typedMatches.length) candidates = typedMatches;
    }
    return candidates[0];
  }

  function flatten(value, path, result) {
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        flatten(
          entry,
          path ? path + ':' + (index + 1) : String(index + 1),
          result,
        ),
      );
      return;
    }
    if (typeof value === 'object') {
      Object.keys(value).forEach((key) =>
        flatten(value[key], path ? path + ':' + key : key, result),
      );
      return;
    }
    result.push([path, normalize(value)]);
  }

  function pickField(entries, labels) {
    for (const label of labels) {
      const match = entries.find(
        (entry) => entry[0] === label || entry[0].endsWith(':' + label),
      );
      if (match && match[1]) return match[1];
    }
    for (const label of labels) {
      const match = entries.find(
        (entry) => entry[0].includes(label) && entry[1],
      );
      if (match) return match[1];
    }
    return '';
  }

  function announcementFields(announcement, apiRecord, item) {
    const detail = announcement.detail || announcement;
    const entries = [];
    flatten(detail, '', entries);
    const briefTitle = getApiTitle(apiRecord);
    return {
      agency:
        pickField(entries, ['機關名稱']) ||
        normalize(apiRecord.unit_name) ||
        normalize(item.agency),
      unit: pickField(entries, ['單位名稱', '單位']) || '未提供',
      title:
        pickField(entries, ['標案名稱']) || briefTitle || normalize(item.title),
      number: normalize(apiRecord.job_number) || normalize(item.id),
      budget: pickField(entries, ['預算金額', '預算金額是否公開']) || '未提供',
      deadline:
        pickField(entries, ['截止投標', '投標截止日期', '截止日期']) ||
        normalize(item.deadline) ||
        '未提供',
      method: pickField(entries, ['招標方式']) || '未提供',
      awardMethod: pickField(entries, ['決標方式']) || '未提供',
      url: validOfficialUrl(detail.url) || officialUrl(item),
    };
  }

  function formatDetails(fields) {
    return [
      fields.unit,
      fields.title,
      fields.budget,
      fields.deadline,
      fields.method,
      fields.awardMethod,
    ]
      .filter((value) => value && value !== '未提供')
      .join('\n');
  }

  function createDetailCard(item, index) {
    const card = document.createElement('article');
    card.className = 'detail-card';
    const heading = document.createElement('h3');
    heading.textContent =
      index + 1 + '. ' + normalize(item.agency) + '｜' + normalize(item.id);
    const status = document.createElement('p');
    status.className = 'muted detail-status';
    status.textContent = '等待查詢…';
    const pre = document.createElement('pre');
    const urlLink = document.createElement('a');
    urlLink.className = 'detail-url';
    urlLink.target = '_blank';
    urlLink.rel = 'noopener noreferrer';
    urlLink.hidden = true;
    card.append(heading, status, pre, urlLink);
    byId('detailResults').append(card);
    return { heading, status, pre, urlLink };
  }

  async function loadDetailsFor(item, apiRecord) {
    if (!apiRecord.unit_id) throw new Error('沒有此案的機關代碼。');
    const payload = await requestApi('tender', {
      unit_id: apiRecord.unit_id,
      job_number: apiRecord.job_number || item.id,
    });
    const announcement = chooseAnnouncement(payload, apiRecord, state.date);
    return announcementFields(announcement, apiRecord, item);
  }

  async function queryDetails() {
    const items = Array.from(state.selected.values());
    if (!items.length) return;
    state.detailsLoading = true;
    render();
    state.detailTexts = new Array(items.length);
    byId('detailResults').replaceChildren();
    byId('copyDetails').disabled = true;
    byId('fetchDetails').disabled = true;
    byId('detailsStatus').textContent = '正在查詢 ' + items.length + ' 件標案…';
    byId('detailsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const cards = items.map(createDetailCard);

    try {
      const dateKey = state.date.replace(/-/g, '');
      const dailyPayload = await requestApi('listbydate', { date: dateKey });
      const apiRecords = getApiRecords(dailyPayload);
      if (!apiRecords.length) throw new Error('無今日的標案索引資料。');

      let cursor = 0;
      let completed = 0;
      async function worker() {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          const item = items[index];
          const card = cards[index];
          try {
            const apiRecord = await findApiRecord(item, apiRecords);
            if (!apiRecord)
              throw new Error(
                '找不到相符的標案資料，請核對案號、機關及標案名稱。',
              );
            const fields = await loadDetailsFor(item, apiRecord);
            const text = formatDetails(fields);
            state.detailTexts[index] = [
              card.heading.textContent,
              text,
              fields.url,
            ]
              .filter(Boolean)
              .join('\n');
            card.status.hidden = true;
            card.pre.textContent = text;
            card.urlLink.href = fields.url;
            card.urlLink.textContent = fields.url;
            card.urlLink.hidden = !fields.url;
          } catch (error) {
            const message =
              error && error.name === 'AbortError'
                ? '查詢逾時，請稍後再試。'
                : '此標案詳細資料暫時無法載入，請稍後再試。';
            card.status.textContent = message;
            card.status.classList.add('status-error');
            card.pre.textContent =
              normalize(item.agency) +
              '｜' +
              normalize(item.title) +
              '\n標案案號：' +
              normalize(item.id);
          }
          completed += 1;
          byId('detailsStatus').textContent =
            '已完成 ' + completed + ' / ' + items.length + ' 件';
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(3, items.length) }, worker),
      );
    } catch (error) {
      const message =
        error && error.name === 'AbortError'
          ? '查詢逾時，請稍後再試。'
          : '標案詳細資料暫時無法載入，請稍後再試。';
      cards.forEach((card) => {
        card.status.textContent = message;
        card.status.classList.add('status-error');
      });
      byId('detailsStatus').textContent = message;
    } finally {
      state.detailTexts = state.detailTexts.filter(Boolean);
      state.detailsLoading = false;
      byId('copyDetails').disabled = state.detailTexts.length === 0;
      byId('fetchDetails').disabled = state.selected.size === 0;
      render();
    }
  }

  async function copyDetails() {
    if (!state.detailTexts.length) return;
    const text = state.detailTexts.join('\n\n');
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (_) {
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.append(input);
      input.select();
      try {
        copied = document.execCommand('copy');
      } catch (_) {}
      input.remove();
    }
    const button = byId('copyDetails');
    button.textContent = copied ? '已複製' : '複製失敗';
    window.setTimeout(() => {
      button.textContent = '複製結果';
    }, 1800);
  }

  function downloadExcel() {
    const rows = state.items.filter(isVisible);
    if (!rows.length) return;
    if (!window.XLSX) {
      window.alert('元件尚未載入，請重新整理後再試。');
      return;
    }

    const values = [
      ['公告類型', '機關名稱', '標案名稱', '標案案號', '網址'],
      ...rows.map((item) => [
        normalize(item.type),
        normalize(item.agency),
        normalize(item.title),
        normalize(item.id),
        officialUrl(item),
      ]),
    ];
    const worksheet = window.XLSX.utils.aoa_to_sheet(values);
    worksheet['!cols'] = [
      { wch: 32 },
      { wch: 30 },
      { wch: 60 },
      { wch: 20 },
      { wch: 60 },
    ];
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, '篩選標案');
    const date = (state.date || todayInTaipei()).replace(/-/g, '');
    window.XLSX.writeFile(workbook, '篩選標案_' + date + '.xlsx', {
      compression: true,
    });
  }

  function setupCollapsibleSections() {
    document.querySelectorAll('.collapse-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const expanded = button.getAttribute('aria-expanded') === 'true';
        const nextExpanded = !expanded;
        const content = byId(button.getAttribute('aria-controls'));
        const section = button.closest('[data-collapsible]');
        button.setAttribute('aria-expanded', String(nextExpanded));
        button.setAttribute(
          'aria-label',
          (nextExpanded ? '收合' : '展開') + button.dataset.label,
        );
        section.classList.toggle('is-collapsed', !nextExpanded);
        content.hidden = !nextExpanded;
      });
    });
  }

  byId('applyFilters').addEventListener('click', applyFilters);
  byId('resetFilters').addEventListener('click', resetFilters);
  byId('clearSelection').addEventListener('click', () => {
    if (state.detailsLoading) return;
    state.selected.clear();
    render();
  });
  byId('fetchDetails').addEventListener('click', queryDetails);
  byId('copyDetails').addEventListener('click', copyDetails);
  byId('downloadExcel').addEventListener('click', downloadExcel);

  setupCollapsibleSections();
  readFilters();
  loadToday();

  window.TenderApp = {
    loadCollected(payload) {
      const today = todayInTaipei();
      if (!payload || !Array.isArray(payload.items)) return;
      setDataset({
        date: payload.date || today,
        items: payload.items,
        status: 'success',
      });
      applyFilters();
    },
  };
})();
